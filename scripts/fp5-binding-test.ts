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
import { createPublicClient, createWalletClient, encodeFunctionData, http, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hardhat } from "viem/chains";
import { newDevice, registerDevice, sendTransfer } from "./device.js";

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
  assert.equal(spawnSync(process.execPath, [bin("tsx"), "scripts/deploy.ts"], { cwd: ROOT, stdio: "inherit", env: { ...ENV, TIMELOCK_DELAY_SECONDS: "0" } }).status, 0);
  rmSync(path.join(ROOT, "data/db.json"), { force: true });
  bg(process.execPath, [bin("tsx"), "services/api/src/server.ts"]);
  { const s = Date.now(); while (Date.now() - s < 30_000) { try { if ((await fetch(`${API}/api/health`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 300)); } }

  console.log("2/5 user + €250 deposit + quote €100…");
  const user = await api("/api/users", { name: "Binding Tester", country: "DE" });
  token = user.sessionToken;
  await api("/api/simulate/sepa-deposit", { iban: user.iban, amountEur: 250 });
  const device = newDevice();
  await registerDevice(api, user.id, device);
  const quote = await api("/api/quotes", { userId: user.id, sendEur: 100, rail: "cash" });
  assert.ok(quote.lockedSwapRate, "quote records lockedSwapRate");

  console.log("3/5 moving the on-chain FX rate past tolerance (via the timelock)…");
  // Admin actions now go through AdminTimelock: no single key can change the
  // rate, so this both moves the rate and exercises the governance path.
  const dep = createWalletClient({ account: privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"), chain: hardhat, transport: http(RPC) });
  const second = createWalletClient({ account: privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"), chain: hardhat, transport: http(RPC) });
  const { swapper, timelock } = JSON.parse(readFileSync(path.join(ROOT, "deployments.json"), "utf8"));
  assert.ok(timelock, "deployments.json should record the AdminTimelock address");
  const setRate = encodeFunctionData({
    abi: [{ type: "function", name: "setRate", stateMutability: "nonpayable", inputs: [{ name: "_rate", type: "uint256" }], outputs: [] }] as const,
    functionName: "setRate",
    args: [900_000n], // 1.08 → 0.90, ~16%
  });
  const tlAbi = [
    { type: "function", name: "queue", stateMutability: "nonpayable", inputs: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }, { name: "salt", type: "bytes32" }], outputs: [{ type: "bytes32" }] },
    { type: "function", name: "confirm", stateMutability: "nonpayable", inputs: [{ name: "id", type: "bytes32" }], outputs: [] },
    { type: "function", name: "execute", stateMutability: "payable", inputs: [{ name: "id", type: "bytes32" }], outputs: [{ type: "bytes" }] },
    { type: "function", name: "operationId", stateMutability: "pure", inputs: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }, { name: "salt", type: "bytes32" }], outputs: [{ type: "bytes32" }] },
  ] as const;
  const salt = keccak256(toHex("fp5-rate-move"));
  const opId = await pub.readContract({ address: timelock, abi: tlAbi, functionName: "operationId", args: [swapper, 0n, setRate, salt] });
  const send = async (w: typeof dep, fn: "queue" | "confirm" | "execute", args: any[]) => {
    const { request } = await pub.simulateContract({ account: w.account, address: timelock, abi: tlAbi, functionName: fn, args });
    await pub.waitForTransactionReceipt({ hash: await w.writeContract(request) });
  };
  await send(dep, "queue", [swapper, 0n, setRate, salt]);
  // One key is not enough — a second owner must agree.
  await send(second, "confirm", [opId]);
  await send(dep, "execute", [opId]);

  console.log("4/5 executing — must refuse and refund…");
  // FP3 turns the binding failure into REFUNDED, which the route returns 201.
  const t = await sendTransfer(api, device, { quoteId: quote.id, recipientName: "X", recipientPhone: "+254700000000" });
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
