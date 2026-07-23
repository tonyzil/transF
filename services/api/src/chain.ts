import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  toHex,
  parseUnits,
  formatUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hardhat } from "viem/chains";
import { KEYS, RPC_URL, loadAbi, loadDeployments, type Deployments } from "./config.js";
import type { PayoutRail } from "./store.js";

export const publicClient = createPublicClient({ chain: hardhat, transport: http(RPC_URL) });

function wallet(key: `0x${string}`) {
  return createWalletClient({
    account: privateKeyToAccount(key),
    chain: hardhat,
    transport: http(RPC_URL),
  });
}

export const deployerWallet = wallet(KEYS.deployer);
export const orchestratorWallet = wallet(KEYS.orchestrator);
export const rampWallet = wallet(KEYS.ramp);
export const orchestratorAddress = orchestratorWallet.account.address;

export const abis = {
  MockToken: loadAbi("MockToken"),
  RemitVault: loadAbi("RemitVault"),
  FxSwapper: loadAbi("FxSwapper"),
  BridgeEscrow: loadAbi("BridgeEscrow"),
};

let deployments: Deployments | null = null;
export function addrs(): Deployments {
  if (!deployments) deployments = loadDeployments();
  return deployments;
}

export function transferIdHash(id: string): `0x${string}` {
  return keccak256(toHex(id));
}

export const eur = {
  toWei: (amount: number) => parseUnits(amount.toFixed(6), 18),
  fromWei: (wei: bigint) => Number(formatUnits(wei, 18)),
};
export const usd = {
  toUnits: (amount: number) => parseUnits(amount.toFixed(6), 6),
  fromUnits: (units: bigint) => Number(formatUnits(units, 6)),
};

/** Send a tx as `client` and wait for the receipt; throws on revert. */
export async function writeAndWait(
  client: typeof orchestratorWallet,
  args: { address: `0x${string}`; abi: any[]; functionName: string; args: any[] },
) {
  const { request } = await publicClient.simulateContract({
    account: client.account,
    ...args,
  });
  const hash = await client.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`tx reverted: ${args.functionName}`);
  return hash;
}

/**
 * The keccak256 commitment to a payout destination that the device signs.
 *
 * The device authorization fixes the amount and the on-chain `to`, but the
 * money actually leaves the system on a fiat leg (SEPA IBAN, UPI VPA, cash
 * pickup phone) the contract can never see. Folding a hash of that target into
 * the signed struct means the signature attests to *who* is paid: a server
 * that later swaps the recipient produces a payout whose recomputed commitment
 * no longer matches what the user signed, and the vault debit reverts.
 *
 * The preimage is canonical per rail so the browser, the API, and the
 * orchestrator all derive the identical value from the same recipient:
 *   cash → "cash|phone=<phone>"           (trimmed)
 *   sepa → "sepa|iban=<IBAN>"             (whitespace-stripped, upper-cased)
 *   upi  → "upi|vpa=<vpa>"                (trimmed, lower-cased)
 * Keep this in lockstep with destinationCommitment() in public/device.js.
 */
export function destinationCommitment(
  rail: PayoutRail,
  target: { phone?: string; iban?: string; vpa?: string },
): `0x${string}` {
  let preimage: string;
  if (rail === "sepa") {
    preimage = `sepa|iban=${(target.iban ?? "").replace(/\s/g, "").toUpperCase()}`;
  } else if (rail === "upi") {
    preimage = `upi|vpa=${(target.vpa ?? "").trim().toLowerCase()}`;
  } else {
    preimage = `cash|phone=${(target.phone ?? "").trim()}`;
  }
  return keccak256(toHex(preimage));
}

/**
 * FP4: the EIP-712 payload the user's device signs to authorize one payment.
 * Mirrors RemitVault's PaymentAuthorization struct exactly — if these drift,
 * the digest changes and the contract rejects the signature.
 */
export function paymentAuthorizationTypedData(args: {
  account: `0x${string}`;
  amountWei: bigint;
  to: `0x${string}`;
  transferId: `0x${string}`;
  destination: `0x${string}`;
  deadline: number;
}) {
  return {
    domain: {
      name: "RemitVault",
      version: "1",
      chainId: hardhat.id,
      verifyingContract: addrs().vault,
    },
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
    primaryType: "PaymentAuthorization" as const,
    message: {
      account: args.account,
      amount: args.amountWei.toString(),
      to: args.to,
      transferId: args.transferId,
      destination: args.destination,
      deadline: args.deadline,
    },
  };
}

/** Which key may authorize debits from `account` (zero address if unbound). */
export async function vaultAuthorizerOf(account: `0x${string}`): Promise<`0x${string}`> {
  return (await publicClient.readContract({
    address: addrs().vault,
    abi: abis.RemitVault,
    functionName: "authorizerOf",
    args: [account],
  })) as `0x${string}`;
}

/**
 * Bind an account to its device key. Trust-on-first-use via the ramp role:
 * the contract refuses to let us re-point an account that is already bound,
 * so this can only ever establish the first binding.
 */
export async function setVaultAuthorizer(
  account: `0x${string}`,
  authorizer: `0x${string}`,
): Promise<`0x${string}`> {
  return writeAndWait(rampWallet, {
    address: addrs().vault,
    abi: abis.RemitVault,
    functionName: "setAuthorizer",
    args: [account, authorizer],
  });
}

export async function vaultBalance(user: `0x${string}`): Promise<number> {
  const bal = (await publicClient.readContract({
    address: addrs().vault,
    abi: abis.RemitVault,
    functionName: "balanceOf",
    args: [user],
  })) as bigint;
  return eur.fromWei(bal);
}
