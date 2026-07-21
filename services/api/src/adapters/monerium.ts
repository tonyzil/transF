/**
 * Monerium adapter (mock mode).
 *
 * Production shape: Monerium's API issues each user a personal IBAN linked to
 * their wallet; a SEPA transfer to it mints EURe on-chain automatically and
 * fires a webhook. Here we mock both halves: IBAN issuance is local, and the
 * "SEPA arrived" webhook is simulated by an endpoint that mints mock EURe to
 * the RemitVault and credits the user's ledger balance.
 */
import { keccak256, toHex } from "viem";
import { abis, addrs, deployerWallet, eur, rampWallet, writeAndWait } from "../chain.js";

/** Deterministic mock IBAN (Iceland format, like Monerium's). */
export function issueIban(userId: string): string {
  const digits = BigInt(keccak256(toHex(`iban:${userId}`)))
    .toString()
    .replace(/\D/g, "")
    .slice(0, 18)
    .padEnd(18, "0");
  return `IS14 0159 ${digits.slice(0, 4)} ${digits.slice(4, 8)} ${digits.slice(8, 12)} ${digits.slice(12, 16)}`;
}

/**
 * Simulate the SEPA-deposit-arrived webhook: mint EURe to the vault, then
 * credit the user's balance. Returns the tx hashes.
 */
export async function simulateSepaDeposit(
  userAddress: `0x${string}`,
  amountEur: number,
  paymentRef: string,
) {
  const a = addrs();
  const wei = eur.toWei(amountEur);

  // MockToken minting is owner-only (the deployer); the credit itself is the
  // ramp role, mirroring the real split between issuer and ramp adapter.
  const mintHash = await writeAndWait(deployerWallet, {
    address: a.eure,
    abi: abis.MockToken,
    functionName: "mint",
    args: [a.vault, wei],
  });

  const creditHash = await writeAndWait(rampWallet, {
    address: a.vault,
    abi: abis.RemitVault,
    functionName: "creditDeposit",
    args: [userAddress, wei, keccak256(toHex(paymentRef))],
  });

  return { mintHash, creditHash };
}
