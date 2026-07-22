/**
 * CCTP bridge worker: Base Sepolia -> Stellar testnet (native USDC burn/mint).
 *
 * Circle-native path, no third-party bridge:
 *   1. depositForBurnWithHook on Base Sepolia's TokenMessengerV2
 *      (destination domain 27). Per Circle's Stellar integration rules,
 *      mintRecipient AND destinationCaller are the CctpForwarder contract;
 *      the real recipient rides in the hook data as a Stellar strkey.
 *   2. Poll Iris (sandbox) for the signed attestation.
 *   3. Call mint_and_forward on the CctpForwarder (Soroban) — validates the
 *      message, mints USDC (scaled 6dp -> 7dp), forwards to the recipient.
 *
 * Dry-run by default: builds the exact calldata/plan without sending.
 * faucet.circle.com) executes burn, attestation polling, and Stellar
 * mint_and_forward for real.
 */
import { createPublicClient, createWalletClient, encodeFunctionData, http, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import {
  Contract,
  Keypair,
  rpc,
  StrKey,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { CCTP, STELLAR } from "../config.js";

const TOKEN_MESSENGER_ABI = [
  {
    type: "function",
    name: "depositForBurnWithHook",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "destinationDomain", type: "uint32" },
      { name: "mintRecipient", type: "bytes32" },
      { name: "burnToken", type: "address" },
      { name: "destinationCaller", type: "bytes32" },
      { name: "maxFee", type: "uint256" },
      { name: "minFinalityThreshold", type: "uint32" },
      { name: "hookData", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

const ERC20_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

/** Stellar contract strkey (C...) -> 0x-prefixed bytes32. */
export function strkeyToBytes32(strkey: string): `0x${string}` {
  const raw = StrKey.decodeContract(strkey); // 32 bytes
  return toHex(Buffer.from(raw)) as `0x${string}`;
}

/**
 * Hook payload per Circle's Stellar spec:
 * bytes 0-23 reserved zeros · 24-27 version (0) · 28-31 recipient strkey
 * length · 32+ the strkey ASCII bytes (G, C or M account).
 */
export function buildStellarHookData(recipientStrkey: string): `0x${string}` {
  const key = Buffer.from(recipientStrkey, "ascii");
  const buf = Buffer.alloc(32 + key.length);
  buf.writeUInt32BE(0, 24); // version
  buf.writeUInt32BE(key.length, 28);
  key.copy(buf, 32);
  return toHex(buf) as `0x${string}`;
}

export interface CctpPlan {
  mode: "dry-run" | "live";
  amountUsdc: number;
  recipientStellar: string;
  approveTx: { to: `0x${string}`; data: `0x${string}` };
  burnTx: { to: `0x${string}`; data: `0x${string}` };
  irisPollUrl: string; // + tx hash appended once burned
  stellarMint: { contract: string; method: "mint_and_forward"; args: "message + attestation" };
  approveTxHash?: `0x${string}`;
  burnTxHash?: `0x${string}`;
  attestation?: { message: string; attestation: string };
  stellarMintTxHash?: string;
}

export class CctpBridgeError extends Error {
  constructor(message: string, public readonly plan: CctpPlan) {
    super(message);
  }
}

/** Build the full bridge plan (and execute legs 1-2 when live). */
export async function bridgeUsdcToStellar(
  amountUsdc: number,
  recipientStellar: string,
): Promise<CctpPlan> {
  const units = BigInt(Math.round(amountUsdc * 1e6));
  const forwarder32 = strkeyToBytes32(CCTP.stellarForwarder);
  const hookData = buildStellarHookData(recipientStellar);

  const approveData = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "approve",
    args: [CCTP.tokenMessenger, units],
  });
  const burnData = encodeFunctionData({
    abi: TOKEN_MESSENGER_ABI,
    functionName: "depositForBurnWithHook",
    args: [
      units,
      CCTP.stellarDomain,
      forwarder32, // mintRecipient MUST be the forwarder (Circle rule)
      CCTP.usdc,
      forwarder32, // destinationCaller MUST be the forwarder too
      0n, // maxFee: standard-finality transfer
      2000, // minFinalityThreshold: hard finality
      hookData,
    ],
  });

  const plan: CctpPlan = {
    mode: CCTP.live ? "live" : "dry-run",
    amountUsdc,
    recipientStellar,
    approveTx: { to: CCTP.usdc, data: approveData },
    burnTx: { to: CCTP.tokenMessenger, data: burnData },
    irisPollUrl: `${CCTP.irisBase}/v2/messages/6?transactionHash=`,
    stellarMint: {
      contract: CCTP.stellarForwarder,
      method: "mint_and_forward",
      args: "message + attestation",
    },
  };

  if (plan.mode !== "live") return plan;
  if (!CCTP.burnerKey) throw new Error("CCTP_LIVE=1 requires CCTP_BURNER_KEY");
  if (!STELLAR.treasurySecret) throw new Error("CCTP_LIVE=1 requires STELLAR_TREASURY_SECRET to submit mint_and_forward");

  // ---- live execution (legs 1 + 2) ----
  const account = privateKeyToAccount(CCTP.burnerKey as `0x${string}`);
  const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(CCTP.baseRpc) });
  const pub = createPublicClient({ chain: baseSepolia, transport: http(CCTP.baseRpc) });

  const approveHash = await wallet.sendTransaction({ to: plan.approveTx.to, data: plan.approveTx.data });
  const approveReceipt = await pub.waitForTransactionReceipt({ hash: approveHash });
  if (approveReceipt.status !== "success") throw new Error("CCTP USDC approval reverted");
  plan.approveTxHash = approveHash;
  const burnHash = await wallet.sendTransaction({ to: plan.burnTx.to, data: plan.burnTx.data });
  const receipt = await pub.waitForTransactionReceipt({ hash: burnHash });
  if (receipt.status !== "success") throw new Error("CCTP burn reverted");
  plan.burnTxHash = burnHash;

  try {
    plan.attestation = await pollIris(burnHash);
    plan.stellarMintTxHash = await mintCctpToStellar(plan.attestation, (hash) => {
      plan.stellarMintTxHash = hash;
    });
  } catch (err: any) {
    throw new CctpBridgeError(err?.message ?? String(err), plan);
  }
  return plan;
}

function hexBytes(value: string): xdr.ScVal {
  const hex = value.startsWith("0x") ? value.slice(2) : value;
  return xdr.ScVal.scvBytes(Buffer.from(hex, "hex"));
}

/**
 * Complete the Stellar side of a Base -> Stellar CCTP transfer. Circle's
 * Stellar forwarder takes the raw CCTP message and Iris attestation bytes.
 */
export async function mintCctpToStellar(
  attestation: { message: string; attestation: string },
  onSubmitted?: (hash: string) => void,
): Promise<string> {
  if (!STELLAR.treasurySecret) throw new Error("STELLAR_TREASURY_SECRET required for Stellar CCTP mint");
  const signer = Keypair.fromSecret(STELLAR.treasurySecret);
  const server = new rpc.Server(STELLAR.sorobanRpc);
  const account = await server.getAccount(signer.publicKey());
  const contract = new Contract(CCTP.stellarForwarder);
  const tx = new TransactionBuilder(account, {
    fee: "10000000",
    networkPassphrase: STELLAR.networkPassphrase,
  })
    .addOperation(contract.call("mint_and_forward", hexBytes(attestation.message), hexBytes(attestation.attestation)))
    .setTimeout(120)
    .build();

  const simulated = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulated)) {
    throw new Error(`CCTP Stellar mint simulation failed: ${JSON.stringify(simulated)}`);
  }
  const prepared = rpc.assembleTransaction(tx, simulated).build();
  prepared.sign(signer);

  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") throw new Error(`CCTP Stellar mint send failed: ${JSON.stringify(sent)}`);
  onSubmitted?.(sent.hash);

  let result = await server.getTransaction(sent.hash);
  while (result.status === "NOT_FOUND") {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    result = await server.getTransaction(sent.hash);
  }
  if (result.status !== "SUCCESS") throw new Error(`CCTP Stellar mint failed: ${JSON.stringify(result)}`);
  return sent.hash;
}

/** Poll Iris (sandbox) until the attestation for a burn tx is complete. */
export async function pollIris(
  burnTxHash: `0x${string}`,
  timeoutMs = 5 * 60_000,
): Promise<{ message: string; attestation: string }> {
  const url = `${CCTP.irisBase}/v2/messages/6?transactionHash=${burnTxHash}`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const data = (await res.json()) as { messages?: Array<{ message: string; attestation: string; status: string }> };
        const msg = data.messages?.[0];
        if (msg && msg.status === "complete" && msg.attestation !== "PENDING") {
          return { message: msg.message, attestation: msg.attestation };
        }
      }
    } catch {
      // transient — keep polling
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  throw new Error(`Iris attestation timed out for ${burnTxHash}`);
}
