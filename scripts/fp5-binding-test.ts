/**
 * FP5 quote↔execution binding test: quote a transfer, move the on-chain
 * FxSwapper rate past tolerance, then execute — the transfer must refuse to
 * settle and auto-refund (FP3), not silently settle at the moved rate.
 * Own ports. Run: npm run fp5:test
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hardhat } from "viem/chains";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RPC = "http://127.0.0.1:8548";
const API = "http://127.0.0.1:3011";
const bin = (n: string) => path.join(ROOT, "node_modules/.bin", n);
let token = "";
const ENV = {
  ...process.env,
  MONERIUM_CLIENT_ID: "", MONERIUM_CLIENT_SECRET: "", MG_ANCHOR_DOMAIN: "",
  TRANSF_RPC_URL: RPC, TRANSF_API_PORT: "3011",
};
const children: ChildProcess[] = [];
const bg = (c: string, a: string[]) => { const p = spawn(c, a, { cwd: ROOT, stdio: "ignore", env: ENV }); children.push(p); return p; };

async function api(p: string, body?: any, expectStatus?: number) {
  const headers: Record<string, string> = {};
  if (body) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(API + p, { ...(body ? { method: "POST", body: JSON.stringify(body) } : {}), headers });
  const data = await res.json();
  if (expectStatus) { assert.equal(res.status, expectStatus, `${p} → ${res.status}: ${data.error ?? ""}`); return data; }
  if (!res.ok) throw new Error(`${p}: ${data.error ?? res.statusText}`);
  return data;
}

try {
  console.log("1/5 chain + deploy + API…");
  bg(process.execPath, [bin("hardhat"), "node", "--port", "8548"]);
  const pub = createPublicClient({ chain: hardhat, transport: http(RPC) });
  { const s = Date.now(); while (Date.now() - s < 30_000) { try { await pub.getBlockNumber(); break; } catch { await new Promise(r => setTimeout(r, 300)); } } }
  assert.equal(spawnSync(process.execPath, [bin("tsx"), "scripts/deploy.ts"], { cwd: ROOT, stdio: "inherit", env: ENV }).status, 0);
  rmSync(path.join(ROOT, "data/db.json"), { force: true });
  bg(process.execPath, [bin("tsx"), "services/api/src/server.ts"]);
  { const s = Date.now(); while (Date.now() - s < 30_000) { try { if ((await fetch(`${API}/api/health`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 300)); } }

  console.log("2/5 user + €250 deposit + quote €100…");
  const user = await api("/api/users", { name: "Binding Tester", country: "DE" });
  token = user.sessionToken;
  await api("/api/simulate/sepa-deposit", { iban: user.iban, amountEur: 250 });
  const quote = await api("/api/quotes", { userId: user.id, sendEur: 100, rail: "cash" });
  assert.ok(quote.lockedSwapRate, "quote records lockedSwapRate");

  console.log("3/5 moving the on-chain FX rate past tolerance…");
  const dep = createWalletClient({ account: privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"), chain: hardhat, transport: http(RPC) });
  const { swapper } = JSON.parse(readFileSync(path.join(ROOT, "deployments.json"), "utf8"));
  const abi = [{ type: "function", name: "setRate", stateMutability: "nonpayable", inputs: [{ name: "_rate", type: "uint256" }], outputs: [] }] as const;
  const { request } = await pub.simulateContract({ account: dep.account, address: swapper, abi, functionName: "setRate", args: [900_000n] }); // 1.08 → 0.90, ~16%
  await pub.waitForTransactionReceipt({ hash: await dep.writeContract(request) });

  console.log("4/5 executing — must refuse and refund…");
  // FP3 turns the binding failure into REFUNDED, which the route returns 201.
  const t = await api("/api/transfers", { quoteId: quote.id, recipientName: "X", recipientPhone: "+254700000000" });
  assert.equal(t.state, "REFUNDED", `state: ${t.state} (${t.error ?? ""})`);
  assert.match(t.error ?? "", /rate moved/i, "error names the rate drift");
  assert.ok(t.txs.some((x: any) => x.step === "vault.refundCredit"), "vault refunded");
  assert.ok(!t.txs.some((x: any) => x.step === "swapper.swapExactIn"), "no swap happened");

  console.log("5/5 balance restored…");
  const after = await api(`/api/users/${user.id}`);
  assert.ok(Math.abs(after.balanceEur - 250) < 0.02, `balance €${after.balanceEur}`);
  console.log(`      refused at drift, refunded €${t.refund?.amountEur}, balance €${after.balanceEur}`);

  console.log("\nFP5 BINDING TEST PASSED — quote bound to execution; rate drift refuses + refunds");
} finally {
  for (const c of children) c.kill();
}
