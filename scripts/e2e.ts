/**
 * End-to-end test of the full corridor: chain up -> deploy -> API up ->
 * create user -> SEPA deposit -> quote -> transfer -> cash pickup.
 * Self-contained: starts and stops its own chain and API. Resets data/db.json
 * (demo data only — the chain state it mirrors dies with the chain anyway).
 * Run: npm run e2e
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_PORT = Number(process.env.TRANSF_API_PORT ?? 3000);
const RPC_URL = process.env.TRANSF_RPC_URL ?? "http://127.0.0.1:8545";
const RPC_PORT = new URL(RPC_URL).port || "8545";
const API = `http://127.0.0.1:${API_PORT}`;
const bin = (name: string) => path.join(ROOT, "node_modules/.bin", name);
let sessionToken = "";

const children: ChildProcess[] = [];
function spawnBg(cmd: string, args: string[]) {
  const child = spawn(cmd, args, {
    cwd: ROOT,
    stdio: "ignore",
    // Force mock mode even when .env holds sandbox credentials — the e2e
    // exercises the local corridor, not external sandboxes/anchors.
    env: {
      ...process.env,
      MONERIUM_CLIENT_ID: "",
      MONERIUM_CLIENT_SECRET: "",
      MG_ANCHOR_DOMAIN: "",
    },
  });
  children.push(child);
  return child;
}

async function waitFor(url: string, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timeout waiting for ${url}`);
}

async function waitForRpc(url: string, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      });
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timeout waiting for ${url}`);
}

async function api(pathname: string, body?: any) {
  const headers: Record<string, string> = {};
  if (body) headers["content-type"] = "application/json";
  if (sessionToken) headers.authorization = `Bearer ${sessionToken}`;
  const res = await fetch(API + pathname, {
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
    headers,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${pathname}: ${data.error ?? res.statusText}`);
  return data;
}

async function expectApiStatus(pathname: string, status: number, body?: any) {
  const headers: Record<string, string> = {};
  if (body) headers["content-type"] = "application/json";
  if (sessionToken) headers.authorization = `Bearer ${sessionToken}`;
  const res = await fetch(API + pathname, {
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
    headers,
  });
  assert.equal(res.status, status, `${pathname} should return ${status}`);
}

// Fail fast if another stack is already bound to our ports — otherwise the
// spawns fail silently and the test talks to the wrong server.
for (const [name, url] of [[`api :${API_PORT}`, `${API}/api/health`], [`chain :${RPC_PORT}`, RPC_URL]] as const) {
  const busy = await fetch(url, { signal: AbortSignal.timeout(1500) }).then(() => true).catch(() => false);
  if (busy) {
    console.error(`${name} is already in use (is 'npm run dev' running?) — stop it and re-run e2e.`);
    process.exit(1);
  }
}

try {
  console.log("1/7 starting local chain…");
  spawnBg(process.execPath, [bin("hardhat"), "node", "--port", RPC_PORT]);
  await waitForRpc(RPC_URL);

  console.log("2/7 deploying contracts…");
  const dep = spawnSync(process.execPath, [bin("tsx"), "scripts/deploy.ts"], { cwd: ROOT, stdio: "inherit" });
  assert.equal(dep.status, 0, "deploy failed");

  console.log("3/7 starting API…");
  rmSync(path.join(ROOT, "data/db.json"), { force: true });
  spawnBg(process.execPath, [bin("tsx"), "services/api/src/server.ts"]);
  await waitFor(`${API}/api/health`);

  console.log("4/7 creating user + SEPA deposit of €250…");
  const user = await api("/api/users", { name: "E2E Tester", country: "DE" });
  assert.ok(user.sessionToken, "account creation returns a session token");
  sessionToken = user.sessionToken;
  assert.match(user.iban, /^IS14/);
  const userSession = sessionToken;
  sessionToken = "";
  await expectApiStatus(`/api/users/${user.id}`, 401);
  await expectApiStatus("/api/quotes", 401, { userId: user.id, sendEur: 25 });
  const other = await api("/api/users", { name: "Other User", country: "DE" });
  sessionToken = other.sessionToken;
  await expectApiStatus(`/api/users/${user.id}`, 403);
  await expectApiStatus("/api/quotes", 403, { userId: user.id, sendEur: 25 });
  sessionToken = userSession;
  const depRes = await api("/api/simulate/sepa-deposit", { iban: user.iban, amountEur: 250 });
  assert.equal(depRes.balanceEur, 250);

  console.log("5/7 quoting €100 EUR->KES…");
  const quote = await api("/api/quotes", { userId: user.id, sendEur: 100 });
  assert.ok(quote.receiveKes > 0, "quote has a KES amount");
  // sanity: ~ (100 - 0.99) * 1.08 * 129.5 * (1 - 0.005)
  const expected = (100 - 0.99) * 1.08 * 129.5 * (1 - 0.005);
  assert.ok(Math.abs(quote.receiveKes - expected) < 1, `quote ${quote.receiveKes} ≈ ${expected}`);

  console.log("6/7 executing transfer…");
  const transfer = await api("/api/transfers", {
    quoteId: quote.id,
    recipientName: "Joseph Otieno",
    recipientPhone: "+254700000000",
  });
  assert.equal(transfer.state, "PAYOUT_READY", `transfer state: ${transfer.state} ${transfer.error ?? ""}`);
  assert.ok(transfer.pickup.referenceCode.length === 8, "pickup reference issued");
  assert.equal(transfer.txs.length, 5, "five on-chain txs");
  await expectApiStatus("/api/transfers", 409, {
    quoteId: quote.id,
    recipientName: "Replay Receiver",
    recipientPhone: "+254711111111",
  });
  const after = await api(`/api/users/${user.id}`);
  assert.equal(after.balanceEur, 150, "balance reduced by send amount");

  console.log(`      pickup code ${transfer.pickup.referenceCode}, recipient gets KES ${transfer.receiveKes}`);

  console.log("7/8 simulating cash pickup…");
  const done = await api("/api/simulate/pickup", { transferId: transfer.id });
  assert.equal(done.state, "PAID");
  assert.equal(done.txs.at(-1).step, "bridge.settle");

  console.log("8/9 SEPA bank payout of €40…");
  const sepaQuote = await api("/api/quotes", { userId: user.id, sendEur: 40, rail: "sepa" });
  assert.equal(sepaQuote.receiveEur, 40 - 0.99, "sepa quote: fee only, no FX");
  const sepaTransfer = await api("/api/transfers", {
    quoteId: sepaQuote.id,
    recipientName: "Elena Weber",
    recipientIban: "DE89 3704 0044 0532 0130 00",
  });
  assert.equal(sepaTransfer.state, "PAID", `sepa state: ${sepaTransfer.state} ${sepaTransfer.error ?? ""}`);
  assert.equal(sepaTransfer.sepa.mode, "mock");
  assert.equal(sepaTransfer.txs.length, 1, "sepa rail: single debit tx");
  const afterSepa = await api(`/api/users/${user.id}`);
  assert.equal(afterSepa.balanceEur, 110, "balance after cash + sepa transfers");

  console.log("9/9 UPI payment of ₹2000 (scan-and-pay)…");
  const upiQuote = await api("/api/quotes", { userId: user.id, rail: "upi", receiveInr: 2000 });
  // sendEur ≈ 2000 / (1.08 * 87.2 * 0.995) + 0.29
  const expectedEur = 2000 / (1.08 * 87.2 * (1 - 0.005)) + 0.29;
  assert.ok(Math.abs(upiQuote.sendEur - expectedEur) < 0.02, `upi quote ${upiQuote.sendEur} ≈ ${expectedEur}`);
  const upiTransfer = await api("/api/transfers", {
    quoteId: upiQuote.id,
    recipientVpa: "chaistand@okicici",
  });
  assert.equal(upiTransfer.state, "PAID", `upi state: ${upiTransfer.state} ${upiTransfer.error ?? ""}`);
  assert.match(upiTransfer.upi.utr, /^\d{12}$/, "12-digit UTR issued");
  assert.equal(upiTransfer.txs.length, 3, "upi rail: debit + approve + swap txs");
  const final = await api(`/api/users/${user.id}`);
  assert.equal(final.balanceEur, Math.round((110 - upiQuote.sendEur) * 100) / 100, "balance after upi payment");

  console.log("\nE2E PASSED — cash corridor + SEPA exit rail + UPI scan-and-pay");
} finally {
  for (const c of children) c.kill();
}
