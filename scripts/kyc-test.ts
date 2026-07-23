/**
 * KYC gate regression test.
 *
 * KYC_AUTO_APPROVE=0 makes a new user start pending. The app must not issue a
 * funding IBAN, bind a spending device, create quotes, or take deposits until
 * the review seam approves them. The seam is mock-only and blocked when
 * simulation endpoints are disabled.
 *
 * Run: npm run kyc:test
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newDevice } from "./device.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_PORT = Number(process.env.TRANSF_API_PORT ?? 3020);
const RPC_URL = process.env.TRANSF_RPC_URL ?? "http://127.0.0.1:8560";
const RPC_PORT = new URL(RPC_URL).port || "8560";
const API = `http://127.0.0.1:${API_PORT}`;
const bin = (n: string) => path.join(ROOT, "node_modules/.bin", n);

const ENV = {
  ...process.env,
  TRANSF_API_PORT: String(API_PORT),
  TRANSF_RPC_URL: RPC_URL,
  MONERIUM_CLIENT_ID: "",
  MONERIUM_CLIENT_SECRET: "",
  MG_ANCHOR_DOMAIN: "",
  KYC_AUTO_APPROVE: "0",
};

let token = "";
const children: ChildProcess[] = [];

function bg(cmd: string, args: string[]) {
  const c = spawn(cmd, args, { cwd: ROOT, stdio: "ignore", env: ENV });
  children.push(c);
  return c;
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

async function waitForRpc(timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      });
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("chain did not come up");
}

async function api(pathname: string, body?: any) {
  const headers: Record<string, string> = {};
  if (body) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(API + pathname, {
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
    headers,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${pathname}: ${data.error ?? res.statusText}`);
  return data;
}

async function expectStatus(pathname: string, status: number, body?: any) {
  const headers: Record<string, string> = {};
  if (body) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(API + pathname, {
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
    headers,
  });
  assert.equal(res.status, status, `${pathname} should return ${status}`);
  return res.json().catch(() => ({}));
}

try {
  console.log("1/4 chain + deploy + API (KYC_AUTO_APPROVE=0)...");
  bg(process.execPath, [bin("hardhat"), "node", "--port", RPC_PORT]);
  await waitForRpc();
  const dep = spawnSync(process.execPath, [bin("tsx"), "scripts/deploy.ts"], {
    cwd: ROOT,
    stdio: "inherit",
    env: ENV,
  });
  assert.equal(dep.status, 0, "deploy failed");
  rmSync(path.join(ROOT, "data/db.json"), { force: true });
  bg(process.execPath, [bin("tsx"), "services/api/src/server.ts"]);
  await waitFor(`${API}/api/health`);

  console.log("2/4 pending user cannot fund, bind, quote, or transfer...");
  const user = await api("/api/users", { name: "KYC Pending", country: "DE" });
  token = user.sessionToken;
  assert.equal(user.kycStatus, "pending");
  assert.equal(user.iban, "");
  assert.equal(user.funding.status, "kyc_pending");
  const kyc = await api(`/api/users/${user.id}/kyc`);
  assert.equal(kyc.kycStatus, "pending");
  await expectStatus(`/api/users/${user.id}/authorizer`, 409, { address: newDevice().address });
  await expectStatus("/api/quotes", 409, { userId: user.id, sendEur: 25, rail: "cash" });
  await expectStatus("/api/simulate/sepa-deposit", 404, { iban: "IS140159260007545510730339", amountEur: 10 });

  console.log("3/4 rejected KYC stays blocked...");
  const rejected = await api(`/api/users/${user.id}/kyc/mock-review`, {
    decision: "rejected",
    reason: "test rejection",
  });
  assert.equal(rejected.kycStatus, "rejected");
  assert.equal(rejected.iban, "");
  await expectStatus("/api/quotes", 409, { userId: user.id, sendEur: 25, rail: "cash" });

  console.log("4/4 approved KYC issues funding and opens quotes...");
  const approved = await api(`/api/users/${user.id}/kyc/mock-review`, { decision: "approved" });
  assert.equal(approved.kycStatus, "approved");
  assert.match(approved.iban, /^IS14/);
  assert.equal(approved.funding.status, "active");
  const quote = await api("/api/quotes", { userId: user.id, sendEur: 25, rail: "cash" });
  assert.equal(quote.userId, user.id);

  console.log("\nKYC TEST PASSED — pending/rejected accounts fail closed; approved accounts can proceed");
} finally {
  for (const c of children) c.kill();
}
