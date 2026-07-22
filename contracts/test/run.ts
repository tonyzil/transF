/**
 * Contract tests. Spawns a dedicated hardhat node on :8546, deploys fresh
 * contracts, and exercises vault/swapper/escrow invariants with viem.
 * Run: npm run test:contracts
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, keccak256, parseUnits, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hardhat } from "viem/chains";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RPC = "http://127.0.0.1:8546";

const pk = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  orch: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  ramp: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
} as const;

const pub = createPublicClient({ chain: hardhat, transport: http(RPC) });
const wallets = {
  deployer: createWalletClient({ account: privateKeyToAccount(pk.deployer), chain: hardhat, transport: http(RPC) }),
  orch: createWalletClient({ account: privateKeyToAccount(pk.orch), chain: hardhat, transport: http(RPC) }),
  ramp: createWalletClient({ account: privateKeyToAccount(pk.ramp), chain: hardhat, transport: http(RPC) }),
};
const orchAddr = wallets.orch.account.address;
const rampAddr = wallets.ramp.account.address;
const USER = "0x1111111111111111111111111111111111111111" as const;

function artifact(name: string) {
  const p = path.join(ROOT, "contracts/artifacts/contracts/src", `${name}.sol`, `${name}.json`);
  return JSON.parse(readFileSync(p, "utf8"));
}

async function deploy(name: string, args: any[]) {
  const { abi, bytecode } = artifact(name);
  const hash = await wallets.deployer.deployContract({ abi, bytecode, args });
  const r = await pub.waitForTransactionReceipt({ hash });
  return { address: r.contractAddress!, abi };
}

type Deployed = Awaited<ReturnType<typeof deploy>>;

async function write(w: keyof typeof wallets, c: Deployed, functionName: string, args: any[]) {
  const { request } = await pub.simulateContract({
    account: wallets[w].account,
    address: c.address,
    abi: c.abi,
    functionName,
    args,
  });
  const hash = await wallets[w].writeContract(request);
  await pub.waitForTransactionReceipt({ hash });
}

async function read(c: Deployed, functionName: string, args: any[] = []) {
  return pub.readContract({ address: c.address, abi: c.abi, functionName, args });
}

async function expectRevert(promise: Promise<any>, needle: string, label: string) {
  try {
    await promise;
  } catch (e: any) {
    const msg = String(e?.shortMessage ?? e?.message ?? e);
    assert.ok(msg.includes(needle), `${label}: expected revert "${needle}", got: ${msg}`);
    return;
  }
  assert.fail(`${label}: expected revert "${needle}" but call succeeded`);
}

async function waitForRpc(timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await pub.getBlockNumber();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error("hardhat node did not come up on :8546");
}

const E = (n: string) => parseUnits(n, 18); // EURe units
const U = (n: string) => parseUnits(n, 6); // USDC units

async function main() {
  let pass = 0;
  const t = async (label: string, fn: () => Promise<void>) => {
    await fn();
    pass++;
    console.log(`  ok  ${label}`);
  };

  const eure = await deploy("MockToken", ["EURe", "EURe", 18]);
  const usdc = await deploy("MockToken", ["USDC", "USDC", 6]);
  const vault = await deploy("RemitVault", [eure.address, E("2500")]);
  const swapper = await deploy("FxSwapper", [eure.address, usdc.address, 1_080_000n]);
  const bridge = await deploy("BridgeEscrow", [usdc.address]);
  await write("deployer", vault, "setRamp", [rampAddr, true]);
  await write("deployer", vault, "setOrchestrator", [orchAddr, true]);
  await write("deployer", bridge, "setOrchestrator", [orchAddr, true]);
  await write("deployer", usdc, "mint", [swapper.address, U("1000000")]);

  console.log("RemitVault:");
  await t("uncovered credit reverts", () =>
    expectRevert(
      write("ramp", vault, "creditDeposit", [USER, E("100"), keccak256(toHex("r0"))]),
      "uncovered credit",
      "credit without tokens",
    ),
  );

  await write("deployer", eure, "mint", [vault.address, E("1000")]);
  await t("ramp credits a covered deposit", async () => {
    await write("ramp", vault, "creditDeposit", [USER, E("1000"), keccak256(toHex("r1"))]);
    assert.equal(await read(vault, "balanceOf", [USER]), E("1000"));
  });

  await t("duplicate deposit ref reverts", () =>
    expectRevert(
      write("ramp", vault, "creditDeposit", [USER, E("1"), keccak256(toHex("r1"))]),
      "duplicate deposit",
      "replayed deposit ref",
    ),
  );

  await t("non-ramp cannot credit", () =>
    expectRevert(
      write("orch", vault, "creditDeposit", [USER, E("1"), keccak256(toHex("r2"))]),
      "not ramp",
      "credit from orchestrator",
    ),
  );

  await t("orchestrator debits to its own address", async () => {
    await write("orch", vault, "debit", [USER, E("100"), orchAddr, keccak256(toHex("t1"))]);
    assert.equal(await read(vault, "balanceOf", [USER]), E("900"));
    assert.equal(await read(eure, "balanceOf", [orchAddr]), E("100"));
  });

  await t("duplicate transferId reverts", () =>
    expectRevert(
      write("orch", vault, "debit", [USER, E("1"), orchAddr, keccak256(toHex("t1"))]),
      "duplicate transfer",
      "replayed transferId",
    ),
  );

  await t("daily cap enforced", async () => {
    // Top up so the balance check passes and the cap check is what trips:
    // 100 already debited today + 2401 > 2500 cap.
    await write("deployer", eure, "mint", [vault.address, E("2000")]);
    await write("ramp", vault, "creditDeposit", [USER, E("2000"), keccak256(toHex("r3"))]);
    await expectRevert(
      write("orch", vault, "debit", [USER, E("2401"), orchAddr, keccak256(toHex("t2"))]),
      "daily cap exceeded",
      "over-cap debit",
    );
  });

  await t("pause blocks debits", async () => {
    await write("deployer", vault, "setPaused", [true]);
    await expectRevert(
      write("orch", vault, "debit", [USER, E("1"), orchAddr, keccak256(toHex("t3"))]),
      "paused",
      "debit while paused",
    );
    await write("deployer", vault, "setPaused", [false]);
  });

  console.log("FxSwapper:");
  await t("quote math: 100 EURe -> 108 USDC", async () => {
    assert.equal(await read(swapper, "quoteOut", [E("100")]), U("108"));
  });

  await t("swap pays out at rate", async () => {
    await write("orch", eure, "approve", [swapper.address, E("100")]);
    await write("orch", swapper, "swapExactIn", [E("100"), U("108"), orchAddr]);
    assert.equal(await read(usdc, "balanceOf", [orchAddr]), U("108"));
  });

  await t("slippage guard reverts", async () => {
    await expectRevert(
      write("orch", swapper, "swapExactIn", [E("1"), U("2"), orchAddr]),
      "slippage",
      "minOut above quote",
    );
  });

  console.log("BridgeEscrow:");
  const tid = keccak256(toHex("t1"));
  await t("lock pulls USDC and records amount", async () => {
    await write("orch", usdc, "approve", [bridge.address, U("108")]);
    await write("orch", bridge, "lockForPayout", [tid, U("108"), "stellar", "mgi:+254700"]);
    assert.equal(await read(bridge, "lockedAmount", [tid]), U("108"));
  });

  await t("double lock reverts", () =>
    expectRevert(
      write("orch", bridge, "lockForPayout", [tid, U("1"), "stellar", "x"]),
      "already locked",
      "same transferId twice",
    ),
  );

  await t("settle clears the lock", async () => {
    await write("orch", bridge, "settle", [tid]);
    assert.equal(await read(bridge, "lockedAmount", [tid]), 0n);
  });

  await t("release refunds to target", async () => {
    const tid2 = keccak256(toHex("refund-1"));
    // Orchestrator locked its full swap output above; fund it for this lock.
    await write("deployer", usdc, "mint", [orchAddr, U("5")]);
    await write("orch", usdc, "approve", [bridge.address, U("5")]);
    await write("orch", bridge, "lockForPayout", [tid2, U("5"), "stellar", "x"]);
    const before = (await read(usdc, "balanceOf", [orchAddr])) as bigint;
    await write("orch", bridge, "release", [tid2, orchAddr]);
    const after = (await read(usdc, "balanceOf", [orchAddr])) as bigint;
    assert.equal(after - before, U("5"));
  });

  console.log(`\n${pass} tests passed`);
}

const node = spawn(
  process.execPath,
  [path.join(ROOT, "node_modules/.bin/hardhat"), "node", "--port", "8546"],
  { cwd: ROOT, stdio: "ignore" },
);

try {
  await waitForRpc();
  await main();
} finally {
  node.kill();
}
