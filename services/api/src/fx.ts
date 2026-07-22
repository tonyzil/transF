import { randomUUID } from "node:crypto";
import { FX } from "./config.js";
import { store, type Quote } from "./store.js";

import type { PayoutRail } from "./store.js";

/**
 * Quote engine.
 * - cash (EUR -> KES): mid (EURUSD * USDKES) minus our spread, plus a fixed
 *   fee. On-chain leg swaps EURe->USDC; MoneyGram handles USD->KES at payout.
 * - sepa (EUR -> EUR bank): no FX — fixed fee only; payout via Monerium
 *   redeem order (EURe burned, SEPA transfer out).
 */
export interface QuoteRequest {
  rail: PayoutRail;
  sendEur?: number; // cash + sepa: sender-fixed
  receiveInr?: number; // upi: recipient-fixed (the amount on the merchant QR)
}

export function createQuote(userId: string, req: QuoteRequest): Quote {
  const base = {
    id: randomUUID(),
    userId,
    rail: req.rail,
    status: "OPEN" as const,
    receiveKes: 0,
    receiveEur: 0,
    receiveInr: 0,
    expiresAt: new Date(Date.now() + FX.QUOTE_TTL_MS).toISOString(),
    createdAt: new Date().toISOString(),
  };

  let quote: Quote;
  if (req.rail === "upi") {
    // Two quote modes: INR-fixed (merchant QR states the bill — compute the
    // EUR the sender pays) or EUR-fixed (sender picks what to send — compute
    // what arrives), used by the destination-first send flow.
    const mid = FX.EURUSD_MID * FX.USDINR_MID;
    const allIn = mid * (1 - FX.SPREAD_BPS / 10_000);
    let sendEur: number;
    let receiveInr: number;
    if (req.receiveInr && req.receiveInr > 0) {
      receiveInr = req.receiveInr;
      sendEur = round(receiveInr / allIn + FX.UPI_FIXED_FEE_EUR, 2);
    } else if (req.sendEur && req.sendEur > FX.UPI_FIXED_FEE_EUR) {
      sendEur = req.sendEur;
      receiveInr = round((sendEur - FX.UPI_FIXED_FEE_EUR) * allIn, 2);
    } else {
      throw new Error("receiveInr or sendEur required for upi quotes");
    }
    quote = {
      ...base,
      sendEur,
      fixedFeeEur: FX.UPI_FIXED_FEE_EUR,
      midRate: round(mid, 4),
      fxRate: round(allIn, 4),
      receiveInr,
    };
  } else {
    const sendEur = req.sendEur ?? 0;
    const convertible = sendEur - FX.FIXED_FEE_EUR;
    if (convertible <= 0) throw new Error("amount below fixed fee");
    if (req.rail === "sepa") {
      quote = {
        ...base,
        sendEur,
        fixedFeeEur: FX.FIXED_FEE_EUR,
        midRate: 1,
        fxRate: 1,
        receiveEur: round(convertible, 2),
      };
    } else {
      const mid = FX.EURUSD_MID * FX.USDKES_MID;
      const allIn = mid * (1 - FX.SPREAD_BPS / 10_000);
      quote = {
        ...base,
        sendEur,
        fixedFeeEur: FX.FIXED_FEE_EUR,
        midRate: round(mid, 4),
        fxRate: round(allIn, 4),
        receiveKes: round(convertible * allIn, 2),
      };
    }
  }
  store.addQuote(quote);
  return quote;
}

export function isExpired(q: Quote): boolean {
  return Date.now() > Date.parse(q.expiresAt);
}

function round(x: number, dp: number) {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}
