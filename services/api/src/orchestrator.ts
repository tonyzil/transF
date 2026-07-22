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
import { store, type Transfer, type User } from "./store.js";
import { redeemToIban } from "./adapters/monerium-sandbox.js";
import { simulateSepaDeposit } from "./adapters/monerium.js";
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
  getPickup,
} from "./adapters/moneygram.js";
import { anchorModeEnabled, SECURITY } from "./config.js";
import { creditVpa } from "./adapters/upi.js";

const MAX_SLIPPAGE_BPS = 30n;

/** Test hook: FORCE_FAIL_STEP=<step> makes the orchestrator throw right
 *  after that step commits — used to exercise the compensation path. */
const failpoint = (step: string) => {
  if (process.env.FORCE_FAIL_STEP === step) throw new Error(`forced failure after ${step}`);
};

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

export async function executeTransfer(transfer: Transfer, user: User): Promise<Transfer> {
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
      args: [user.address, sendWei, orchestratorAddress, tid],
    });
    txs.push({ step: "vault.debit", hash: debitHash });
    store.updateTransfer(transfer.id, { state: "DEBITED", txs });
    failpoint("vault.debit");

    // 2. Swap the convertible portion (send - fixed fee) EURe -> USDC.
    //    The fixed fee stays at the orchestrator address as revenue.
    const convertibleWei = eur.toWei(transfer.sendEur - FX.FIXED_FEE_EUR);
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

    // 3. Lock USDC in the bridge escrow for the Stellar payout leg.
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
    store.updateTransfer(transfer.id, { state: "BRIDGED", txs });
    failpoint("bridge.lockForPayout");

    // 4. Create the cash pickup at the quoted amount — a real SEP-24 anchor
    //    withdrawal when an anchor is configured, the mock otherwise.
    let pickup;
    if (anchorModeEnabled()) {
      try {
        pickup = await createCashPickupViaAnchor(
          transfer.id,
          transfer.receiveKes,
          transfer.recipientName,
          transfer.recipientPhone ?? "",
        );
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
    return store.updateTransfer(transfer.id, {
      state: "PAYOUT_READY",
      pickup: {
        referenceCode: pickup.referenceCode,
        provider: pickup.provider,
        status: pickup.status,
        interactiveUrl: pickup.interactiveUrl,
      },
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
export async function executeUpiTransfer(transfer: Transfer, user: User): Promise<Transfer> {
  const a = addrs();
  const tid = transferIdHash(transfer.id);
  const txs = transfer.txs;

  try {
    const sendWei = eur.toWei(transfer.sendEur);
    const debitHash = await writeAndWait(orchestratorWallet, {
      address: a.vault,
      abi: abis.RemitVault,
      functionName: "debit",
      args: [user.address, sendWei, orchestratorAddress, tid],
    });
    txs.push({ step: "vault.debit", hash: debitHash });
    store.updateTransfer(transfer.id, { state: "DEBITED", txs });
    failpoint("vault.debit");

    // Swap the convertible portion to USDC — the settlement asset we net
    // against the partner's INR float.
    const convertibleWei = eur.toWei(transfer.sendEur - FX.UPI_FIXED_FEE_EUR);
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
export async function executeSepaTransfer(transfer: Transfer, user: User): Promise<Transfer> {
  const a = addrs();
  const tid = transferIdHash(transfer.id);
  const txs = transfer.txs;

  try {
    const sendWei = eur.toWei(transfer.sendEur);
    const debitHash = await writeAndWait(orchestratorWallet, {
      address: a.vault,
      abi: abis.RemitVault,
      functionName: "debit",
      args: [user.address, sendWei, orchestratorAddress, tid],
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
  if (transfer.state !== "PAYOUT_READY") {
    throw new Error(`transfer is ${transfer.state}, expected PAYOUT_READY`);
  }
  const pickup = completePickup(transfer.id);
  const settleHash = await writeAndWait(orchestratorWallet, {
    address: addrs().bridge,
    abi: abis.BridgeEscrow,
    functionName: "settle",
    args: [transferIdHash(transfer.id)],
  });
  const txs = [...transfer.txs, { step: "bridge.settle", hash: settleHash }];
  const stored = pickup ?? transfer.pickup!;
  return store.updateTransfer(transfer.id, {
    state: "PAID",
    txs,
    pickup: { ...stored, status: "PAID" },
  });
}

export function pickupStatus(transferId: string) {
  return getPickup(transferId);
}
