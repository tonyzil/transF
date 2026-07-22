/**
 * Monerium webhook regression test.
 *
 * The receiver used to credit whatever address and amount the request body
 * stated, with no authentication — an unauthenticated mint for anyone who
 * could reach the port. It now reads only an order id from the body and
 * re-reads that order from Monerium, so a forged payload buys nothing.
 *
 * This runs the API in sandbox mode against a stub Monerium server (so no
 * credentials are needed) and asserts:
 *   1. a forged deposit for an arbitrary address/amount credits nothing
 *   2. an id Monerium doesn't know is refused
 *   3. a genuine order id credits exactly what MONERIUM says, not the body
 *   4. replaying it credits nothing further
 *   5. with MONERIUM_WEBHOOK_SECRET set, an unsigned/mis-signed body is 401
 *
 * Run: npm run webhook:test
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newDevice, registerDevice } from "./device.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_PORT = Number(process.env.TRANSF_API_PORT ?? 3000);
const RPC_URL = process.env.TRANSF_RPC_URL ?? "http://127.0.0.1:8545";
const RPC_PORT = new URL(RPC_URL).port || "8545";
const API = `http://127.0.0.1:${API_PORT}`;
const STUB_PORT = Number(process.env.TRANSF_STUB_PORT ?? 8547);
const SECRET = "test-webhook-secret";
const bin = (n: string) => path.join(ROOT, "node_modules/.bin", n);

let token = "";
const children: ChildProcess[] = [];

/* ---- stub Monerium: only what the adapter actually calls ---- */
const orders = new Map<string, any>();
const stub = createServer((req, res) => {
  const send = (code: number, body: any) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const url = req.url ?? "";
  if (url.startsWith("/auth/token")) return send(200, { access_token: "stub", expires_in: 3600 });
  if (url.startsWith("/auth/context")) return send(200, { userId: "stub-user" });
  if (url.startsWith("/profiles")) return send(200, { profiles: [{ id: "stub-profile" }] });
  if (url.startsWith("/addresses")) return send(200, {});
  if (url.startsWith("/ibans")) return send(200, { ibans: [] });
  const one = url.match(/^\/orders\/([^?]+)/);
  if (one) {
    const o = orders.get(decodeURIComponent(one[1]));
    return o ? send(200, o) : send(404, { error: "no such order" });
  }
  if (url.startsWith("/orders")) return send(200, { orders: [...orders.values()] });
  send(404, { error: "unhandled" });
});

async function api(pathname: string, body?: any, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { ...headers };
  if (body) h["content-type"] = "application/json";
  if (token) h.authorization = `Bearer ${token}`;
  const res = await fetch(API + pathname, {
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
    headers: h,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !("__raw" in h)) throw new Error(`${pathname}: ${data.error ?? res.statusText}`);
  return data;
}

async function post(pathname: string, body: any, headers: Record<string, string> = {}) {
  const res = await fetch(API + pathname, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

function bg(cmd: string, args: string[], env: Record<string, string>) {
  const c = spawn(cmd, args, { cwd: ROOT, stdio: "ignore", env: { ...process.env, ...env } });
  children.push(c);
  return c;
}

let pass = 0;
const t = async (label: string, fn: () => Promise<void>) => {
  await fn();
  pass++;
  console.log(`  ok  ${label}`);
};

// Fail fast if another stack holds our ports — otherwise the spawns fail
// silently (stdio: "ignore") and the test talks to a stale server, which
// looks like a product bug instead of a leaked process.
for (const [name, url] of [
  [`api :${API_PORT}`, `${API}/api/health`],
  [`chain :${RPC_PORT}`, RPC_URL],
  [`stub :${STUB_PORT}`, `http://127.0.0.1:${STUB_PORT}/orders`],
] as const) {
  const busy = await fetch(url, { signal: AbortSignal.timeout(1500) }).then(() => true).catch(() => false);
  if (busy) {
    console.error(`${name} is already in use — stop it (or a leftover test) and re-run.`);
    process.exit(1);
  }
}

try {
  await new Promise<void>((r) => stub.listen(STUB_PORT, r));

  console.log("1/3 chain + deploy…");
  bg(process.execPath, [bin("hardhat"), "node", "--port", RPC_PORT], {});
  for (const s = Date.now(); Date.now() - s < 30_000; ) {
    try {
      const r = await fetch(RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      });
      if (r.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  assert.equal(
    spawnSync(process.execPath, [bin("tsx"), "scripts/deploy.ts"], { cwd: ROOT, stdio: "inherit" }).status,
    0,
    "deploy failed",
  );

  console.log("2/3 API in sandbox mode against the stub…");
  rmSync(path.join(ROOT, "data/db.json"), { force: true });
  bg(process.execPath, [bin("tsx"), "services/api/src/server.ts"], {
    MONERIUM_CLIENT_ID: "stub",
    MONERIUM_CLIENT_SECRET: "stub",
    MONERIUM_BASE_URL: `http://127.0.0.1:${STUB_PORT}`,
    MONERIUM_POLL_MS: "3600000", // don't let the poller race the assertions
    MONERIUM_WEBHOOK_SECRET: "",
    MG_ANCHOR_DOMAIN: "",
  });
  for (const s = Date.now(); Date.now() - s < 30_000; ) {
    try { if ((await fetch(`${API}/api/health`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }

  const user = await api("/api/users", { name: "Webhook Target", country: "DE" });
  token = user.sessionToken;
  await registerDevice(api, user.id, newDevice());
  const balance = async () => (await api(`/api/users/${user.id}`)).balanceEur;
  assert.equal(await balance(), 0);

  console.log("3/3 asserting the receiver ignores the body…");

  await t("a forged deposit for an arbitrary amount credits nothing", async () => {
    const r = await post("/api/webhooks/monerium", {
      data: {
        id: "forged-1",
        kind: "issue",
        state: "processed",
        meta: { state: "processed" },
        address: user.address,
        amount: "1000000",
      },
    });
    assert.equal(r.data.handled, false, "forged order must not be handled");
    assert.equal(await balance(), 0, "forged webhook minted balance");
  });

  await t("an order id Monerium does not know is refused", async () => {
    const r = await post("/api/webhooks/monerium", { data: { id: "no-such-order" } });
    assert.equal(r.data.handled, false);
    assert.equal(await balance(), 0);
  });

  await t("a genuine order credits Monerium's amount, not the body's", async () => {
    orders.set("real-1", {
      id: "real-1",
      kind: "issue",
      state: "processed",
      meta: { state: "processed" },
      address: user.address,
      amount: "40",
      currency: "eur",
      chain: "sepolia",
    });
    // The body lies about the amount; the receiver must use Monerium's 40.
    const r = await post("/api/webhooks/monerium", {
      data: { id: "real-1", amount: "999999", address: user.address },
    });
    assert.equal(r.data.handled, true);
    assert.equal(await balance(), 40, "credited the body's amount instead of Monerium's");
  });

  await t("replaying the same order credits nothing further", async () => {
    const r = await post("/api/webhooks/monerium", { data: { id: "real-1" } });
    assert.equal(r.data.handled, false);
    assert.equal(await balance(), 40);
  });

  console.log("      restarting API with a webhook secret…");
  children.at(-1)!.kill();
  await new Promise((r) => setTimeout(r, 1200));
  bg(process.execPath, [bin("tsx"), "services/api/src/server.ts"], {
    MONERIUM_CLIENT_ID: "stub",
    MONERIUM_CLIENT_SECRET: "stub",
    MONERIUM_BASE_URL: `http://127.0.0.1:${STUB_PORT}`,
    MONERIUM_POLL_MS: "3600000",
    MONERIUM_WEBHOOK_SECRET: SECRET,
    MG_ANCHOR_DOMAIN: "",
  });
  for (const s = Date.now(); Date.now() - s < 30_000; ) {
    try { if ((await fetch(`${API}/api/health`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }

  orders.set("real-2", {
    id: "real-2",
    kind: "issue",
    state: "processed",
    meta: { state: "processed" },
    address: user.address,
    amount: "10",
    currency: "eur",
    chain: "sepolia",
  });

  await t("an unsigned delivery is rejected when a secret is set", async () => {
    const r = await post("/api/webhooks/monerium", { data: { id: "real-2" } });
    assert.equal(r.status, 401);
    assert.equal(await balance(), 40);
  });

  await t("a wrongly-signed delivery is rejected", async () => {
    const body = { data: { id: "real-2" } };
    const bad = createHmac("sha256", "wrong-secret").update(JSON.stringify(body)).digest("hex");
    const r = await post("/api/webhooks/monerium", body, { "x-monerium-signature": bad });
    assert.equal(r.status, 401);
    assert.equal(await balance(), 40);
  });

  await t("a correctly-signed delivery is accepted", async () => {
    const body = { data: { id: "real-2" } };
    const sig = createHmac("sha256", SECRET).update(JSON.stringify(body)).digest("hex");
    const r = await post("/api/webhooks/monerium", body, { "x-monerium-signature": sig });
    assert.equal(r.status, 200);
    assert.equal(r.data.handled, true);
    assert.equal(await balance(), 50);
  });

  console.log(`\nWEBHOOK TEST PASSED — ${pass}/${pass}: body is untrusted, secret gate enforced`);
} finally {
  for (const c of children) c.kill();
  stub.close();
}
