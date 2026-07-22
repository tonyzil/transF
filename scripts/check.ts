/**
 * Full verification runner.
 *
 * Some integration tests spin up a local API, Hardhat node, and stub provider.
 * Use free ports by default so `npm run check` does not fail just because a
 * developer has the demo API running on :3000.
 */
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const scripts = [
  "compile",
  "test:contracts",
  "webauthn:selftest",
  "fp3:test",
  "fp4:test",
  "fp5:test",
  "webhook:test",
  "reconcile:test",
  "anchor:test",
  "anchor:safety",
  "cctp:dryrun",
  "e2e",
];

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const address = s.address();
      if (!address || typeof address === "string") {
        s.close();
        reject(new Error("could not allocate a free port"));
        return;
      }
      const port = address.port;
      s.close(() => resolve(port));
    });
  });
}

const apiPort = process.env.TRANSF_API_PORT ?? String(await freePort());
const rpcPort = process.env.TRANSF_RPC_URL ? "" : String(await freePort());
const stubPort = process.env.TRANSF_STUB_PORT ?? String(await freePort());
const env = {
  ...process.env,
  TRANSF_API_PORT: apiPort,
  TRANSF_RPC_URL: process.env.TRANSF_RPC_URL ?? `http://127.0.0.1:${rpcPort}`,
  TRANSF_STUB_PORT: stubPort,
};

console.log(`check ports: api=${env.TRANSF_API_PORT} rpc=${env.TRANSF_RPC_URL} stub=${env.TRANSF_STUB_PORT}`);

for (const script of scripts) {
  const r = spawnSync(npm, ["run", script], { stdio: "inherit", env });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
