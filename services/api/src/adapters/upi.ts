/**
 * UPI payout adapter (mock mode).
 *
 * Production shape: a licensed Indian partner (payment aggregator / PPI
 * issuer, e.g. TerraPay-style API) holds a pre-funded INR float and credits
 * the recipient VPA instantly; we net-settle the float in USDC. The partner
 * returns a UTR (Unique Transaction Reference) — the bank-side receipt every
 * UPI credit gets. Here we mock that API surface: instant success + UTR.
 */
import { randomBytes } from "node:crypto";

export interface UpiCredit {
  provider: "upi-partner-mock";
  utr: string; // 12-digit numeric reference, like real UPI UTRs
  vpa: string;
  amountInr: number;
  state: "SUCCESS";
}

const credits = new Map<string, UpiCredit>(); // transferId -> credit

/** Basic VPA sanity: local@handle, e.g. "chaistand@okicici". */
export function isValidVpa(vpa: string): boolean {
  return /^[a-z0-9._-]{2,64}@[a-z0-9]{2,32}$/i.test(vpa.trim());
}

export function creditVpa(transferId: string, vpa: string, amountInr: number): UpiCredit {
  const utr = Array.from(randomBytes(12), (b) => b % 10).join("");
  const credit: UpiCredit = {
    provider: "upi-partner-mock",
    utr,
    vpa: vpa.trim().toLowerCase(),
    amountInr,
    state: "SUCCESS",
  };
  credits.set(transferId, credit);
  return credit;
}

export function getCredit(transferId: string): UpiCredit | undefined {
  return credits.get(transferId);
}
