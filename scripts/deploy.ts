/**
 * Deploys the contract set to the local chain, wires roles, seeds FX
 * inventory, and writes deployments.json for the API.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hardhat } from "viem/chains";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RPC_URL = process.env.TRANSF_RPC_URL ?? "http://127.0.0.1:8545";

const KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  orchestrator: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  ramp: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
} as const;

const publicClient = createPublicClient({ chain: hardhat, transport: http(RPC_URL) });
const deployer = createWalletClient({
  account: privateKeyToAccount(KEYS.deployer),
  chain: hardhat,
  transport: http(RPC_URL),
});
const orchestratorAddr = privateKeyToAccount(KEYS.orchestrator).address;
const rampAddr = privateKeyToAccount(KEYS.ramp).address;

function artifact(name: string) {
  const p = path.join(ROOT, "contracts/artifacts/contracts/src", `${name}.sol`, `${name}.json`);
  return JSON.parse(readFileSync(p, "utf8"));
}

async function deploy(name: string, args: any[]): Promise<`0x${string}`> {
  const { abi, bytecode } = artifact(name);
  const hash = await deployer.deployContract({ abi, bytecode, args });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error(`deploy failed: ${name}`);
  console.log(`${name.padEnd(14)} ${receipt.contractAddress}`);
  return receipt.contractAddress;
}

async function call(address: `0x${string}`, name: string, functionName: string, args: any[]) {
  const { abi } = artifact(name);
  const { request } = await publicClient.simulateContract({
    account: deployer.account,
    address,
    abi,
    functionName,
    args,
  });
  const hash = await deployer.writeContract(request);
  await publicClient.waitForTransactionReceipt({ hash });
}

const DAILY_CAP_EUR = parseUnits("2500", 18);
const EURUSD_RATE = 1_080_000n; // 1 EURe (1e18) -> 1.08 USDC (6dp)
const SWAP_INVENTORY_USDC = parseUnits("1000000", 6);

async function main() {
  const eure = await deploy("MockToken", ["Monerium EUR emoney (mock)", "EURe", 18]);
  const usdc = await deploy("MockToken", ["USD Coin (mock)", "USDC", 6]);
  const vault = await deploy("RemitVault", [eure, DAILY_CAP_EUR]);
  const swapper = await deploy("FxSwapper", [eure, usdc, EURUSD_RATE]);
  const bridge = await deploy("BridgeEscrow", [usdc]);

  await call(vault, "RemitVault", "setRamp", [rampAddr, true]);
  await call(vault, "RemitVault", "setOrchestrator", [orchestratorAddr, true]);
  await call(bridge, "BridgeEscrow", "setOrchestrator", [orchestratorAddr, true]);
  await call(usdc, "MockToken", "mint", [swapper, SWAP_INVENTORY_USDC]);

  const out = { eure, usdc, vault, swapper, bridge };
  writeFileSync(path.join(ROOT, "deployments.json"), JSON.stringify(out, null, 2));
  console.log("\nroles wired, swapper seeded with 1,000,000 USDC");
  console.log("wrote deployments.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
