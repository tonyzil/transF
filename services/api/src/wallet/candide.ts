/**
 * Candide smart wallets (AbstractionKit, Safe-based ERC-4337 accounts).
 *
 * Every user gets a Safe smart account whose address is computed offline and
 * deterministically from their owner key — the same address on every EVM
 * chain. That address is the user's identity everywhere: the local RemitVault
 * ledger, and the address Monerium links the IBAN to.
 *
 * For Monerium to verify ownership of a contract wallet it calls EIP-1271 on
 * the address, so the Safe must actually be deployed on the chain Monerium
 * checks (Sepolia in sandbox). Deployment is gasless via Candide's public
 * bundler + paymaster, triggered on first provisioning.
 */
import {
  SafeMultiChainSigAccountV1 as SafeAccount,
  Erc7677Paymaster,
  getSafeMessageEip712Data,
  type MetaTransaction,
} from "abstractionkit";
import { privateKeyToAccount } from "viem/accounts";

export const CANDIDE = {
  chainId: BigInt(process.env.CANDIDE_CHAIN_ID ?? 11155111),
  bundlerUrl: process.env.CANDIDE_BUNDLER_URL ?? "https://api.candide.dev/public/v3/11155111",
  paymasterUrl: process.env.CANDIDE_PAYMASTER_URL ?? "https://api.candide.dev/public/v3/11155111",
  rpcUrl: process.env.CANDIDE_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com",
};

/** Deterministic Safe address for an owner — offline, no network. */
export function smartAccountFor(ownerAddress: string): SafeAccount {
  return SafeAccount.initializeNewAccount([ownerAddress]);
}

export async function isDeployed(address: string): Promise<boolean> {
  const res = await fetch(CANDIDE.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [address, "latest"] }),
  });
  const { result } = await res.json();
  return typeof result === "string" && result !== "0x";
}

/**
 * Deploy the user's Safe on the Candide-supported chain via a gasless
 * UserOperation (a 0-value self-call; ERC-4337 deploys on first op).
 * Returns the userOp hash. No-op if already deployed.
 */
export async function deploySmartAccount(ownerKey: `0x${string}`): Promise<string | null> {
  const owner = privateKeyToAccount(ownerKey);
  const account = smartAccountFor(owner.address);
  if (await isDeployed(account.accountAddress)) return null;

  const noop: MetaTransaction = { to: account.accountAddress, value: 0n, data: "0x" };
  const userOperation = await account.createUserOperation(
    [noop],
    CANDIDE.rpcUrl,
    CANDIDE.bundlerUrl,
  );

  // Gas sponsorship via Candide's public paymaster.
  const paymaster = new Erc7677Paymaster(CANDIDE.paymasterUrl);
  const sponsored = await paymaster.createPaymasterUserOperation(
    account as any,
    userOperation as any,
    CANDIDE.bundlerUrl,
  );
  const finalOp: any = (sponsored as any).userOperation ?? sponsored;

  finalOp.signature = account.signUserOperation(finalOp, [ownerKey], CANDIDE.chainId);
  const response = await account.sendUserOperation(finalOp, CANDIDE.bundlerUrl);
  await response.included();
  return response.userOperationHash;
}

/**
 * Sign a message the Safe way: the owner signs the EIP-712 SafeMessage
 * envelope over the EIP-191 hash of `message`. A deployed Safe validates
 * this via EIP-1271 (isValidSignature) — which is how Monerium verifies
 * contract-wallet ownership.
 */
export async function signMessageAsSafe(
  ownerKey: `0x${string}`,
  safeAddress: string,
  message: string,
): Promise<`0x${string}`> {
  const owner = privateKeyToAccount(ownerKey);
  const { domain, types, messageValue } = getSafeMessageEip712Data(
    safeAddress as `0x${string}`,
    CANDIDE.chainId,
    message,
  );
  return owner.signTypedData({
    domain: domain as any,
    types: types as any,
    primaryType: "SafeMessage",
    message: messageValue as any,
  });
}
