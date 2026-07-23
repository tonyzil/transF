/**
 * KYC operator seam test — runs the API in PRODUCTION mode.
 *
 * The gap this closes: with NODE_ENV=production, KYC.autoApprove is false so
 * every new user starts `pending`, and the only approval endpoint
 * (/kyc/mock-review) is gated on ALLOW_SIMULATION, which production also turns
 * off. The first user of a hosted demo was therefore stuck forever, and the
 * only escape — ALLOW_SIMULATION=1 — would simultaneously re-open simulated
 * SEPA deposits and simulated cash pickup. You had to turn on fake money to
 * onboard a real user.
 *
 * These assert the operator path works in exactly that configuration, and that
 * it cannot be driven by the user whose account it approves.
 *
 * Run: npm run kyc:operator:test
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
const bin = (n: string) => path.join(ROOT, "node_modules/.bin", n);

const OPERATOR_TOKEN = "test-operator-token-at-least-24-chars";
const children: ChildProcess[] = [];
let userToken = "";

function bg(cmd: string, args: string[], env: Record<string, string> = {}) {
  const c = spawn(cmd, args, { cwd: ROOT, stdio: "ignore", env: { ...process.env, ...env } });
  children.push(c);
  return c;
}

async function call(
  pathname: string,
  body?: any,
  auth?: string,
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = {};
  if (body) headers["content-type"] = "application/json";
  if (auth) headers.authorization = `Bearer ${auth}`;
  const res = await fetch(API + pathname, {
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
    headers,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

let pass = 0;
const t = async (label: string, fn: () => Promise<void>) => {
  await fn();
  pass++;
  console.log(`  ok  ${label}`);
};

// Ports must be free or the spawns fail silently and we test a stale server.
for (const [name, url] of [
  [`api :${API_PORT}`, `${API}/api/health`],
  [`chain :${RPC_PORT}`, RPC_URL],
] as const) {
  const busy = await fetch(url, { signal: AbortSignal.timeout(1500) }).then(() => true).catch(() => false);
  if (busy) {
    console.error(`${name} is already in use — stop it (or a leftover test) and re-run.`);
    process.exit(1);
  }
}

try {
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
    0,
    "deploy failed",
  );

  console.log("2/3 API in PRODUCTION mode (no ALLOW_SIMULATION)…");
  rmSync(path.join(ROOT, "data/db.json"), { force: true });
  bg(process.execPath, [bin("tsx"), "services/api/src/server.ts"], {
    NODE_ENV: "production",
    KYC_OPERATOR_TOKEN: OPERATOR_TOKEN,
    // Deliberately NOT set: ALLOW_SIMULATION. That is the whole point.
    ALLOW_SIMULATION: "",
    MONERIUM_CLIENT_ID: "",
    MONERIUM_CLIENT_SECRET: "",
    MG_ANCHOR_DOMAIN: "",
    // Dev keys are fine here: the RPC is local.
  });
  for (const s = Date.now(); Date.now() - s < 30_000; ) {
    try { if ((await fetch(`${API}/api/health`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log("3/3 the deadlock, and the way out…");

  const created = await call("/api/users", { name: "Hosted Demo User", country: "DE" });
  assert.equal(created.status, 201, "user creation should still work in production");
  const userId = created.data.id;
  userToken = created.data.sessionToken;

  await t("a production user starts pending, as the KYC gate intends", async () => {
    assert.equal(created.data.kycStatus, "pending");
    assert.equal(created.data.funding.status, "kyc_pending");
  });

  await t("the pending user cannot quote — the gate is real", async () => {
    const r = await call("/api/quotes", { userId, sendEur: 25, rail: "cash" }, userToken);
    assert.equal(r.status, 409);
  });

  await t("mock-review is blocked in production (the old dead end)", async () => {
    const r = await call(`/api/users/${userId}/kyc/mock-review`, { decision: "approved" }, userToken);
    assert.equal(r.status, 403, "self-service review must stay off in production");
  });

  await t("the user cannot approve themselves via the operator seam", async () => {
    // Their own valid session is not operator authorization.
    const r = await call("/api/kyc/review", { userId, decision: "approved" }, userToken);
    assert.equal(r.status, 401, "a user session must never satisfy operator auth");
  });

  await t("a wrong operator token is refused", async () => {
    const r = await call("/api/kyc/review", { userId, decision: "approved" }, "wrong-token-also-24-chars-long");
    assert.equal(r.status, 401);
  });

  await t("an unauthenticated review is refused", async () => {
    const r = await call("/api/kyc/review", { userId, decision: "approved" });
    assert.equal(r.status, 401);
  });

  await t("the operator approves — WITHOUT enabling simulation", async () => {
    const r = await call("/api/kyc/review", { userId, decision: "approved" }, OPERATOR_TOKEN);
    assert.equal(r.status, 200, `operator review failed: ${r.data.error ?? ""}`);
    assert.equal(r.data.kycStatus, "approved");
    assert.equal(r.data.kyc.provider, "manual", "an operator decision is not a mock decision");
    assert.match(r.data.iban, /^IS14/, "approval should issue funding");
    assert.equal(r.data.funding.status, "active");
  });

  await t("the approved user can now quote — the deadlock is broken", async () => {
    const r = await call("/api/quotes", { userId, sendEur: 25, rail: "cash" }, userToken);
    assert.equal(r.status, 201, `quote failed after approval: ${r.data.error ?? ""}`);
  });

  await t("simulation is still off — approval did not re-open fake money", async () => {
    const dep = await call("/api/simulate/sepa-deposit", { iban: "IS140159260007545510730339", amountEur: 10 }, userToken);
    assert.equal(dep.status, 403, "simulated deposits must remain disabled in production");
  });

  await t("an operator can also reject, and the gate closes again", async () => {
    const r = await call("/api/kyc/review", { userId, decision: "rejected", reason: "test" }, OPERATOR_TOKEN);
    assert.equal(r.status, 200);
    assert.equal(r.data.kycStatus, "rejected");
    const q = await call("/api/quotes", { userId, sendEur: 25, rail: "cash" }, userToken);
    assert.equal(q.status, 409, "a rejected user must not be able to quote");
  });

  console.log(`\nKYC OPERATOR TEST PASSED — ${pass}/${pass}: production approval works without enabling simulation`);
} finally {
  for (const c of children) c.kill();
}
