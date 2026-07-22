import express from "express";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { API_PORT, FX, moneriumSandboxEnabled, SECURITY } from "./config.js";
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
import { executeSepaTransfer, executeTransfer, executeUpiTransfer, settlePickup } from "./orchestrator.js";
import { isValidVpa } from "./adapters/upi.js";
import { addrs, publicClient, vaultBalance } from "./chain.js";
import { smartAccountFor } from "./wallet/candide.js";

const app = express();
app.use(express.json());

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
  const now = new Date().toISOString();
  store.addSession({ id: randomUUID(), userId, tokenHash: tokenHash(token), createdAt: now, lastUsedAt: now });
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

app.post(
  "/api/users",
  wrap(async (req, res) => {
    const { name, country, email } = req.body ?? {};
    if (!name || !country) return res.status(400).json({ error: "name and country required" });
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: "invalid email" });
    }
    // Mock KYC: auto-approve. Real flow gates IBAN issuance on KYC pass.
    const id = randomUUID();
    // Candide Safe smart wallet: owner key + deterministic account address
    // (computed offline; deployed gaslessly during sandbox provisioning).
    const privateKey = generatePrivateKey();
    const ownerAddress = privateKeyToAccount(privateKey).address;
    const safeAddress = smartAccountFor(ownerAddress).accountAddress as `0x${string}`;
    const user: User = {
      id,
      name,
      email,
      country,
      kycStatus: "approved",
      iban: sandbox ? "" : issueIban(id),
      address: safeAddress,
      ownerAddress,
      privateKey,
      wallet: { type: "candide-safe", deployed: false },
      funding: { mode: sandbox ? "sandbox" : "mock", status: sandbox ? "provisioning" : "active" },
      createdAt: new Date().toISOString(),
    };
    store.addUser(user);
    if (sandbox) {
      // Wallet deploy (~20s) + Monerium provisioning run in the background;
      // the UI polls funding status until the IBAN lands.
      provisionFunding(user).catch((err) =>
        console.error(`provisioning failed for ${user.id}: ${err?.message ?? err}`),
      );
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
    if (isExpired(quote)) return res.status(410).json({ error: "quote expired, request a new one" });
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
    store.addTransfer(transfer);
    const result =
      quote.rail === "sepa"
        ? await executeSepaTransfer(transfer, user)
        : quote.rail === "upi"
          ? await executeUpiTransfer(transfer, user)
          : await executeTransfer(transfer, user);
    res.status(result.state === "FAILED" ? 502 : 201).json(result);
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

// Monerium webhook receiver (production path; polling covers local dev).
app.post(
  "/api/webhooks/monerium",
  wrap(async (req, res) => {
    if (!sandbox) return res.status(400).json({ error: "monerium sandbox not configured" });
    res.json(await handleWebhookEvent(req.body));
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
  res.status(500).json({ error: String(err?.shortMessage ?? err?.message ?? err) });
}) as express.ErrorRequestHandler);

initStore();
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
app.listen(API_PORT, () => {
  console.log(`transF API listening on http://127.0.0.1:${API_PORT}`);
});
