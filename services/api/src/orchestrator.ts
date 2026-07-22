/**
 * Transfer orchestrator — drives one remittance through its on-chain and
 * partner legs, recording every state and tx hash:
 *
 *   CREATED -> DEBITED -> SWAPPED -> BRIDGED -> PAYOUT_READY -> PAID
 *                                                (recipient collects cash)
 *
 * Every leg is idempotent at the contract layer (transferId hash), so a crash
 * mid-flow can be resumed without double-spending. On failure the transfer is
 * marked FAILED; the BridgeEscrow.release() refund path is wired but manual
 * in the MVP.
 */
import { FX, moneriumSandboxEnabled } from "./config.js";
import { Keypair } from "@stellar/stellar-sdk";
import { AnchorPaymentUncertainError } from "./stellar/anchor.js";
import { store, type Transfer, type TransferState, type User } from "./store.js";
import { redeemToIban } from "./adapters/monerium-sandbox.js";
import { simulateSepaDeposit } from "./adapters/monerium.js";
import { bridgeUsdcToStellar, CctpBridgeError, type CctpPlan } from "./bridge/cctp.js";
import {
  abis,
  addrs,
  eur,
  usd,
  orchestratorAddress,
  orchestratorWallet,
  publicClient,
  transferIdHash,
  writeAndWait,
} from "./chain.js";
import {
  createCashPickup,
  createCashPickupViaAnchor,
  completePickup,
  fundAndRefreshAnchorPickup,
  getPickup,
} from "./adapters/moneygram.js";
import { anchorModeEnabled, CCTP, SECURITY, STELLAR } from "./config.js";
import { creditVpa } from "./adapters/upi.js";

const MAX_SLIPPAGE_BPS = 30n;

/**
 * FP4: the user's device signature over this payment's exact terms. The
 * orchestrator cannot produce one — it can only carry it to the vault.
 */
export interface PaymentAuthorization {
  deadline: number;
  signature: `0x${string}`;
}

/**
 * FP5: verify the live on-chain swap rate hasn't drifted past tolerance from
 * the rate the quote assumed. Throws (→ FP3 compensation) if it has, so a
 * transfer never settles at economics the user didn't agree to.
 */
async function assertQuoteRateBinding(transfer: Transfer): Promise<void> {
  const quote = store.findQuote(transfer.quoteId);
  if (!quote?.lockedSwapRate) return; // legacy/sepa quotes: nothing to bind
  const locked = BigInt(quote.lockedSwapRate);
  const live = (await publicClient.readContract({
    address: addrs().swapper,
    abi: abis.FxSwapper,
    functionName: "rate",
    args: [],
  })) as bigint;
  const driftBps = (live > locked ? live - locked : locked - live) * 10_000n / locked;
  if (driftBps > BigInt(FX.QUOTE_BINDING_BPS)) {
    throw new Error(
      `FX rate moved since quote (${driftBps} bps > ${FX.QUOTE_BINDING_BPS} bps cap) — request a new quote`,
    );
  }
}

/** Test hook: FORCE_FAIL_STEP=<step> makes the orchestrator throw right
 *  after that step commits — used to exercise the compensation path. */
const failpoint = (step: string) => {
  if (process.env.FORCE_FAIL_STEP === step) throw new Error(`forced failure after ${step}`);
};

function cctpRecipientStellar(): string {
  const explicit = process.env.CCTP_STELLAR_RECIPIENT;
  if (explicit) return explicit;
  if (STELLAR.treasurySecret) return Keypair.fromSecret(STELLAR.treasurySecret).publicKey();
  if (CCTP.live) throw new Error("CCTP_LIVE=1 requires CCTP_STELLAR_RECIPIENT or STELLAR_TREASURY_SECRET");
  return Keypair.random().publicKey();
}

function recordCctpPlan(txs: Transfer["txs"], plan: CctpPlan) {
  txs.push({ step: `cctp.${plan.mode}.plan`, hash: plan.burnTx.data.slice(0, 66) });
  if (plan.approveTxHash) txs.push({ step: "cctp.approve", hash: plan.approveTxHash });
  if (plan.burnTxHash) txs.push({ step: "cctp.burn", hash: plan.burnTxHash });
  if (plan.attestation) txs.push({ step: "cctp.attestation", hash: plan.attestation.message.slice(0, 66) });
  txs.push({ step: "cctp.mint.prepared", hash: plan.stellarMint.contract });
  if (plan.stellarMintTxHash) txs.push({ step: "cctp.mint_and_forward", hash: plan.stellarMintTxHash });
}

function cashPayoutState(pickup: NonNullable<Transfer["pickup"]>): TransferState {
  if (!pickup.anchorTransactionId) return "PAYOUT_READY";
  if (pickup.status === "PAID" || pickup.anchorStatus === "completed") return "PAID";
  if (pickup.anchorStatus === "pending_user_transfer_complete") return "PAYOUT_READY";
  if (pickup.anchorPaymentHash) return "PAYOUT_FUNDED";
  if (pickup.anchorStatus === "pending_user_transfer_start") return "PAYOUT_FUNDING_PENDING";
  return "PAYOUT_DETAILS_PENDING";
}

/**
 * FP3: mark FAILED, then immediately attempt compensation. The refund the
 * user gets depends on how far the transfer got — costs already incurred
 * (conversion round-trips at the prevailing rate) are itemized, uRamp-style.
 */
async function failAndCompensate(id: string, err: any, txs: Transfer["txs"]): Promise<Transfer> {
  const failed = store.updateTransfer(id, {
    state: "FAILED",
    error: String(err?.shortMessage ?? err?.message ?? err),
    txs,
  });
  if (txs.some((x) => x.step === "cctp.burn")) {
    return store.updateTransfer(id, {
      state: "MANUAL_REVIEW",
      error: `${failed.error}; CCTP burn was submitted, so automatic local refund is unsafe until the burn/mint/anchor state is reconciled`,
      txs,
    });
  }
  try {
    return await compensateTransfer(id);
  } catch (e: any) {
    console.error(`compensation failed for ${id}: ${e?.message ?? e} — will retry on sweep`);
    return failed;
  }
}

/** Walk a failed transfer backwards: release escrow if locked, value the
 *  recovered assets at current rates, re-credit the sender's vault. */
export async function compensateTransfer(id: string): Promise<Transfer> {
  const t = store.findTransfer(id);
  if (!t) throw new Error(`unknown transfer ${id}`);
  if (t.state === "REFUNDED" || t.state === "PAID" || t.refund) return t;
  const user = store.findUser(t.userId);
  if (!user) throw new Error(`unknown user for transfer ${id}`);
  const steps = new Set(t.txs.map((x) => x.step));
  const now = () => new Date().toISOString();

  if (!steps.has("vault.debit")) {
    // Nothing moved — FAILED is the whole story.
    return store.updateTransfer(id, {
      refund: { amountEur: 0, recoveredFrom: "none", deductions: "nothing was debited", at: now() },
    });
  }

  const txs = t.txs;
  if (steps.has("bridge.lockForPayout") && !steps.has("bridge.settle")) {
    const h = await writeAndWait(orchestratorWallet, {
      address: addrs().bridge,
      abi: abis.BridgeEscrow,
      functionName: "release",
      args: [transferIdHash(t.id), orchestratorAddress],
    });
    txs.push({ step: "bridge.release", hash: h });
  }

  let refundEur: number;
  let recoveredFrom: string;
  let deductions = "none";
  const fee = t.rail === "upi" ? FX.UPI_FIXED_FEE_EUR : FX.FIXED_FEE_EUR;
  if (!steps.has("swapper.swapExactIn")) {
    // Still holding the debited EURe in full.
    refundEur = t.sendEur;
    recoveredFrom = "debited EURe";
  } else {
    // Holding the fee remainder (EURe) + the swapped USDC; convert the USDC
    // back at the CURRENT rate — the user bears rate movement, itemized.
    const rate = (await publicClient.readContract({
      address: addrs().swapper,
      abi: abis.FxSwapper,
      functionName: "rate",
      args: [],
    })) as bigint;
    const eurBack = (t.usdcOut ?? 0) / (Number(rate) / 1e6);
    refundEur = Math.floor((fee + eurBack) * 100) / 100;
    recoveredFrom = steps.has("bridge.lockForPayout") ? "released escrow" : "post-swap USDC";
    const lost = Math.max(0, t.sendEur - refundEur);
    if (lost > 0) deductions = `€${lost.toFixed(2)} conversion round-trip at current rate`;
  }

  const { creditHash } = await simulateSepaDeposit(user.address, refundEur, `refund-${t.id}`);
  txs.push({ step: "vault.refundCredit", hash: creditHash });
  console.log(`FP3: refunded €${refundEur} to ${user.name} for transfer ${t.id} (${recoveredFrom})`);
  return store.updateTransfer(id, {
    state: "REFUNDED",
    txs,
    refund: { amountEur: refundEur, recoveredFrom, deductions, at: now() },
  });
}

/** Recovery sweep: compensate FAILED transfers that moved money, and
 *  fail-then-compensate transfers stranded mid-flow (e.g. by a crash). */
export async function sweepStrandedTransfers(): Promise<number> {
  const STALE_MS = 10 * 60_000;
  let n = 0;
  for (const t of [...store.transfers]) {
    try {
      if (t.state === "FAILED" && !t.refund && t.txs.some((x) => x.step === "vault.debit")) {
        await compensateTransfer(t.id);
        n++;
      } else if (
        ["DEBITED", "SWAPPED", "BRIDGED"].includes(t.state) &&
        Date.now() - Date.parse(t.updatedAt) > STALE_MS
      ) {
        store.updateTransfer(t.id, { state: "FAILED", error: "stranded mid-flow — auto-compensating" });
        await compensateTransfer(t.id);
        n++;
      }
    } catch (e: any) {
      console.error(`sweep: compensation failed for ${t.id}: ${e?.message ?? e}`);
    }
  }
  return n;
}

export async function executeTransfer(
  transfer: Transfer,
  user: User,
  auth: PaymentAuthorization,
): Promise<Transfer> {
  const a = addrs();
  const tid = transferIdHash(transfer.id);
  const txs = transfer.txs;

  try {
    // 1. Debit the sender's vault balance (full amount incl. fixed fee);
    //    tokens move to the orchestrator's working address.
    const sendWei = eur.toWei(transfer.sendEur);
    const debitHash = await writeAndWait(orchestratorWallet, {
      address: a.vault,
      abi: abis.RemitVault,
      functionName: "debit",
      args: [user.address, sendWei, orchestratorAddress, tid, BigInt(auth.deadline), auth.signature],
    });
    txs.push({ step: "vault.debit", hash: debitHash });
    store.updateTransfer(transfer.id, { state: "DEBITED", txs });
    failpoint("vault.debit");

    // 2. Swap the convertible portion (send - fixed fee) EURe -> USDC.
    //    The fixed fee stays at the orchestrator address as revenue.
    const convertibleWei = eur.toWei(transfer.sendEur - FX.FIXED_FEE_EUR);
    await assertQuoteRateBinding(transfer);
    const expectedOut = (await publicClient.readContract({
      address: a.swapper,
      abi: abis.FxSwapper,
      functionName: "quoteOut",
      args: [convertibleWei],
    })) as bigint;
    const minOut = (expectedOut * (10_000n - MAX_SLIPPAGE_BPS)) / 10_000n;

    const approveSwapHash = await writeAndWait(orchestratorWallet, {
      address: a.eure,
      abi: abis.MockToken,
      functionName: "approve",
      args: [a.swapper, convertibleWei],
    });
    txs.push({ step: "eure.approve(swapper)", hash: approveSwapHash });

    const swapHash = await writeAndWait(orchestratorWallet, {
      address: a.swapper,
      abi: abis.FxSwapper,
      functionName: "swapExactIn",
      args: [convertibleWei, minOut, orchestratorAddress],
    });
    txs.push({ step: "swapper.swapExactIn", hash: swapHash });
    const usdcOut = usd.fromUnits(expectedOut);
    store.updateTransfer(transfer.id, { state: "SWAPPED", txs, usdcOut });

    // 3. Bridge USDC toward Stellar. In dry-run mode we record the exact CCTP
    //    burn/mint plan and keep the local escrow leg so the no-credential demo
    //    can still complete. With CCTP_LIVE=1, the CCTP worker submits the Base
    //    Sepolia burn and polls Iris; failures after burn go to manual review.
    let cctpPlan: CctpPlan;
    try {
      cctpPlan = await bridgeUsdcToStellar(usd.fromUnits(expectedOut), cctpRecipientStellar());
      recordCctpPlan(txs, cctpPlan);
    } catch (err) {
      if (err instanceof CctpBridgeError) recordCctpPlan(txs, err.plan);
      throw err;
    }

    if (cctpPlan.mode !== "live") {
      const approveBridgeHash = await writeAndWait(orchestratorWallet, {
        address: a.usdc,
        abi: abis.MockToken,
        functionName: "approve",
        args: [a.bridge, expectedOut],
      });
      txs.push({ step: "usdc.approve(bridge)", hash: approveBridgeHash });

      const lockHash = await writeAndWait(orchestratorWallet, {
        address: a.bridge,
        abi: abis.BridgeEscrow,
        functionName: "lockForPayout",
        args: [tid, expectedOut, "stellar", `mgi:${transfer.recipientPhone}`],
      });
      txs.push({ step: "bridge.lockForPayout", hash: lockHash });
    }
    store.updateTransfer(transfer.id, { state: "BRIDGED", txs });
    failpoint(cctpPlan.mode === "live" ? "cctp.burn" : "bridge.lockForPayout");

    // 4. Create the cash pickup at the quoted amount — a real SEP-24 anchor
    //    withdrawal when an anchor is configured, the mock otherwise.
    let pickup;
    if (anchorModeEnabled()) {
      try {
        // The anchor withdraws USDC and does its own FX to cash at the
        // counter — passing the KES figure here would ask it for ~130x the
        // value. usdcOut is what the bridge leg actually holds.
        pickup = await createCashPickupViaAnchor(transfer.id, {
          amountAsset: transfer.usdcOut ?? usd.fromUnits(expectedOut),
          payoutKes: transfer.receiveKes,
          recipientName: transfer.recipientName,
          recipientPhone: transfer.recipientPhone ?? "",
        });
      } catch (err: any) {
        // Fail closed: a failed real payout must not masquerade as success.
        if (!SECURITY.allowMockFallback) {
          return failAndCompensate(
            transfer.id,
            new Error(`anchor payout failed: ${String(err?.message ?? err).slice(0, 200)} (set ALLOW_MOCK_FALLBACK=1 to simulate instead)`),
            txs,
          );
        }
        console.error(`anchor pickup failed, mock fallback allowed: ${err?.message ?? err}`);
      }
    }
    pickup ??= createCashPickup(
      transfer.id,
      transfer.receiveKes,
      transfer.recipientName,
      transfer.recipientPhone ?? "",
    );
    const storedPickup = {
        referenceCode: pickup.referenceCode,
        provider: pickup.provider,
        status: pickup.status,
        interactiveUrl: pickup.interactiveUrl,
        anchorTransactionId: pickup.anchorTransactionId,
        anchorAmount: pickup.anchorAmount,
        anchorAsset: pickup.anchorAsset,
        anchorPaymentHash: pickup.anchorPaymentHash,
        anchorAmountIn: pickup.anchorAmountIn,
        anchorReferenceNumber: pickup.anchorReferenceNumber,
        moreInfoUrl: pickup.moreInfoUrl,
        anchorStatus: pickup.anchorStatus,
      };
    return store.updateTransfer(transfer.id, {
      state: cashPayoutState(storedPickup),
      pickup: storedPickup,
    });
  } catch (err: any) {
    return failAndCompensate(transfer.id, err, txs);
  }
}

/**
 * UPI (India point-of-sale) rail:
 *   CREATED -> DEBITED -> SWAPPED -> PAID
 * Debits the sender's vault, swaps EURe -> USDC on-chain (the USDC is the
 * partner-settlement pool), then the UPI partner credits the recipient VPA
 * from its INR float instantly and returns a UTR. Mock partner for now; the
 * production adapter is a licensed Indian PA/PPI (TerraPay-style API).
 */
export async function executeUpiTransfer(
  transfer: Transfer,
  user: User,
  auth: PaymentAuthorization,
): Promise<Transfer> {
  const a = addrs();
  const tid = transferIdHash(transfer.id);
  const txs = transfer.txs;

  try {
    const sendWei = eur.toWei(transfer.sendEur);
    const debitHash = await writeAndWait(orchestratorWallet, {
      address: a.vault,
      abi: abis.RemitVault,
      functionName: "debit",
      args: [user.address, sendWei, orchestratorAddress, tid, BigInt(auth.deadline), auth.signature],
    });
    txs.push({ step: "vault.debit", hash: debitHash });
    store.updateTransfer(transfer.id, { state: "DEBITED", txs });
    failpoint("vault.debit");

    // Swap the convertible portion to USDC — the settlement asset we net
    // against the partner's INR float.
    const convertibleWei = eur.toWei(transfer.sendEur - FX.UPI_FIXED_FEE_EUR);
    await assertQuoteRateBinding(transfer);
    const expectedOut = (await publicClient.readContract({
      address: a.swapper,
      abi: abis.FxSwapper,
      functionName: "quoteOut",
      args: [convertibleWei],
    })) as bigint;
    const minOut = (expectedOut * (10_000n - MAX_SLIPPAGE_BPS)) / 10_000n;

    const approveHash = await writeAndWait(orchestratorWallet, {
      address: a.eure,
      abi: abis.MockToken,
      functionName: "approve",
      args: [a.swapper, convertibleWei],
    });
    txs.push({ step: "eure.approve(swapper)", hash: approveHash });

    const swapHash = await writeAndWait(orchestratorWallet, {
      address: a.swapper,
      abi: abis.FxSwapper,
      functionName: "swapExactIn",
      args: [convertibleWei, minOut, orchestratorAddress],
    });
    txs.push({ step: "swapper.swapExactIn", hash: swapHash });
    store.updateTransfer(transfer.id, { state: "SWAPPED", txs, usdcOut: usd.fromUnits(expectedOut) });

    // Partner credits the VPA from its INR float — instant on real UPI too.
    const credit = creditVpa(transfer.id, transfer.recipientVpa!, transfer.receiveInr!);
    return store.updateTransfer(transfer.id, {
      state: "PAID",
      upi: { provider: credit.provider, utr: credit.utr, state: credit.state },
    });
  } catch (err: any) {
    return failAndCompensate(transfer.id, err, txs);
  }
}

/**
 * SEPA (bank payout) rail:
 *   CREATED -> DEBITED -> PAYOUT_SUBMITTED -> PAID
 * Debits the sender's vault on the local chain, then places a real Monerium
 * redeem order (EURe burned from the user's Safe, SEPA out to the recipient
 * IBAN). If the real order is rejected — typically because the Safe holds no
 * EURe on the sandbox chain — the payout falls back to a simulated SEPA leg
 * and records why, so the corridor still demos end to end.
 */
export async function executeSepaTransfer(
  transfer: Transfer,
  user: User,
  auth: PaymentAuthorization,
): Promise<Transfer> {
  const a = addrs();
  const tid = transferIdHash(transfer.id);
  const txs = transfer.txs;

  try {
    const sendWei = eur.toWei(transfer.sendEur);
    const debitHash = await writeAndWait(orchestratorWallet, {
      address: a.vault,
      abi: abis.RemitVault,
      functionName: "debit",
      args: [user.address, sendWei, orchestratorAddress, tid, BigInt(auth.deadline), auth.signature],
    });
    txs.push({ step: "vault.debit", hash: debitHash });
    store.updateTransfer(transfer.id, { state: "DEBITED", txs });
    failpoint("vault.debit");

    const payoutEur = transfer.receiveEur ?? transfer.sendEur - FX.FIXED_FEE_EUR;
    const [firstName, ...rest] = transfer.recipientName.trim().split(/\s+/);
    const counterpart = {
      iban: transfer.recipientIban!,
      firstName,
      lastName: rest.join(" ") || firstName,
      country: user.country || "DE",
    };

    if (moneriumSandboxEnabled()) {
      try {
        const order = await redeemToIban(user, payoutEur, counterpart, `Zoll ${transfer.id}`);
        return store.updateTransfer(transfer.id, {
          state: "PAYOUT_SUBMITTED",
          sepa: {
            mode: "sandbox",
            orderId: order.id,
            state: order.meta?.state ?? order.state ?? "placed",
          },
        });
      } catch (err: any) {
        // Fail closed unless simulation fallback is explicitly allowed.
        if (!SECURITY.allowMockFallback) {
          return failAndCompensate(
            transfer.id,
            new Error(`redeem order failed: ${String(err?.message ?? err).slice(0, 200)} (set ALLOW_MOCK_FALLBACK=1 to simulate instead)`),
            txs,
          );
        }
        return store.updateTransfer(transfer.id, {
          state: "PAID",
          sepa: {
            mode: "mock",
            state: "simulated",
            detail: `real redeem unavailable: ${String(err?.message ?? err).slice(0, 180)}`,
          },
        });
      }
    }

    return store.updateTransfer(transfer.id, {
      state: "PAID",
      sepa: { mode: "mock", state: "processed", detail: "simulated SEPA payout" },
    });
  } catch (err: any) {
    return failAndCompensate(transfer.id, err, txs);
  }
}

/** Recipient collected the cash: settle the escrow and close the transfer. */
export async function settlePickup(transfer: Transfer): Promise<Transfer> {
  if (!["PAYOUT_READY", "PAYOUT_FUNDED"].includes(transfer.state)) {
    throw new Error(`transfer is ${transfer.state}, expected PAYOUT_READY/PAYOUT_FUNDED`);
  }
  const txs = [...transfer.txs];
  const steps = new Set(txs.map((x) => x.step));
  if (steps.has("bridge.lockForPayout") && !steps.has("bridge.settle")) {
    const settleHash = await writeAndWait(orchestratorWallet, {
      address: addrs().bridge,
      abi: abis.BridgeEscrow,
      functionName: "settle",
      args: [transferIdHash(transfer.id)],
    });
    txs.push({ step: "bridge.settle", hash: settleHash });
  }
  const pickup = completePickup(transfer.id);
  const stored = pickup ?? transfer.pickup!;
  return store.updateTransfer(transfer.id, {
    state: "PAID",
    txs,
    pickup: { ...stored, status: "PAID" },
  });
}

/** Refresh an anchor-backed cash payout. If the anchor has supplied payment
 * instructions, fund it on-ledger and mark PAID only after anchor completion. */
export async function refreshPayout(transfer: Transfer): Promise<Transfer> {
  if (!["PAYOUT_DETAILS_PENDING", "PAYOUT_FUNDING_PENDING", "PAYOUT_FUNDED", "PAYOUT_READY"].includes(transfer.state)) {
    return transfer;
  }
  if (!transfer.pickup?.anchorTransactionId) return transfer;
  try {
    const pickup = await fundAndRefreshAnchorPickup(
      transfer.id,
      transfer.pickup as any,
      undefined,
      undefined,
      // Persist the payment hash the moment it exists. Without this, a crash
      // during the poll loop below loses the record and the next call pays
      // the anchor a second time.
      (funded) => {
        store.updateTransfer(transfer.id, {
          pickup: { ...transfer.pickup, ...funded },
        });
      },
    );
    if (!pickup) return transfer;
    const updated = store.updateTransfer(transfer.id, {
      state: pickup.status === "PAID" ? "PAYOUT_FUNDED" : cashPayoutState({ ...transfer.pickup, ...pickup }),
      pickup: { ...transfer.pickup, ...pickup },
    });
    if (pickup.status === "PAID") return settlePickup(updated);
    return updated;
  } catch (err: any) {
    // A failure that may have moved money must never auto-refund the sender:
    // that would pay twice. Same reasoning as a submitted CCTP burn.
    const latest = store.findTransfer(transfer.id);
    const maybePaid =
      err instanceof AnchorPaymentUncertainError || !!latest?.pickup?.anchorPaymentHash;
    if (maybePaid) {
      return store.updateTransfer(transfer.id, {
        state: "MANUAL_REVIEW",
        error:
          `anchor settlement unresolved: ${String(err?.message ?? err).slice(0, 200)}; ` +
          `a Stellar payment may already have been sent, so no automatic refund`,
      });
    }
    return failAndCompensate(
      transfer.id,
      new Error(`anchor settlement failed: ${String(err?.message ?? err).slice(0, 200)}`),
      transfer.txs,
    );
  }
}

export function pickupStatus(transferId: string) {
  return getPickup(transferId);
}
