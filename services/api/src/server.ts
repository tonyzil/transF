import express from "express";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { API_PORT, FX, moneriumSandboxEnabled } from "./config.js";
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

app.post(
  "/api/users",
  wrap(async (req, res) => {
    const { name, country } = req.body ?? {};
    if (!name || !country) return res.status(400).json({ error: "name and country required" });
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
    res.status(201).json(publicUser(user));
  }),
);

app.get(
  "/api/users/:id",
  wrap(async (req, res) => {
    let user = store.findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
    if (sandbox && user.funding?.status === "iban_pending") {
      user = await refreshPendingIban(user);
    }
    const balanceEur = await vaultBalance(user.address);
    res.json({ ...publicUser(user), balanceEur });
  }),
);

// --- Funding (mock Monerium SEPA webhook) -----------------------------------

app.post(
  "/api/simulate/sepa-deposit",
  wrap(async (req, res) => {
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
    if (!store.findUser(userId)) return res.status(404).json({ error: "user not found" });
    if (!["cash", "sepa", "upi"].includes(rail)) {
      return res.status(400).json({ error: "rail must be cash, sepa or upi" });
    }
    if (rail === "upi") {
      const inr = Number(receiveInr);
      if (!(inr > 0)) return res.status(400).json({ error: "receiveInr required for upi" });
      const quote = createQuote(userId, { rail, receiveInr: inr });
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
    const t = store.findTransfer(req.body?.transferId);
    if (!t) return res.status(404).json({ error: "transfer not found" });
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
