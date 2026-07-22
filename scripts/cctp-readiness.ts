/**
 * Live CCTP readiness check. This does not move funds; it validates that a
 * Base Sepolia burner and Stellar treasury are configured before CCTP_LIVE=1.
 *
 * Run: npm run cctp:readiness [amountUsdc]
 */
import { createPublicClient, formatEther, formatUnits, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { Keypair, rpc, StrKey } from "@stellar/stellar-sdk";
import { CCTP, STELLAR } from "../services/api/src/config.js";

const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const amount = Number(process.argv[2] ?? 25);
const units = BigInt(Math.round(amount * 1e6));
const failures: string[] = [];

function check(label: string, ok: boolean, detail: string) {
  console.log(`${ok ? "ok " : "NO "} ${label}: ${detail}`);
  if (!ok) failures.push(label);
}

console.log(`CCTP live readiness for ${amount} USDC: Base Sepolia -> Stellar testnet\n`);

check("CCTP_BURNER_KEY", Boolean(CCTP.burnerKey), CCTP.burnerKey ? "configured" : "missing");
check("STELLAR_TREASURY_SECRET", Boolean(STELLAR.treasurySecret), STELLAR.treasurySecret ? "configured" : "missing");

try {
  StrKey.decodeContract(CCTP.stellarForwarder);
  check("CCTP_STELLAR_FORWARDER", true, CCTP.stellarForwarder);
} catch (err: any) {
  check("CCTP_STELLAR_FORWARDER", false, err?.message ?? String(err));
}

try {
  StrKey.decodeContract(CCTP.stellarMessageTransmitter);
  check("CCTP_STELLAR_MSG_TRANSMITTER", true, CCTP.stellarMessageTransmitter);
} catch (err: any) {
  check("CCTP_STELLAR_MSG_TRANSMITTER", false, err?.message ?? String(err));
}

if (CCTP.burnerKey) {
  const account = privateKeyToAccount(CCTP.burnerKey);
  const client = createPublicClient({ chain: baseSepolia, transport: http(CCTP.baseRpc) });
  const [eth, usdc] = await Promise.all([
    client.getBalance({ address: account.address }),
    client.readContract({
      address: CCTP.usdc,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [account.address],
    }) as Promise<bigint>,
  ]);
  check("Base Sepolia ETH", eth > 0n, `${formatEther(eth)} ETH at ${account.address}`);
  check("Base Sepolia USDC", usdc >= units, `${formatUnits(usdc, 6)} USDC at ${account.address}`);
}

if (STELLAR.treasurySecret) {
  try {
    const server = new rpc.Server(STELLAR.sorobanRpc);
    const latest = await server.getLatestLedger();
    const treasury = Keypair.fromSecret(STELLAR.treasurySecret).publicKey();
    await server.getAccount(treasury);
    check("Soroban RPC", true, `${STELLAR.sorobanRpc} latest ledger ${latest.sequence}`);
    check("Stellar treasury account", true, treasury);
  } catch (err: any) {
    check("Stellar treasury/Soroban", false, err?.message ?? String(err));
  }
}

if (failures.length) {
  console.error(`\nCCTP READINESS FAILED — missing/invalid: ${failures.join(", ")}`);
  process.exit(1);
}

console.log("\nCCTP READINESS PASSED — live burn/mint prerequisites are present");
