/**
 * One-command local stack: chain -> deploy -> API (with UI at :3000).
 * Run: npm run dev
 */
import { spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = (name: string) => path.join(ROOT, "node_modules/.bin", name);
const API_PORT = Number(process.env.TRANSF_API_PORT ?? 3000);
const RPC_URL = process.env.TRANSF_RPC_URL ?? "http://127.0.0.1:8545";
const RPC_PORT = new URL(RPC_URL).port || "8545";

async function waitForChain(timeoutMs = 30_000) {
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
  throw new Error(`chain did not come up on :${RPC_PORT}`);
}

console.log(`starting local chain on :${RPC_PORT}…`);
const chain = spawn(process.execPath, [bin("hardhat"), "node", "--port", RPC_PORT], {
  cwd: ROOT,
  stdio: "ignore",
});
process.on("exit", () => chain.kill());

await waitForChain();
console.log("deploying contracts…");
const dep = spawnSync(process.execPath, [bin("tsx"), "scripts/deploy.ts"], {
  cwd: ROOT,
  stdio: "inherit",
});
if (dep.status !== 0) process.exit(1);

// A fresh chain each run means old demo users reference dead chain state.
rmSync(path.join(ROOT, "data/db.json"), { force: true });

console.log(`starting API on :${API_PORT}…`);
const api = spawn(process.execPath, [bin("tsx"), "services/api/src/server.ts"], {
  cwd: ROOT,
  stdio: "inherit",
});
process.on("exit", () => api.kill());
api.on("exit", (code) => process.exit(code ?? 0));
