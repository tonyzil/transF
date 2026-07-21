/**
 * MoneyGram Ramps adapter (mock mode).
 *
 * Production shape: SEP-10 auth + SEP-24 withdrawal on Stellar — we bridge
 * USDC from Base to Stellar, initiate a withdrawal, and MoneyGram returns a
 * reference code the recipient presents at any agent location for cash.
 * Here we mock the API surface the orchestrator codes against.
 */
import { randomBytes } from "node:crypto";
import { STELLAR, anchorModeEnabled } from "../config.js";
import { getTreasury, sep10Auth, sep24InitiateWithdraw } from "../stellar/anchor.js";

export interface CashPickup {
  referenceCode: string;
  provider: string;
  status: "READY_FOR_PICKUP" | "PAID";
  payoutKes: number;
  recipientName: string;
  recipientPhone: string;
  interactiveUrl?: string;
}

const pickups = new Map<string, CashPickup>(); // transferId -> pickup

export function createCashPickup(
  transferId: string,
  payoutKes: number,
  recipientName: string,
  recipientPhone: string,
): CashPickup {
  const referenceCode = randomBytes(4).readUInt32BE(0).toString().padStart(8, "0").slice(0, 8);
  const pickup: CashPickup = {
    referenceCode,
    provider: "moneygram-mock",
    status: "READY_FOR_PICKUP",
    payoutKes,
    recipientName,
    recipientPhone,
  };
  pickups.set(transferId, pickup);
  return pickup;
}

export function getPickup(transferId: string): CashPickup | undefined {
  return pickups.get(transferId);
}

/** Simulate the recipient collecting cash at an agent (mock mode). */
export function completePickup(transferId: string): CashPickup | undefined {
  const p = pickups.get(transferId);
  if (p) p.status = "PAID";
  return p;
}

/**
 * Anchor mode: real SEP-10 auth + SEP-24 interactive withdrawal against the
 * configured anchor home domain (Stellar test anchor by default; MoneyGram's
 * domain in production). Returns the anchor's transaction id as the pickup
 * reference plus the interactive URL the recipient completes.
 */
export async function createCashPickupViaAnchor(
  transferId: string,
  payoutKes: number,
  recipientName: string,
  recipientPhone: string,
): Promise<CashPickup> {
  if (!anchorModeEnabled()) throw new Error("anchor mode not configured");
  const treasury = await getTreasury();
  const jwt = await sep10Auth(STELLAR.anchorDomain, treasury);
  const wd = await sep24InitiateWithdraw(
    STELLAR.anchorDomain,
    jwt,
    STELLAR.anchorAsset,
    treasury.publicKey(),
  );
  const pickup: CashPickup = {
    referenceCode: wd.id.replace(/-/g, "").slice(0, 8).toUpperCase(),
    provider: `anchor:${STELLAR.anchorDomain}`,
    status: "READY_FOR_PICKUP",
    payoutKes,
    recipientName,
    recipientPhone,
    interactiveUrl: wd.url,
  };
  pickups.set(transferId, pickup);
  return pickup;
}
