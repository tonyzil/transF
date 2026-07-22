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
import {
  getTreasury,
  sep10Auth,
  sep24GetTransaction,
  sep24InitiateWithdraw,
  sendSep24WithdrawalPayment,
  sep24WithdrawLimits,
} from "../stellar/anchor.js";

export interface CashPickup {
  referenceCode: string;
  provider: string;
  status: "READY_FOR_PICKUP" | "PAID";
  payoutKes: number;
  recipientName: string;
  recipientPhone: string;
  interactiveUrl?: string;
  /** Anchor mode: the anchor's own transaction id, and the asset amount we
   *  asked it to withdraw. `referenceCode` is derived from the id for display
   *  — with real MoneyGram the agent code comes from them, not from us. */
  anchorTransactionId?: string;
  anchorAmount?: number;
  anchorAsset?: string;
  anchorPaymentHash?: string;
  /** Last status the anchor reported, when we have polled it. */
  anchorStatus?: string;
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
  args: {
    /** Amount of the ANCHOR'S asset to withdraw (USDC), not the recipient's
     *  local currency — the anchor does its own FX to cash at the counter. */
    amountAsset: number;
    payoutKes: number;
    recipientName: string;
    recipientPhone: string;
  },
): Promise<CashPickup> {
  if (!anchorModeEnabled()) throw new Error("anchor mode not configured");
  const asset = STELLAR.anchorAsset;
  const domain = STELLAR.anchorDomain;

  // Ask what the anchor accepts before opening a session it cannot honour.
  const limits = await sep24WithdrawLimits(domain, asset);
  if (!limits.enabled) {
    throw new Error(`anchor ${domain} does not support withdrawing ${asset}`);
  }
  if (!(args.amountAsset > 0)) {
    throw new Error(`refusing to withdraw a non-positive amount of ${asset}`);
  }
  if (limits.minAmount !== undefined && args.amountAsset < limits.minAmount) {
    throw new Error(
      `${args.amountAsset} ${asset} is below the anchor's ${limits.minAmount} minimum`,
    );
  }
  if (limits.maxAmount !== undefined && args.amountAsset > limits.maxAmount) {
    throw new Error(
      `${args.amountAsset} ${asset} exceeds the anchor's ${limits.maxAmount} maximum — ` +
        `${domain} caps withdrawals, so a corridor-sized transfer cannot settle here`,
    );
  }

  const treasury = await getTreasury();
  const jwt = await sep10Auth(domain, treasury);
  const wd = await sep24InitiateWithdraw(
    domain,
    jwt,
    asset,
    treasury.publicKey(),
    String(args.amountAsset),
  );
  const pickup: CashPickup = {
    referenceCode: wd.id.replace(/-/g, "").slice(0, 8).toUpperCase(),
    provider: `anchor:${domain}`,
    status: "READY_FOR_PICKUP",
    payoutKes: args.payoutKes,
    recipientName: args.recipientName,
    recipientPhone: args.recipientPhone,
    interactiveUrl: wd.url,
    anchorTransactionId: wd.id,
    anchorAmount: args.amountAsset,
    anchorAsset: asset,
    anchorStatus: wd.status,
  };
  pickups.set(transferId, pickup);
  return pickup;
}

/**
 * Re-read an anchor-backed pickup's status from the anchor. Returns the
 * updated pickup, or undefined when this transfer isn't anchor-backed.
 *
 * Note what this does and doesn't mean: SEP-24 withdrawals only complete once
 * the asset is actually sent to the anchor's account with its memo, and we do
 * not do that yet — so a real anchor will sit at pending_user_transfer_start.
 * Surfacing that truthfully beats reporting a payout that hasn't happened.
 */
export async function refreshAnchorPickup(
  transferId: string,
  existing?: CashPickup,
): Promise<CashPickup | undefined> {
  const pickup = pickups.get(transferId) ?? existing;
  if (!pickup?.anchorTransactionId || !anchorModeEnabled()) return undefined;
  pickups.set(transferId, pickup);
  const treasury = await getTreasury();
  const jwt = await sep10Auth(STELLAR.anchorDomain, treasury);
  const status = await sep24GetTransaction(STELLAR.anchorDomain, jwt, pickup.anchorTransactionId);
  pickup.anchorStatus = status.status;
  if (status.status === "completed") pickup.status = "PAID";
  return pickup;
}

/**
 * If the interactive SEP-24 flow has reached `pending_user_transfer_start`,
 * send the asset to the anchor's on-ledger account and keep polling until the
 * anchor reports completion. When the anchor is still waiting for recipient
 * details, return the refreshed pending pickup without pretending it is paid.
 */
export async function fundAndRefreshAnchorPickup(
  transferId: string,
  existing?: CashPickup,
  pollMs = 2_000,
  timeoutMs = 60_000,
): Promise<CashPickup | undefined> {
  const pickup = await refreshAnchorPickup(transferId, existing);
  if (!pickup?.anchorTransactionId || !pickup.anchorAmount || !pickup.anchorAsset) return pickup;
  if (pickup.anchorStatus === "completed") return pickup;
  if (pickup.anchorStatus && ["error", "expired", "refunded"].includes(pickup.anchorStatus)) {
    throw new Error(`anchor withdrawal ${pickup.anchorTransactionId} is ${pickup.anchorStatus}`);
  }

  const treasury = await getTreasury();
  const jwt = await sep10Auth(STELLAR.anchorDomain, treasury);
  if (!pickup.anchorPaymentHash) {
    try {
      const sent = await sendSep24WithdrawalPayment(
        STELLAR.anchorDomain,
        jwt,
        pickup.anchorTransactionId,
        treasury,
        pickup.anchorAsset,
        pickup.anchorAmount,
      );
      pickup.anchorPaymentHash = sent.hash;
    } catch (err: any) {
      if (String(err?.message ?? err).includes("has not provided a withdrawal account yet")) {
        return pickup;
      }
      throw err;
    }
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await sep24GetTransaction(STELLAR.anchorDomain, jwt, pickup.anchorTransactionId);
    pickup.anchorStatus = status.status;
    if (status.status === "completed") {
      pickup.status = "PAID";
      return pickup;
    }
    if (["error", "expired", "refunded"].includes(status.status)) {
      throw new Error(`anchor withdrawal ${pickup.anchorTransactionId} is ${status.status}`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`anchor withdrawal ${pickup.anchorTransactionId} did not complete in time`);
}
