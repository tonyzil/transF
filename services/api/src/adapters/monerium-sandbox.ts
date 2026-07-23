/**
 * Monerium sandbox integration (real API calls against api.monerium.dev).
 *
 * Activates when MONERIUM_CLIENT_ID/SECRET are set in .env. What it does:
 *
 *  1. Provisioning: for each new user — create (or reuse) a Monerium profile,
 *     link the user's wallet address with a signed ownership declaration, and
 *     request a personal IBAN. IBAN issuance can be async; we poll for it.
 *  2. Deposits: polls Monerium `issue` orders (EURe minted after a SEPA
 *     transfer arrives in sandbox). Each new order for a linked address is
 *     mirrored into the local RemitVault (mint mock EURe + credit), keeping
 *     the settlement chain local while the funding leg is the real sandbox.
 *
 * Webhooks (order.updated / iban.updated) are the production path; polling is
 * used here because local dev has no public URL.
 */
import { MONERIUM } from "../config.js";
import { store, type User } from "../store.js";
import {
  LINK_MESSAGE,
  MoneriumApiError,
  MoneriumClient,
  type MoneriumOrder,
} from "./monerium-client.js";
import { simulateSepaDeposit } from "./monerium.js";
import { deploySmartAccount, isDeployed, signMessageAsSafe } from "../wallet/candide.js";

let client: MoneriumClient | null = null;

function getClient(): MoneriumClient {
  client ??= new MoneriumClient({
    baseUrl: MONERIUM.baseUrl,
    clientId: MONERIUM.clientId,
    clientSecret: MONERIUM.clientSecret,
  });
  return client;
}

/** Auth smoke test — used by scripts/monerium-check.ts and server startup. */
export async function checkConnection() {
  const ctx = await getClient().authContext();
  return ctx;
}

/**
 * Resolve the profile to attach the user's address to.
 * Whitelabel plans can create per-customer profiles; other plans fall back to
 * the app's own (first) profile.
 */
async function resolveProfileId(user: User): Promise<string | undefined> {
  if (MONERIUM.profileId) return MONERIUM.profileId;
  const api = getClient();
  try {
    const created = await api.createProfile("personal", user.name);
    if (created?.id) return created.id;
  } catch {
    // Not a whitelabel plan (or creation rejected) — fall through.
  }
  try {
    const res = await api.profiles();
    const list = Array.isArray(res) ? res : (res?.profiles ?? []);
    return list[0]?.id;
  } catch {
    return undefined;
  }
}

/**
 * Provision Monerium funding for a user: profile -> link address -> IBAN.
 * Mutates the stored user with progress; returns the updated user.
 */
export async function provisionFunding(user: User): Promise<User> {
  const api = getClient();
  try {
    if (!user.privateKey) throw new Error("user has no wallet key to sign with");

    // 1. The Safe must exist on-chain for Monerium's EIP-1271 signature
    //    check — deploy it gaslessly via Candide if it isn't there yet.
    if (!(await isDeployed(user.address))) {
      store.updateUser(user.id, {
        funding: { mode: "sandbox", status: "provisioning", detail: "deploying smart wallet (Sepolia, gasless)" },
      });
      const opHash = await deploySmartAccount(user.privateKey);
      user = store.updateUser(user.id, {
        wallet: { type: "candide-safe", deployed: true, deployOpHash: opHash ?? undefined },
        funding: { mode: "sandbox", status: "provisioning", detail: "linking wallet to Monerium" },
      });
    }

    // 2. Safe-style signature over the ownership declaration (EIP-1271).
    const signature = await signMessageAsSafe(user.privateKey, user.address, LINK_MESSAGE);

    const profileId = await resolveProfileId(user);
    await api.linkAddress({
      address: user.address,
      signature,
      chain: MONERIUM.chain,
      message: LINK_MESSAGE,
      ...(profileId ? { profile: profileId } : {}),
    });

    await api.requestIban(user.address, MONERIUM.chain);

    const iban = await findIban(user.address);
    return store.updateUser(user.id, {
      iban: iban ?? "",
      funding: {
        mode: "sandbox",
        status: iban ? "active" : "iban_pending",
        moneriumProfileId: profileId,
      },
    });
  } catch (err: any) {
    return store.updateUser(user.id, {
      funding: { mode: "sandbox", status: "error", detail: String(err?.message ?? err) },
    });
  }
}

/** Look up the issued IBAN for an address, if any yet. */
export async function findIban(address: string): Promise<string | undefined> {
  const res = await getClient().ibans();
  const list = Array.isArray(res) ? res : (res?.ibans ?? []);
  const hit = list.find(
    (i: any) => String(i.address ?? "").toLowerCase() === address.toLowerCase() && i.iban,
  );
  return hit?.iban;
}

/** Re-check a user whose IBAN was still pending. */
export async function refreshPendingIban(user: User): Promise<User> {
  if (user.funding?.status !== "iban_pending") return user;
  try {
    const iban = await findIban(user.address);
    if (iban) {
      return store.updateUser(user.id, {
        iban,
        funding: { ...user.funding, status: "active" },
      });
    }
  } catch {
    // transient — keep pending
  }
  return user;
}

/** Canonical amount string: same value in the order body and signed message. */
function amountString(amountEur: number): string {
  return amountEur.toFixed(2).replace(/\.?0+$/, "");
}

export interface SepaCounterpart {
  iban: string;
  firstName: string;
  lastName: string;
  country: string;
}

/**
 * Place a real redeem order: burn EURe from the user's Safe on the sandbox
 * chain and pay out via SEPA to the counterpart IBAN. The Safe signs the
 * payment message (EIP-1271), exactly like address linking.
 * Requires the Safe to actually hold EURe on the sandbox chain.
 */
export async function redeemToIban(
  user: User,
  amountEur: number,
  counterpart: SepaCounterpart,
  memo?: string,
): Promise<MoneriumOrder> {
  if (!user.privateKey) throw new Error("user has no wallet key to sign with");
  const amount = amountString(amountEur);
  const iban = counterpart.iban.replace(/\s/g, "").toUpperCase();
  const message = `Send EUR ${amount} to ${iban} at ${new Date().toISOString()}`;
  const signature = await signMessageAsSafe(user.privateKey, user.address, message);
  return getClient().placeOrder({
    address: user.address,
    chain: MONERIUM.chain,
    kind: "redeem",
    amount,
    currency: "eur",
    counterpart: {
      identifier: { standard: "iban", iban },
      details: {
        firstName: counterpart.firstName,
        lastName: counterpart.lastName,
        country: counterpart.country,
      },
    },
    message,
    signature,
    ...(memo ? { memo } : {}),
  });
}

export async function getOrderState(orderId: string): Promise<string> {
  const order = await getClient().getOrder(orderId);
  return order.meta?.state ?? order.state ?? "unknown";
}

function orderList(res: Awaited<ReturnType<MoneriumClient["orders"]>>): MoneriumOrder[] {
  return Array.isArray(res) ? res : (res?.orders ?? []);
}

function isProcessed(o: MoneriumOrder): boolean {
  const state = o.meta?.state ?? o.state;
  return state === "processed";
}

/**
 * What happened to a delivery. The distinction that matters is `unavailable`:
 * it means we could not reach Monerium, not that the order is bad, so the
 * caller must leave the delivery un-consumed and let the sender retry.
 */
export type MirrorOutcome = "mirrored" | "duplicate" | "ignored" | "unavailable";

/**
 * Mirror one order that came from Monerium's own API into the local vault.
 *
 * The caller must have fetched `order` from Monerium — never pass in an
 * object built from a request body. Amount and address are taken from the
 * order, and `markOrderProcessed` makes a repeat a no-op.
 */
async function mirrorOrder(order: MoneriumOrder): Promise<boolean> {
  if (order.kind !== "issue" || !isProcessed(order)) return false;
  if (store.isOrderProcessed(order.id)) return false;
  const user = store.findUserByAddress(order.address);
  if (!user) return false;
  const amount = Number(order.amount);
  if (!(amount > 0)) return false;
  await simulateSepaDeposit(user.address, amount, `monerium:${order.id}`);
  store.markOrderProcessed(order.id);
  console.log(`monerium: mirrored issue order ${order.id} (€${amount}) for ${user.name}`);
  return true;
}

/**
 * Mirror an order named only by id, re-reading it from Monerium first.
 *
 * This is what makes the webhook safe: a caller can name an order but cannot
 * state its amount, its address, or whether it settled — those come from
 * Monerium over an authenticated client-credentials connection. The worst a
 * forged payload achieves is asking us to re-check a real order, which is
 * idempotent.
 */
export async function mirrorOrderById(orderId: string): Promise<MirrorOutcome> {
  if (store.isOrderProcessed(orderId)) return "duplicate";
  let order: MoneriumOrder;
  try {
    order = await getClient().getOrder(orderId);
  } catch (err: any) {
    // A 404 is Monerium telling us this order does not exist — a settled
    // answer. Anything else (5xx, a timeout, DNS) means we simply could not
    // ask, and the caller must be free to try again rather than treat the
    // delivery as spent.
    const status = err instanceof MoneriumApiError ? err.status : 0;
    if (status >= 400 && status < 500) {
      console.warn(`monerium: refusing unknown order ${orderId}: ${err?.message ?? err}`);
      return "ignored";
    }
    console.warn(`monerium: could not read order ${orderId}, will retry: ${err?.message ?? err}`);
    return "unavailable";
  }
  if (order.id !== orderId) return "ignored";
  return (await mirrorOrder(order)) ? "mirrored" : "ignored";
}

/** Every processed `issue` order Monerium knows about — the reconciler's
 *  view of what should have been credited locally. */
export async function listProcessedIssueOrders(): Promise<MoneriumOrder[]> {
  return orderList(await getClient().orders()).filter(
    (o) => o.kind === "issue" && isProcessed(o),
  );
}

/**
 * One poll cycle: mirror new processed `issue` orders into the local vault.
 * Returns the number of deposits credited.
 */
export async function pollDepositsOnce(): Promise<number> {
  const res = await getClient().orders();
  let credited = 0;
  for (const order of orderList(res)) {
    if (await mirrorOrder(order)) credited++;
  }
  return credited;
}

/** Advance transfers whose SEPA redeem order is still in flight. */
export async function pollRedeemOrdersOnce(): Promise<void> {
  const waiting = store.transfers.filter(
    (t) => t.state === "PAYOUT_SUBMITTED" && t.sepa?.mode === "sandbox" && t.sepa.orderId,
  );
  for (const t of waiting) {
    try {
      const state = await getOrderState(t.sepa!.orderId!);
      if (state === "processed") {
        store.updateTransfer(t.id, { state: "PAID", sepa: { ...t.sepa!, state } });
        console.log(`monerium: redeem order ${t.sepa!.orderId} processed (transfer ${t.id})`);
      } else if (state === "rejected" || state === "failed") {
        store.updateTransfer(t.id, {
          state: "FAILED",
          error: `Monerium redeem order ${state}`,
          sepa: { ...t.sepa!, state },
        });
      } else if (state !== t.sepa!.state) {
        store.updateTransfer(t.id, { sepa: { ...t.sepa!, state } });
      }
    } catch {
      // transient — retry next tick
    }
  }
}

export function startDepositPoller() {
  const tick = async () => {
    try {
      await pollDepositsOnce();
      await pollRedeemOrdersOnce();
      for (const u of store.users) {
        if (u.funding?.status === "iban_pending") await refreshPendingIban(u);
      }
    } catch (err: any) {
      console.error(`monerium poll failed: ${err?.message ?? err}`);
    }
  };
  void tick();
  const timer = setInterval(tick, MONERIUM.pollMs);
  timer.unref();
  return timer;
}

/**
 * Webhook receiver (production path — needs a public URL).
 *
 * The body is treated as untrusted: we read an order id out of it and throw
 * the rest away, then re-read that order from Monerium. Previously this
 * endpoint credited whatever address and amount the request stated, which
 * made it an unauthenticated mint for anyone who could reach the port.
 *
 * A shared secret (MONERIUM_WEBHOOK_SECRET) gates it further when set — see
 * verifyWebhookSignature in server.ts. Both controls are worth having: the
 * secret keeps strangers out, the re-read means even a leaked secret cannot
 * fabricate a deposit.
 */
export async function handleWebhookEvent(
  event: any,
): Promise<{ handled: boolean; outcome: MirrorOutcome }> {
  const id = event?.data?.id ?? event?.order?.id ?? event?.id;
  if (!id || typeof id !== "string") return { handled: false, outcome: "ignored" };
  const outcome = await mirrorOrderById(id);
  return { handled: outcome === "mirrored", outcome };
}
