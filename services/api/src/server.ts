import express from "express";
import path from "node:path";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { API_HOST, API_PORT, FX, KYC, moneriumSandboxEnabled, SECURITY } from "./config.js";
import { issueChallenge, verifyAssertion, verifyRegistration } from "./webauthn.js";
import { initStore, store, type User } from "./store.js";
import { createQuote, isExpired } from "./fx.js";
import { issueIban, simulateSepaDeposit } from "./adapters/monerium.js";
import {
  checkConnection,
  handleWebhookEvent,
  provisionFunding,
  refreshPendingIban,
  startDepositPoller,
} from "./adapters/monerium-sandbox.js";
import {
  executeSepaTransfer,
  executeTransfer,
  executeUpiTransfer,
  refreshPayout,
  settlePickup,
  sweepStrandedTransfers,
} from "./orchestrator.js";
import { isValidVpa } from "./adapters/upi.js";
import { formatReport, reconcile } from "./reconcile.js";
import {
  addrs,
  destinationCommitment,
  eur,
  orchestratorAddress,
  paymentAuthorizationTypedData,
  publicClient,
  setVaultAuthorizer,
  transferIdHash,
  vaultAuthorizerOf,
  vaultBalance,
} from "./chain.js";
import { smartAccountFor } from "./wallet/candide.js";

const app = express();
// Keep the raw body around for webhook signature checks — HMAC has to run
// over the exact bytes sent, not a re-serialised object.
app.use(express.json({
  verify: (req, _res, buf) => {
    (req as any).rawBody = buf;
  },
}));

/** How long a device signature stays submittable (FP4). */
const AUTH_WINDOW_SEC = 15 * 60;

// ---------------------------------------------------------------------------
// FP1: origin policy + per-IP rate limiting (dependency-free)

// State-changing requests from foreign origins are refused outright; allowed
// origins get explicit CORS headers, everyone else gets none.
app.use((req, res, next) => {
  const origin = req.header("origin");
  if (origin && SECURITY.origins.includes(origin)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-headers", "content-type, authorization");
    res.setHeader("access-control-allow-methods", "GET, POST");
    if (req.method === "OPTIONS") return res.status(204).end();
  } else if (origin && req.method !== "GET" && req.method !== "OPTIONS") {
    return res.status(403).json({ error: "origin not allowed" });
  }
  next();
});

const hits = new Map<string, { n: number; reset: number }>();
function rateLimit(key: string, perMin: number): boolean {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || h.reset < now) {
    hits.set(key, { n: 1, reset: now + 60_000 });
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    return true;
  }
  return ++h.n <= perMin;
}
app.use("/api", (req, res, next) => {
  const ip = req.ip ?? "?";
  const authRoute = req.path.startsWith("/passkey") || (req.path === "/users" && req.method === "POST");
  const ok = authRoute
    ? rateLimit(`a:${ip}`, SECURITY.authRateLimitPerMin)
    : rateLimit(`g:${ip}`, SECURITY.rateLimitPerMin);
  if (!ok) return res.status(429).json({ error: "rate limited — slow down" });
  next();
});

const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), "../public");
app.use(express.static(pub));

const wrap =
  (fn: express.Handler): express.Handler =>
  (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

app.get(
  "/api/health",
  wrap(async (_req, res) => {
    const block = await publicClient.getBlockNumber();
    res.json({ ok: true, block: Number(block), contracts: addrs() });
  }),
);

// --- Users ------------------------------------------------------------------

const sandbox = moneriumSandboxEnabled();

/** Never send wallet keys to the client. */
const publicUser = ({ privateKey, ...u }: User & { [k: string]: any }) => u;
const withSession = (user: User) => ({ ...publicUser(user), sessionToken: issueSession(user.id) });

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function issueSession(userId: string) {
  const token = randomBytes(32).toString("base64url");
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + SECURITY.sessionTtlMs).toISOString();
  store.addSession({ id: randomUUID(), userId, tokenHash: tokenHash(token), createdAt: now, lastUsedAt: now, expiresAt });
  return token;
}

function bearerToken(req: express.Request): string | undefined {
  const h = req.header("authorization") ?? "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m?.[1];
}

function requireSession(req: express.Request, res: express.Response) {
  const token = bearerToken(req);
  if (!token) {
    res.status(401).json({ error: "authorization required" });
    return undefined;
  }
  const session = store.findSessionByTokenHash(tokenHash(token));
  if (!session) {
    res.status(401).json({ error: "invalid session" });
    return undefined;
  }
  if (session.revokedAt || Date.now() >= Date.parse(session.expiresAt)) {
    res.status(401).json({ error: "session expired" });
    return undefined;
  }
  store.touchSession(session.id);
  return session;
}

function requireUserSession(req: express.Request, res: express.Response, userId: string) {
  const session = requireSession(req, res);
  if (!session) return undefined;
  if (session.userId !== userId) {
    res.status(403).json({ error: "forbidden" });
    return undefined;
  }
  return session;
}

function requireKycApproved(user: User, res: express.Response) {
  if (user.kycStatus === "approved") return true;
  res.status(409).json({
    error: `KYC ${user.kycStatus}; account funding and transfers are disabled until KYC is approved`,
    kycStatus: user.kycStatus,
  });
  return false;
}

function fundableUserPatch(user: User): Partial<User> {
  if (sandbox) {
    return { funding: { mode: "sandbox", status: "provisioning" } };
  }
  return {
    iban: user.iban || issueIban(user.id),
    funding: { mode: "mock", status: "active" },
  };
}

function queueSandboxProvisioning(user: User) {
  provisionFunding(user).catch((err) =>
    console.error(`provisioning failed for ${user.id}: ${err?.message ?? err}`),
  );
}

app.post(
  "/api/users",
  wrap(async (req, res) => {
    const { name, country, email } = req.body ?? {};
    if (!name || !country) return res.status(400).json({ error: "name and country required" });
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: "invalid email" });
    }
    const id = randomUUID();
    // Candide Safe smart wallet: owner key + deterministic account address
    // (computed offline; deployed gaslessly during sandbox provisioning).
    const privateKey = generatePrivateKey();
    const ownerAddress = privateKeyToAccount(privateKey).address;
    const safeAddress = smartAccountFor(ownerAddress).accountAddress as `0x${string}`;
    const kycStatus = KYC.autoApprove ? "approved" : "pending";
    const user: User = {
      id,
      name,
      email,
      country,
      kycStatus,
      kyc: {
        provider: KYC.autoApprove ? "mock" : "manual",
        checkedAt: KYC.autoApprove ? new Date().toISOString() : undefined,
      },
      iban: kycStatus === "approved" && !sandbox ? issueIban(id) : "",
      address: safeAddress,
      ownerAddress,
      privateKey,
      wallet: { type: "candide-safe", deployed: false },
      funding:
        kycStatus === "approved"
          ? { mode: sandbox ? "sandbox" : "mock", status: sandbox ? "provisioning" : "active" }
          : { mode: sandbox ? "sandbox" : "mock", status: "kyc_pending" },
      createdAt: new Date().toISOString(),
    };
    store.addUser(user);
    if (sandbox && kycStatus === "approved") {
      // Wallet deploy (~20s) + Monerium provisioning run in the background;
      // the UI polls funding status until the IBAN lands.
      queueSandboxProvisioning(user);
    }
    res.status(201).json(withSession(user));
  }),
);

app.get(
  "/api/users/:id",
  wrap(async (req, res) => {
    let user = store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
    if (!requireUserSession(req, res, user.id)) return;
    if (sandbox && user.funding?.status === "iban_pending") {
      user = await refreshPendingIban(user);
    }
    const balanceEur = await vaultBalance(user.address);
    res.json({ ...publicUser(user), balanceEur });
  }),
);

app.get(
  "/api/users/:id/kyc",
  wrap(async (req, res) => {
    const user = store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
    if (!requireUserSession(req, res, user.id)) return;
    res.json({
      userId: user.id,
      country: user.country,
      kycStatus: user.kycStatus,
      kyc: user.kyc,
      funding: user.funding,
    });
  }),
);

app.post(
  "/api/users/:id/kyc/mock-review",
  wrap(async (req, res) => {
    if (!SECURITY.allowSimulation) {
      return res.status(403).json({ error: "mock KYC review is disabled in production" });
    }
    const user = store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
    if (!requireUserSession(req, res, user.id)) return;
    const decision = req.body?.decision;
    if (!["approved", "rejected", "manual_review"].includes(decision)) {
      return res.status(400).json({ error: "decision must be approved, rejected or manual_review" });
    }
    let updated = store.updateUser(user.id, {
      ...(decision === "approved" ? fundableUserPatch(user) : { funding: { ...user.funding!, status: "kyc_pending" as const } }),
      kycStatus: decision,
      kyc: {
        provider: "mock",
        checkedAt: new Date().toISOString(),
        reason: typeof req.body?.reason === "string" ? req.body.reason : undefined,
      },
    });
    if (sandbox && decision === "approved") {
      queueSandboxProvisioning(updated);
    }
    const balanceEur = await vaultBalance(updated.address).catch(() => 0);
    res.json({ ...publicUser(updated), balanceEur });
  }),
);

app.delete(
  "/api/session",
  wrap(async (req, res) => {
    const session = requireSession(req, res);
    if (!session) return;
    store.revokeSession(session.id);
    res.status(204).end();
  }),
);

// --- Passkeys (FP2: full WebAuthn verification) ------------------------------
// Registration parses and verifies the attestation (challenge, origin,
// rpIdHash) and stores the COSE public key + sign counter. Login verifies the
// assertion signature server-side before a session is issued.

app.post(
  "/api/webauthn/challenge",
  wrap(async (req, res) => {
    const purpose = req.body?.purpose === "register" ? "register" : "login";
    res.json({ challenge: issueChallenge(purpose), rpId: SECURITY.rpId });
  }),
);

app.post(
  "/api/users/:id/passkey",
  wrap(async (req, res) => {
    const user = store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
    if (!requireUserSession(req, res, user.id)) return;
    const { credentialId, attestation, clientDataJSON } = req.body ?? {};
    if (!credentialId || typeof credentialId !== "string" || !attestation || !clientDataJSON) {
      return res.status(400).json({ error: "credentialId, attestation and clientDataJSON required" });
    }
    if (store.findUserByCredential(credentialId)) {
      return res.status(409).json({ error: "credential already registered" });
    }
    let reg;
    try {
      reg = verifyRegistration(attestation, clientDataJSON, SECURITY.rpId, SECURITY.origins);
    } catch (err: any) {
      return res.status(400).json({ error: String(err?.message ?? err) });
    }
    if (reg.credentialId !== credentialId) {
      return res.status(400).json({ error: "credentialId does not match attestation" });
    }
    const updated = store.updateUser(user.id, {
      passkey: {
        credentialId,
        publicKey: reg.key,
        signCount: reg.signCount,
        rpId: SECURITY.rpId,
        attestation,
        createdAt: new Date().toISOString(),
      },
    });
    res.status(201).json(publicUser(updated));
  }),
);

app.post(
  "/api/passkey/login",
  wrap(async (req, res) => {
    const { credentialId, authenticatorData, clientDataJSON, signature } = req.body ?? {};
    if (!credentialId || !authenticatorData || !clientDataJSON || !signature) {
      return res.status(400).json({ error: "credentialId, authenticatorData, clientDataJSON and signature required" });
    }
    const user = store.findUserByCredential(credentialId);
    if (!user?.passkey?.publicKey) {
      return res.status(404).json({ error: "no verified passkey for this credential — register again" });
    }
    try {
      const { signCount } = await verifyAssertion(
        authenticatorData,
        clientDataJSON,
        signature,
        user.passkey.publicKey,
        user.passkey.signCount ?? 0,
        user.passkey.rpId ?? SECURITY.rpId,
        SECURITY.origins,
      );
      store.updateUser(user.id, { passkey: { ...user.passkey, signCount } });
    } catch (err: any) {
      return res.status(401).json({ error: String(err?.message ?? err) });
    }
    const balanceEur = await vaultBalance(user.address).catch(() => 0);
    res.json({ ...withSession(user), balanceEur });
  }),
);

// --- Funding (mock Monerium SEPA webhook) -----------------------------------

app.post(
  "/api/simulate/sepa-deposit",
  wrap(async (req, res) => {
    if (!SECURITY.allowSimulation) {
      return res.status(403).json({ error: "simulation endpoints are disabled in production" });
    }
    if (sandbox) {
      return res.status(400).json({
        error:
          "sandbox mode: make a (simulated) SEPA transfer to the IBAN from the Monerium sandbox portal — deposits are picked up automatically",
      });
    }
    const { iban, amountEur } = req.body ?? {};
    const amount = Number(amountEur);
    if (!iban || !(amount > 0)) return res.status(400).json({ error: "iban and amountEur required" });
    const user = store.findUserByIban(iban);
    if (!user) return res.status(404).json({ error: "no account with that IBAN" });
    if (!requireUserSession(req, res, user.id)) return;
    if (!requireKycApproved(user, res)) return;
    const ref = `sepa-${randomUUID()}`;
    const txs = await simulateSepaDeposit(user.address, amount, ref);
    const balanceEur = await vaultBalance(user.address);
    res.json({ credited: amount, balanceEur, paymentRef: ref, ...txs });
  }),
);

// --- Quotes & transfers ------------------------------------------------------

app.post(
  "/api/quotes",
  wrap(async (req, res) => {
    const { userId, sendEur, receiveInr, rail = "cash" } = req.body ?? {};
    const user = store.findUser(userId);
    if (!user) return res.status(404).json({ error: "user not found" });
    if (!requireUserSession(req, res, user.id)) return;
    if (!requireKycApproved(user, res)) return;
    if (!["cash", "sepa", "upi"].includes(rail)) {
      return res.status(400).json({ error: "rail must be cash, sepa or upi" });
    }
    if (rail === "upi") {
      const inr = Number(receiveInr);
      const eur = Number(sendEur);
      if (!(inr > 0) && !(eur > 0)) {
        return res.status(400).json({ error: "receiveInr or sendEur required for upi" });
      }
      const quote = createQuote(userId, {
        rail,
        receiveInr: inr > 0 ? inr : undefined,
        sendEur: eur > 0 ? eur : undefined,
      });
      if (quote.sendEur > FX.DAILY_CAP_EUR) {
        return res.status(400).json({ error: `amount exceeds daily cap of €${FX.DAILY_CAP_EUR}` });
      }
      return res.status(201).json(quote);
    }
    const amount = Number(sendEur);
    if (!(amount > FX.FIXED_FEE_EUR)) {
      return res.status(400).json({ error: `amount must exceed the €${FX.FIXED_FEE_EUR} fee` });
    }
    if (amount > FX.DAILY_CAP_EUR) {
      return res.status(400).json({ error: `amount exceeds daily cap of €${FX.DAILY_CAP_EUR}` });
    }
    res.status(201).json(createQuote(userId, { rail, sendEur: amount }));
  }),
);

app.post(
  "/api/transfers",
  wrap(async (req, res) => {
    const { quoteId, recipientName, recipientPhone, recipientIban, recipientVpa } = req.body ?? {};
    const quote = store.findQuote(quoteId);
    if (!quote) return res.status(404).json({ error: "quote not found" });
    if (!requireUserSession(req, res, quote.userId)) return;
    if ((quote.status ?? "OPEN") !== "OPEN") {
      return res.status(409).json({ error: `quote already ${quote.status.toLowerCase()}` });
    }
    if (isExpired(quote)) {
      store.updateQuote(quote.id, { status: "EXPIRED" });
      return res.status(410).json({ error: "quote expired, request a new one" });
    }
    if (quote.rail === "upi") {
      if (!recipientVpa || !isValidVpa(recipientVpa)) {
        return res.status(400).json({ error: "valid recipientVpa required (e.g. merchant@okicici)" });
      }
    } else if (!recipientName) {
      return res.status(400).json({ error: "recipientName required" });
    }
    if (quote.rail === "sepa" && !recipientIban) {
      return res.status(400).json({ error: "recipientIban required for bank payout" });
    }
    if (quote.rail === "cash" && !recipientPhone) {
      return res.status(400).json({ error: "recipientPhone required for cash pickup" });
    }
    const user = store.findUser(quote.userId)!;
    if (!requireKycApproved(user, res)) return;
    const balance = await vaultBalance(user.address);
    if (balance < quote.sendEur) {
      return res.status(400).json({ error: `insufficient balance (€${balance.toFixed(2)})` });
    }

    const transfer = {
      id: randomUUID(),
      userId: user.id,
      quoteId: quote.id,
      rail: quote.rail,
      recipientName: recipientName || (quote.rail === "upi" ? recipientVpa : ""),
      recipientPhone,
      recipientIban,
      recipientVpa,
      state: "CREATED" as const,
      sendEur: quote.sendEur,
      receiveKes: quote.receiveKes,
      receiveEur: quote.receiveEur,
      receiveInr: quote.receiveInr,
      txs: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    // FP4: the account must be bound to a device key before it can spend.
    const authorizer = await vaultAuthorizerOf(user.address);
    if (authorizer === "0x0000000000000000000000000000000000000000") {
      return res.status(409).json({
        error: "no device key registered for this account — POST /api/users/:id/authorizer first",
      });
    }
    if (!store.consumeQuote(quote.id)) {
      return res.status(409).json({ error: "quote already consumed" });
    }
    // Fix the exact terms the device is asked to sign. Nothing moves until a
    // matching signature comes back to /authorize. The destination commitment
    // binds the payout target into the signature (see destinationCommitment):
    // the device signs *who* is paid, not only how much.
    const amountWei = eur.toWei(transfer.sendEur);
    const deadline = Math.floor(Date.now() / 1000) + AUTH_WINDOW_SEC;
    const destination = destinationCommitment(transfer.rail, {
      phone: transfer.recipientPhone,
      iban: transfer.recipientIban,
      vpa: transfer.recipientVpa,
    });
    transfer.auth = { to: orchestratorAddress, amountWei: amountWei.toString(), destination, deadline };
    store.addTransfer(transfer);
    res.status(201).json({
      ...transfer,
      authorization: {
        authorizer,
        typedData: paymentAuthorizationTypedData({
          account: user.address,
          amountWei,
          to: orchestratorAddress,
          transferId: transferIdHash(transfer.id),
          destination,
          deadline,
        }),
        submitTo: `/api/transfers/${transfer.id}/authorize`,
      },
    });
  }),
);

app.get(
  "/api/transfers/:id",
  wrap(async (req, res) => {
    const t = store.findTransfer(req.params.id);
    if (!t) return res.status(404).json({ error: "transfer not found" });
    if (!requireUserSession(req, res, t.userId)) return;
    res.json(t);
  }),
);

app.post(
  "/api/transfers/:id/refresh-payout",
  wrap(async (req, res) => {
    const t = store.findTransfer(req.params.id);
    if (!t) return res.status(404).json({ error: "transfer not found" });
    if (!requireUserSession(req, res, t.userId)) return;
    res.json(await refreshPayout(t));
  }),
);

// Monerium webhook receiver (production path; polling covers local dev).
/**
 * FP4: register the device key that may authorize debits from this account.
 * The browser generates the key, keeps the private half, and sends only the
 * address. The vault accepts the first binding from the ramp role and refuses
 * every later one from anybody but the device itself — so this endpoint can
 * establish a binding, never steal one.
 */
app.post(
  "/api/users/:id/authorizer",
  wrap(async (req, res) => {
    const user = store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
    if (!requireUserSession(req, res, user.id)) return;
    if (!requireKycApproved(user, res)) return;
    const address = req.body?.address;
    if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      return res.status(400).json({ error: "address required (0x-prefixed, 20 bytes)" });
    }
    const onChain = await vaultAuthorizerOf(user.address);
    if (onChain !== "0x0000000000000000000000000000000000000000") {
      if (onChain.toLowerCase() !== address.toLowerCase()) {
        return res.status(409).json({
          error: "this account is already bound to a different device key — rotate it from that device",
          authorizerAddress: onChain,
        });
      }
      return res.json(publicUser(store.updateUser(user.id, { authorizerAddress: onChain })));
    }
    const hash = await setVaultAuthorizer(user.address, address as `0x${string}`);
    const updated = store.updateUser(user.id, { authorizerAddress: address as `0x${string}` });
    res.status(201).json({ ...publicUser(updated), txHash: hash });
  }),
);

/**
 * FP4: submit the device signature for a CREATED transfer and execute it.
 * The terms were fixed at creation, so the signature covers exactly what the
 * orchestrator submits — it cannot re-price or redirect the payment.
 */
app.post(
  "/api/transfers/:id/authorize",
  wrap(async (req, res) => {
    const transfer = store.findTransfer(req.params.id);
    if (!transfer) return res.status(404).json({ error: "transfer not found" });
    if (!requireUserSession(req, res, transfer.userId)) return;
    if (transfer.state !== "CREATED") {
      return res.status(409).json({ error: `transfer is ${transfer.state}, expected CREATED` });
    }
    if (!transfer.auth) return res.status(409).json({ error: "transfer has no authorization terms" });
    const signature = req.body?.signature;
    if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) {
      return res.status(400).json({ error: "signature required" });
    }
    if (Date.now() / 1000 > transfer.auth.deadline) {
      return res.status(410).json({ error: "authorization window expired, create a new transfer" });
    }
    const user = store.findUser(transfer.userId)!;
    if (!requireKycApproved(user, res)) return;
    store.updateTransfer(transfer.id, {
      auth: { ...transfer.auth, authorizedAt: new Date().toISOString() },
    });
    const auth = { deadline: transfer.auth.deadline, signature: signature as `0x${string}` };
    const result =
      transfer.rail === "sepa"
        ? await executeSepaTransfer(transfer, user, auth)
        : transfer.rail === "upi"
          ? await executeUpiTransfer(transfer, user, auth)
          : await executeTransfer(transfer, user, auth);
    res.status(result.state === "FAILED" ? 502 : 200).json(result);
  }),
);

/**
 * Verify the shared-secret HMAC on a Monerium webhook.
 *
 * Returns true when no secret is configured — the endpoint is still safe in
 * that case because handleWebhookEvent re-reads the order from Monerium and
 * ignores everything else in the body. Set MONERIUM_WEBHOOK_SECRET to also
 * keep strangers from making us do the lookup.
 *
 * Monerium signs `${webhook-id}.${webhook-timestamp}.${rawBody}` with the
 * base64-decoded `whsec_...` secret and sends `webhook-signature: v1,<base64>`.
 */
/**
 * The signed timestamp is what stops a captured delivery being replayed years
 * later. Delivery-id dedupe only rejects ids we have already seen, so it does
 * nothing for a capture we never received. Accepts both the ISO-8601 and the
 * unix-seconds forms, since we have not seen a real Monerium delivery yet.
 * MONERIUM_WEBHOOK_TOLERANCE_SEC=0 disables the check.
 */
export function withinReplayWindow(
  timestamp: string,
  toleranceSec = SECURITY.webhookToleranceSec,
  now = Date.now(),
): boolean {
  if (!toleranceSec) return true;
  const asNumber = Number(timestamp);
  const sentMs = Number.isFinite(asNumber) && timestamp.trim() !== ""
    ? asNumber * 1000
    : Date.parse(timestamp);
  if (!Number.isFinite(sentMs)) return false;
  return Math.abs(now - sentMs) <= toleranceSec * 1000;
}

function verifyWebhookSignature(req: express.Request): boolean {
  const secret = SECURITY.moneriumWebhookSecret;
  if (!secret) return true;
  const id = req.header("webhook-id") ?? "";
  const timestamp = req.header("webhook-timestamp") ?? "";
  const provided = req.header("webhook-signature") ?? "";
  const raw = (req as any).rawBody as Buffer | undefined;
  if (!id || !timestamp || !raw || !provided) return false;
  if (!withinReplayWindow(timestamp)) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const signed = Buffer.concat([Buffer.from(`${id}.${timestamp}.`), raw]);
  const expected = `v1,${createHmac("sha256", key).update(signed).digest("base64")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

app.post(
  "/api/webhooks/monerium",
  wrap(async (req, res) => {
    if (!sandbox) return res.status(400).json({ error: "monerium sandbox not configured" });
    if (!verifyWebhookSignature(req)) {
      return res.status(401).json({ error: "invalid webhook signature" });
    }
    const webhookId = req.header("webhook-id");
    if (webhookId && store.isWebhookProcessed(webhookId)) {
      return res.json({ handled: false, duplicate: true });
    }
    const result = await handleWebhookEvent(req.body);
    // Only spend the delivery id on a settled answer. `unavailable` means we
    // could not reach Monerium to check — marking it processed would make our
    // own outage look like a duplicate when Monerium retries the same id, and
    // the deposit would never arrive by this path. 503 asks for that retry.
    if (result.outcome === "unavailable") {
      return res.status(503).json({ ...result, retry: true });
    }
    if (webhookId) store.markWebhookProcessed(webhookId);
    res.json(result);
  }),
);

// Simulate the recipient collecting cash at a MoneyGram agent.
app.post(
  "/api/simulate/pickup",
  wrap(async (req, res) => {
    if (!SECURITY.allowSimulation) {
      return res.status(403).json({ error: "simulation endpoints are disabled in production" });
    }
    const t = store.findTransfer(req.body?.transferId);
    if (!t) return res.status(404).json({ error: "transfer not found" });
    if (!requireUserSession(req, res, t.userId)) return;
    res.json(await settlePickup(t));
  }),
);

app.use(((err, _req, res, _next) => {
  console.error(err);
  const detail = String(err?.shortMessage ?? err?.message ?? err);
  res.status(500).json({ error: SECURITY.exposeInternalErrors ? detail : "internal server error" });
}) as express.ErrorRequestHandler);

initStore();
// FP3: compensate anything stranded by a crash or failed payout, then keep
// sweeping in the background.
sweepStrandedTransfers()
  .then((n) => n && console.log(`FP3 sweep: compensated ${n} stranded transfer(s)`))
  .catch((e) => console.error(`FP3 sweep failed: ${e?.message ?? e}`));
setInterval(() => sweepStrandedTransfers().catch(() => {}), 5 * 60_000).unref();

// Reconciler: log-only, never repairs. Drift between Monerium's ledger and
// the local vault should be loud rather than discovered later by a user
// missing money. `npm run reconcile` runs the same check on demand.
const runReconcile = () =>
  reconcile()
    .then((r) => {
      if (!r.ok) console.warn(`LEDGER DRIFT\n${formatReport(r)}`);
    })
    .catch((e) => console.error(`reconcile failed: ${e?.message ?? e}`));
setTimeout(runReconcile, 10_000).unref();
setInterval(runReconcile, 15 * 60_000).unref();
if (sandbox) {
  checkConnection()
    .then((ctx) => {
      console.log(`monerium sandbox connected (${ctx?.email ?? ctx?.userId ?? "ok"})`);
      startDepositPoller();
    })
    .catch((err) => {
      console.error(`monerium sandbox auth FAILED — check .env credentials: ${err.message}`);
    });
} else {
  console.log("monerium: mock mode (set MONERIUM_CLIENT_ID/SECRET in .env for sandbox)");
}
app.listen(API_PORT, API_HOST, () => {
  console.log(`Zoll API listening on http://${API_HOST}:${API_PORT}`);
});
