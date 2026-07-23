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
import { createPublicClient, createWalletClient, encodeFunctionData, http, keccak256, parseUnits, toHex } from "viem";
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
const ramp2Key = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6" as const;
wallets.ramp2 = createWalletClient({ account: privateKeyToAccount(ramp2Key), chain: hardhat, transport: http(RPC) });
const orchAddr = wallets.orch.account.address;
const rampAddr = wallets.ramp.account.address;
// The user's device key: it authorizes debits and never exists server-side.
// (Hardhat account #9 — a throwaway, like the role keys above.)
const userDevice = privateKeyToAccount(
  "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
);
const USER = userDevice.address;
const NO_KEY_USER = "0x1111111111111111111111111111111111111111" as const;

const DEADLINE = BigInt(Math.floor(Date.now() / 1000) + 3600);

/** A default payout-destination commitment for the happy-path tests. */
const DEST = keccak256(toHex("cash|phone=+254700000000"));

/** Sign a PaymentAuthorization the way the browser will. */
async function authorize(
  vaultAddress: `0x${string}`,
  account: { signTypedData: (a: any) => Promise<`0x${string}`> },
  args: {
    user: `0x${string}`;
    amount: bigint;
    to: `0x${string}`;
    transferId: `0x${string}`;
    destination?: `0x${string}`;
    deadline?: bigint;
  },
) {
  const deadline = args.deadline ?? DEADLINE;
  const destination = args.destination ?? DEST;
  const signature = await account.signTypedData({
    domain: { name: "RemitVault", version: "1", chainId: 31337, verifyingContract: vaultAddress },
    types: {
      PaymentAuthorization: [
        { name: "account", type: "address" },
        { name: "amount", type: "uint256" },
        { name: "to", type: "address" },
        { name: "transferId", type: "bytes32" },
        { name: "destination", type: "bytes32" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "PaymentAuthorization",
    message: {
      account: args.user,
      amount: args.amount,
      to: args.to,
      transferId: args.transferId,
      destination,
      deadline,
    },
  });
  return [args.user, args.amount, args.to, args.transferId, destination, deadline, signature] as const;
}

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

async function increaseTime(seconds: number) {
  await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "evm_increaseTime", params: [seconds] }),
  });
  await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "evm_mine", params: [] }),
  });
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
  await write("deployer", swapper, "setTrader", [orchAddr, true]);
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

  console.log("RemitVault — FP4 payment authorization:");
  await t("debit without a registered authorizer reverts", () =>
    expectRevert(
      write("orch", vault, "debit", [USER, E("1"), orchAddr, keccak256(toHex("t0")), DEST, DEADLINE, "0x"]),
      "no authorizer",
      "debit before authorizer binding",
    ),
  );

  await t("ramp binds the account to its device key", async () => {
    await write("ramp", vault, "setAuthorizer", [USER, USER]);
    assert.equal(await read(vault, "authorizerOf", [USER]), USER);
  });

  await t("ramp cannot re-point an already-bound account", () =>
    expectRevert(
      write("ramp", vault, "setAuthorizer", [USER, orchAddr]),
      "not current authorizer",
      "ramp rebinding a live account",
    ),
  );

  await t("orchestrator cannot debit without a signature", () =>
    expectRevert(
      write("orch", vault, "debit", [USER, E("100"), orchAddr, keccak256(toHex("t1")), DEST, DEADLINE, "0x"]),
      "bad authorization",
      "unsigned debit",
    ),
  );

  await t("a signature for different terms is rejected", async () => {
    // Device authorizes €1; orchestrator tries to submit it for €100.
    const signed = await authorize(vault.address, userDevice, {
      user: USER,
      amount: E("1"),
      to: orchAddr,
      transferId: keccak256(toHex("t1")),
    });
    // signed = [user, amount, to, transferId, destination, deadline, signature]
    await expectRevert(
      write("orch", vault, "debit", [USER, E("100"), orchAddr, signed[3], signed[4], signed[5], signed[6]]),
      "bad authorization",
      "amount swapped after signing",
    );
  });

  await t("a payment redirected to a different destination is rejected", async () => {
    // Device signs a payout to destination A; the submitter tries to steer the
    // same amount/transfer to destination B. The commitment is part of the
    // signed digest, so the swap invalidates the signature.
    const signed = await authorize(vault.address, userDevice, {
      user: USER,
      amount: E("1"),
      to: orchAddr,
      transferId: keccak256(toHex("t1")),
      destination: keccak256(toHex("sepa|iban=DE00GRANDMA")),
    });
    const attackerDest = keccak256(toHex("sepa|iban=DE00ATTACKER"));
    await expectRevert(
      write("orch", vault, "debit", [signed[0], signed[1], signed[2], signed[3], attackerDest, signed[5], signed[6]]),
      "bad authorization",
      "recipient swapped after signing",
    );
  });

  await t("a signature from the wrong key is rejected", async () => {
    const signed = await authorize(vault.address, wallets.orch.account as any, {
      user: USER,
      amount: E("100"),
      to: orchAddr,
      transferId: keccak256(toHex("t1")),
    });
    await expectRevert(
      write("orch", vault, "debit", [...signed]),
      "bad authorization",
      "orchestrator self-signed authorization",
    );
  });

  await t("an expired authorization is rejected", async () => {
    const signed = await authorize(vault.address, userDevice, {
      user: USER,
      amount: E("100"),
      to: orchAddr,
      transferId: keccak256(toHex("t1")),
      deadline: 1n,
    });
    await expectRevert(
      write("orch", vault, "debit", [...signed]),
      "authorization expired",
      "past-deadline authorization",
    );
  });

  await t("orchestrator debits with a valid authorization", async () => {
    const signed = await authorize(vault.address, userDevice, {
      user: USER,
      amount: E("100"),
      to: orchAddr,
      transferId: keccak256(toHex("t1")),
    });
    await write("orch", vault, "debit", [...signed]);
    assert.equal(await read(vault, "balanceOf", [USER]), E("900"));
    assert.equal(await read(eure, "balanceOf", [orchAddr]), E("100"));
  });

  await t("duplicate transferId reverts", async () => {
    const signed = await authorize(vault.address, userDevice, {
      user: USER,
      amount: E("1"),
      to: orchAddr,
      transferId: keccak256(toHex("t1")),
    });
    await expectRevert(
      write("orch", vault, "debit", [...signed]),
      "duplicate transfer",
      "replayed transferId",
    );
  });

  await t("daily cap enforced", async () => {
    // Top up so the balance check passes and the cap check is what trips:
    // 100 already debited today + 2401 > 2500 cap.
    await write("deployer", eure, "mint", [vault.address, E("2000")]);
    await write("ramp", vault, "creditDeposit", [USER, E("2000"), keccak256(toHex("r3"))]);
    const signed = await authorize(vault.address, userDevice, {
      user: USER,
      amount: E("2401"),
      to: orchAddr,
      transferId: keccak256(toHex("t2")),
    });
    await expectRevert(
      write("orch", vault, "debit", [...signed]),
      "daily cap exceeded",
      "over-cap debit",
    );
  });

  await t("pause blocks debits", async () => {
    await write("deployer", vault, "setPaused", [true]);
    const signed = await authorize(vault.address, userDevice, {
      user: USER,
      amount: E("1"),
      to: orchAddr,
      transferId: keccak256(toHex("t3")),
    });
    await expectRevert(
      write("orch", vault, "debit", [...signed]),
      "paused",
      "debit while paused",
    );
    await write("deployer", vault, "setPaused", [false]);
  });

  console.log("AdminTimelock — governance:");
  const TL_DELAY = 60;
  const timelock = await deploy("AdminTimelock", [
    [wallets.deployer.account.address, orchAddr, rampAddr],
    2,
    BigInt(TL_DELAY),
  ]);
  const capCall = encodeFunctionData({
    abi: artifact("RemitVault").abi,
    functionName: "setDailyCap",
    args: [E("9999")],
  });
  const salt = keccak256(toHex("cap-raise"));
  let opId: `0x${string}`;

  await t("ownership moves to the timelock", async () => {
    await write("deployer", vault, "transferOwnership", [timelock.address]);
    assert.equal(
      String(await read(vault, "owner")).toLowerCase(),
      timelock.address.toLowerCase(),
    );
  });

  await t("the old owner key can no longer raise the daily cap", () =>
    expectRevert(
      write("deployer", vault, "setDailyCap", [E("9999")]),
      "not owner",
      "deployer raising the cap directly",
    ),
  );

  await t("a non-owner cannot queue anything", () =>
    expectRevert(
      write("ramp2", timelock, "queue", [vault.address, 0n, capCall, salt]),
      "not owner",
      "stranger queuing an admin call",
    ),
  );

  await t("queueing records the operation and the proposer's confirmation", async () => {
    opId = (await read(timelock, "operationId", [vault.address, 0n, capCall, salt])) as `0x${string}`;
    await write("deployer", timelock, "queue", [vault.address, 0n, capCall, salt]);
    const op = (await read(timelock, "operations", [opId])) as any[];
    assert.equal(op[4], 1, "proposer should count as the first confirmation");
  });

  await t("one confirmation is not enough to execute", () =>
    expectRevert(
      write("deployer", timelock, "execute", [opId]),
      "not enough confirmations",
      "executing below threshold",
    ),
  );

  await t("a second owner confirms, but the delay still blocks it", async () => {
    await write("orch", timelock, "confirm", [opId]);
    await expectRevert(
      write("deployer", timelock, "execute", [opId]),
      "timelock not elapsed",
      "executing before the delay",
    );
  });

  await t("the same owner cannot confirm twice to reach threshold alone", () =>
    expectRevert(
      write("orch", timelock, "confirm", [opId]),
      "already confirmed",
      "double confirmation",
    ),
  );

  await t("after the delay, a confirmed operation executes", async () => {
    await increaseTime(TL_DELAY + 1);
    await write("deployer", timelock, "execute", [opId]);
    assert.equal(await read(vault, "dailyCap"), E("9999"));
  });

  await t("an executed operation cannot be replayed", () =>
    expectRevert(
      write("deployer", timelock, "execute", [opId]),
      "operation closed",
      "re-executing",
    ),
  );

  await t("any single owner can cancel a queued operation", async () => {
    const salt2 = keccak256(toHex("cap-raise-2"));
    const id2 = (await read(timelock, "operationId", [vault.address, 0n, capCall, salt2])) as `0x${string}`;
    await write("deployer", timelock, "queue", [vault.address, 0n, capCall, salt2]);
    await write("ramp", timelock, "cancel", [id2]);
    await write("orch", timelock, "confirm", [id2]).catch(() => {});
    await increaseTime(TL_DELAY + 1);
    await expectRevert(
      write("deployer", timelock, "execute", [id2]),
      "operation closed",
      "executing a cancelled operation",
    );
  });

  await t("the timelock's own delay cannot be changed from outside", () =>
    expectRevert(
      write("deployer", timelock, "setDelay", [0n]),
      "only via timelock",
      "bypassing the queue to shorten the delay",
    ),
  );

  console.log("Guardian — instant stop, slow start:");
  await t("the guardian can pause without the timelock", async () => {
    await write("deployer", timelock, "queue", [
      vault.address, 0n,
      encodeFunctionData({ abi: artifact("RemitVault").abi, functionName: "setGuardian", args: [rampAddr] }),
      keccak256(toHex("set-guardian")),
    ]);
    const gid = (await read(timelock, "operationId", [
      vault.address, 0n,
      encodeFunctionData({ abi: artifact("RemitVault").abi, functionName: "setGuardian", args: [rampAddr] }),
      keccak256(toHex("set-guardian")),
    ])) as `0x${string}`;
    await write("orch", timelock, "confirm", [gid]);
    await increaseTime(TL_DELAY + 1);
    await write("deployer", timelock, "execute", [gid]);
    await write("ramp", vault, "pause", []);
    assert.equal(await read(vault, "paused"), true);
  });

  await t("the guardian cannot un-pause — that needs the timelock", async () => {
    await expectRevert(
      write("ramp", vault, "setPaused", [false]),
      "not owner",
      "guardian restarting the system",
    );
    const unpause = encodeFunctionData({
      abi: artifact("RemitVault").abi, functionName: "setPaused", args: [false],
    });
    const uid = (await read(timelock, "operationId", [vault.address, 0n, unpause, keccak256(toHex("unpause"))])) as `0x${string}`;
    await write("deployer", timelock, "queue", [vault.address, 0n, unpause, keccak256(toHex("unpause"))]);
    await write("orch", timelock, "confirm", [uid]);
    await increaseTime(TL_DELAY + 1);
    await write("deployer", timelock, "execute", [uid]);
    assert.equal(await read(vault, "paused"), false);
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

  await t("non-trader cannot swap inventory", () =>
    expectRevert(
      write("ramp", swapper, "swapExactIn", [E("1"), U("1"), rampAddr]),
      "not trader",
      "public swapper access",
    ),
  );

  await t("pause blocks swaps", async () => {
    await write("deployer", swapper, "setPaused", [true]);
    await expectRevert(
      write("orch", swapper, "swapExactIn", [E("1"), U("1"), orchAddr]),
      "paused",
      "swap while paused",
    );
    await write("deployer", swapper, "setPaused", [false]);
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
      "already used",
      "same transferId twice",
    ),
  );

  await t("settle clears the lock and prevents id reuse", async () => {
    const beforeOwner = (await read(usdc, "balanceOf", [wallets.deployer.account.address])) as bigint;
    await write("orch", bridge, "settle", [tid]);
    assert.equal(await read(bridge, "lockedAmount", [tid]), 0n);
    assert.equal(await read(bridge, "totalLocked"), 0n);
    const afterOwner = (await read(usdc, "balanceOf", [wallets.deployer.account.address])) as bigint;
    assert.equal(afterOwner - beforeOwner, U("108"));
    await write("deployer", usdc, "mint", [orchAddr, U("1")]);
    await write("orch", usdc, "approve", [bridge.address, U("1")]);
    await expectRevert(
      write("orch", bridge, "lockForPayout", [tid, U("1"), "stellar", "again"]),
      "already used",
      "settled transferId reused",
    );
  });

  await t("release refunds to target", async () => {
    const tid2 = keccak256(toHex("refund-1"));
    // Orchestrator locked its full swap output above; fund it for this lock.
    await write("deployer", usdc, "mint", [orchAddr, U("5")]);
    await write("orch", usdc, "approve", [bridge.address, U("5")]);
    await write("orch", bridge, "lockForPayout", [tid2, U("5"), "stellar", "x"]);
    const before = (await read(usdc, "balanceOf", [orchAddr])) as bigint;
    await expectRevert(
      write("orch", bridge, "release", [tid2, USER]),
      "wrong refund target",
      "refund target chosen after lock",
    );
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
