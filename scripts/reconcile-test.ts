/**
 * Ledger reconciler test.
 *
 * Drives the API in sandbox mode against a stub Monerium, then injects each
 * class of drift and asserts the reconciler names it. A reconciler that never
 * fires is indistinguishable from one that works, so every check here starts
 * from a clean bill of health and then breaks something specific.
 *
 * Run: npm run reconcile:test
 */
import assert from "node:assert/strict";
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
const bin = (n: string) => path.join(ROOT, "node_modules/.bin", n);

let token = "";
const children: ChildProcess[] = [];
const orders = new Map<string, any>();

const stub = createServer((req, res) => {
  const send = (code: number, body: any) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const url = req.url ?? "";
  if (url.startsWith("/auth/token")) return send(200, { access_token: "stub", expires_in: 3600 });
  if (url.startsWith("/auth/context")) return send(200, { userId: "stub" });
  if (url.startsWith("/profiles")) return send(200, { profiles: [{ id: "p" }] });
  if (url.startsWith("/addresses")) return send(200, {});
  if (url.startsWith("/ibans")) return send(200, { ibans: [] });
  const one = url.match(/^\/orders\/([^?]+)/);
  if (one) {
    const o = orders.get(decodeURIComponent(one[1]));
    return o ? send(200, o) : send(404, { error: "no such order" });
  }
  if (url.startsWith("/orders")) return send(200, { orders: [...orders.values()] });
  send(404, {});
});

async function api(pathname: string, body?: any) {
  const h: Record<string, string> = {};
  if (body) h["content-type"] = "application/json";
  if (token) h.authorization = `Bearer ${token}`;
  const res = await fetch(API + pathname, {
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
    headers: h,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${pathname}: ${(data as any).error ?? res.statusText}`);
  return data as any;
}

function bg(cmd: string, args: string[], env: Record<string, string> = {}) {
  const c = spawn(cmd, args, { cwd: ROOT, stdio: "ignore", env: { ...process.env, ...env } });
  children.push(c);
  return c;
}

const issueOrder = (id: string, address: string, amount: string) => ({
  id, kind: "issue", state: "processed", meta: { state: "processed" },
  address, amount, currency: "eur", chain: "sepolia",
});

/**
 * Run the reconciler in-process against the same chain + db the API uses.
 * Bound lazily (and once) because config.ts reads the environment at import
 * time — the stub's MONERIUM_* must be in process.env first, and both modules
 * must share one store instance or the reconciler sees an empty ledger.
 */
let reconcileFn: (() => Promise<any>) | null = null;
async function runReconcile() {
  if (!reconcileFn) {
    const store = await import(`${ROOT}/services/api/src/store.js`);
    const mod = await import(`${ROOT}/services/api/src/reconcile.js`);
    reconcileFn = async () => {
      store.initStore(); // re-read db.json as the API last wrote it
      return mod.reconcile();
    };
  }
  return reconcileFn();
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
  bg(process.execPath, [bin("hardhat"), "node", "--port", RPC_PORT]);
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
    0, "deploy failed",
  );

  console.log("2/3 API in sandbox mode against the stub…");
  rmSync(path.join(ROOT, "data/db.json"), { force: true });
  const apiEnv = {
    MONERIUM_CLIENT_ID: "stub",
    MONERIUM_CLIENT_SECRET: "stub",
    MONERIUM_BASE_URL: `http://127.0.0.1:${STUB_PORT}`,
    MONERIUM_POLL_MS: "3600000",
    MG_ANCHOR_DOMAIN: "",
  };
  bg(process.execPath, [bin("tsx"), "services/api/src/server.ts"], apiEnv);
  for (const s = Date.now(); Date.now() - s < 30_000; ) {
    try { if ((await fetch(`${API}/api/health`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  // The reconciler reads MONERIUM_* from the environment too.
  Object.assign(process.env, apiEnv);

  const user = await api("/api/users", { name: "Recon Target", country: "DE" });
  token = user.sessionToken;
  await registerDevice(api, user.id, newDevice());

  console.log("3/3 injecting drift…");

  await t("clean ledgers reconcile with no findings", async () => {
    const r = await runReconcile();
    assert.equal(r.ok, true, `unexpected findings: ${JSON.stringify(r.findings)}`);
  });

  await t("a mirrored deposit still reconciles", async () => {
    orders.set("ord-1", issueOrder("ord-1", user.address, "100"));
    await api("/api/webhooks/monerium", { data: { id: "ord-1" } });
    assert.equal((await api(`/api/users/${user.id}`)).balanceEur, 100);
    const r = await runReconcile();
    assert.equal(r.ok, true, `unexpected findings: ${JSON.stringify(r.findings)}`);
  });

  await t("a Monerium deposit we never credited is flagged UNMIRRORED", async () => {
    // Monerium settled it; we never got the webhook.
    orders.set("ord-2", issueOrder("ord-2", user.address, "75"));
    const r = await runReconcile();
    const f = r.findings.find((x: any) => x.kind === "UNMIRRORED");
    assert.ok(f, `expected UNMIRRORED, got ${JSON.stringify(r.findings)}`);
    assert.equal(f.orderId, "ord-2");
    assert.equal(f.amountEur, 75);
    orders.delete("ord-2"); // reset for the next check
  });

  await t("deposits for addresses we don't manage are ignored", async () => {
    orders.set("ord-3", issueOrder("ord-3", "0x00000000000000000000000000000000000000ff", "500"));
    const r = await runReconcile();
    assert.equal(r.ok, true, `foreign address should not be our drift: ${JSON.stringify(r.findings)}`);
    orders.delete("ord-3");
  });

  await t("credit for an order Monerium does not have is flagged PHANTOM", async () => {
    // Exactly the state a forged webhook would have left behind.
    orders.delete("ord-1");
    const r = await runReconcile();
    const f = r.findings.find((x: any) => x.kind === "PHANTOM");
    assert.ok(f, `expected PHANTOM, got ${JSON.stringify(r.findings)}`);
    assert.equal(f.orderId, "ord-1");
    orders.set("ord-1", issueOrder("ord-1", user.address, "100"));
  });

  await t("an under-backed vault is flagged CHAIN", async () => {
    // Burn EURe out from under the vault: the ledger still says 100 is owed.
    const { createWalletClient, http, parseUnits } = await import("viem");
    const { privateKeyToAccount } = await import("viem/accounts");
    const { hardhat } = await import("viem/chains");
    const { readFileSync } = await import("node:fs");
    const dep = createWalletClient({
      account: privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"),
      chain: hardhat,
      transport: http(RPC_URL),
    });
    const { eure, vault } = JSON.parse(readFileSync(path.join(ROOT, "deployments.json"), "utf8"));
    await dep.writeContract({
      address: eure,
      abi: [{ type: "function", name: "burn", stateMutability: "nonpayable",
              inputs: [{ name: "from", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] }],
      functionName: "burn",
      args: [vault, parseUnits("60", 18)],
    });
    await new Promise((r) => setTimeout(r, 800));
    const r = await runReconcile();
    const f = r.findings.find((x: any) => x.kind === "CHAIN" && /not fully backed/.test(x.detail));
    assert.ok(f, `expected CHAIN backing finding, got ${JSON.stringify(r.findings)}`);
    assert.equal(f.amountEur, 60);
  });

  console.log(`\nRECONCILE TEST PASSED — ${pass}/${pass}: drift is detected, not silently tolerated`);
} finally {
  for (const c of children) c.kill();
  stub.close();
}
