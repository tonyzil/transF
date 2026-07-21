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
import { LINK_MESSAGE, MoneriumClient, type MoneriumOrder } from "./monerium-client.js";
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
 * One poll cycle: mirror new processed `issue` orders into the local vault.
 * Returns the number of deposits credited.
 */
export async function pollDepositsOnce(): Promise<number> {
  const res = await getClient().orders();
  let credited = 0;
  for (const order of orderList(res)) {
    if (order.kind !== "issue" || !isProcessed(order)) continue;
    if (store.isOrderProcessed(order.id)) continue;
    const user = store.findUserByAddress(order.address);
    if (!user) continue;
    const amount = Number(order.amount);
    if (!(amount > 0)) continue;
    await simulateSepaDeposit(user.address, amount, `monerium:${order.id}`);
    store.markOrderProcessed(order.id);
    credited++;
    console.log(`monerium: mirrored issue order ${order.id} (€${amount}) for ${user.name}`);
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
 * Webhook receiver (production path — needs a public URL). Handles
 * order.updated events for processed issue orders; same idempotent mirroring
 * as the poller. NOTE: signature verification is a production TODO.
 */
export async function handleWebhookEvent(event: any): Promise<{ handled: boolean }> {
  const order: MoneriumOrder | undefined = event?.data ?? event?.order;
  if (!order?.id || order.kind !== "issue" || !isProcessed(order)) return { handled: false };
  if (store.isOrderProcessed(order.id)) return { handled: true };
  const user = store.findUserByAddress(order.address);
  if (!user) return { handled: false };
  await simulateSepaDeposit(user.address, Number(order.amount), `monerium:${order.id}`);
  store.markOrderProcessed(order.id);
  return { handled: true };
}
