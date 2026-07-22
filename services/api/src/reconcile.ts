/**
 * Ledger reconciler.
 *
 * Money in this system lives in two places that are only kept in step by
 * code: Monerium's ledger (real EURe, minted when a SEPA transfer lands) and
 * the local RemitVault (mock EURe on the settlement chain, credited by our
 * mirroring). ARCHITECTURE.md §6 calls for a reconciler that flags drift
 * between them; until now nothing checked, so a missed webhook, a double
 * credit, or a forged deposit would sit there silently.
 *
 * This reports drift. It deliberately does NOT repair it: every repair is a
 * balance change, and an automated system that quietly mints or burns to make
 * two ledgers agree is a worse problem than the disagreement. A human decides
 * what a discrepancy means.
 *
 * Three classes of finding:
 *
 *  - UNMIRRORED  Monerium processed a deposit we never credited. The user is
 *                owed money. Usually a missed webhook or a poller outage.
 *  - PHANTOM     We credited an order Monerium has no record of. This is what
 *                a forged webhook delivery would have produced before the
 *                receiver stopped trusting request bodies.
 *  - CHAIN       On-chain invariants: the vault's credited total must equal
 *                the sum of user balances, and must be covered by tokens the
 *                vault actually holds.
 */
import { moneriumSandboxEnabled } from "./config.js";
import { store } from "./store.js";
import { abis, addrs, eur, publicClient } from "./chain.js";
import { listProcessedIssueOrders } from "./adapters/monerium-sandbox.js";

export type FindingKind = "UNMIRRORED" | "PHANTOM" | "CHAIN";

export interface Finding {
  kind: FindingKind;
  detail: string;
  /** EUR at stake, where the discrepancy has an amount. */
  amountEur?: number;
  orderId?: string;
  address?: string;
}

export interface ReconcileReport {
  at: string;
  checked: {
    moneriumOrders: number;
    mirroredOrders: number;
    users: number;
  };
  findings: Finding[];
  ok: boolean;
}

/** Compare the two ledgers and the chain's own invariants. */
export async function reconcile(): Promise<ReconcileReport> {
  const findings: Finding[] = [];
  const mirrored = new Set(store.mirroredOrderIds());

  // --- mirror seam: Monerium's deposits vs the ones we credited ------------
  let moneriumOrders: Awaited<ReturnType<typeof listProcessedIssueOrders>> = [];
  if (moneriumSandboxEnabled()) {
    moneriumOrders = await listProcessedIssueOrders();
    const known = new Map(moneriumOrders.map((o) => [o.id, o]));

    for (const order of moneriumOrders) {
      if (mirrored.has(order.id)) continue;
      // Deposits for addresses we don't manage aren't ours to mirror.
      if (!store.findUserByAddress(order.address)) continue;
      findings.push({
        kind: "UNMIRRORED",
        detail: `Monerium processed issue order ${order.id} for ${order.address} but the vault was never credited — the user is owed this`,
        amountEur: Number(order.amount),
        orderId: order.id,
        address: order.address,
      });
    }

    for (const id of mirrored) {
      if (known.has(id)) continue;
      findings.push({
        kind: "PHANTOM",
        detail: `vault was credited for order ${id}, which Monerium has no processed issue order for — credit may be fabricated`,
        orderId: id,
      });
    }
  }

  // --- chain invariants ----------------------------------------------------
  const vault = addrs().vault;
  const [totalCredited, vaultTokens] = (await Promise.all([
    publicClient.readContract({ address: vault, abi: abis.RemitVault, functionName: "totalCredited" }),
    publicClient.readContract({
      address: addrs().eure,
      abi: abis.MockToken,
      functionName: "balanceOf",
      args: [vault],
    }),
  ])) as [bigint, bigint];

  let sumBalances = 0n;
  for (const user of store.users) {
    sumBalances += (await publicClient.readContract({
      address: vault,
      abi: abis.RemitVault,
      functionName: "balanceOf",
      args: [user.address],
    })) as bigint;
  }

  if (sumBalances !== totalCredited) {
    findings.push({
      kind: "CHAIN",
      detail: `vault totalCredited (€${eur.fromWei(totalCredited)}) does not equal the sum of user balances (€${eur.fromWei(sumBalances)}) — a balance exists that no user owns, or vice versa`,
      amountEur: Math.abs(eur.fromWei(totalCredited) - eur.fromWei(sumBalances)),
    });
  }

  if (vaultTokens < totalCredited) {
    findings.push({
      kind: "CHAIN",
      detail: `vault holds €${eur.fromWei(vaultTokens)} of EURe but has credited €${eur.fromWei(totalCredited)} — the ledger is not fully backed`,
      amountEur: eur.fromWei(totalCredited - vaultTokens),
    });
  }

  return {
    at: new Date().toISOString(),
    checked: {
      moneriumOrders: moneriumOrders.length,
      mirroredOrders: mirrored.size,
      users: store.users.length,
    },
    findings,
    ok: findings.length === 0,
  };
}

/** Human-readable report, for the CLI and the periodic log line. */
export function formatReport(r: ReconcileReport): string {
  const head =
    `reconcile ${r.at}: ${r.checked.moneriumOrders} Monerium order(s), ` +
    `${r.checked.mirroredOrders} mirrored, ${r.checked.users} user(s)`;
  if (r.ok) return `${head}\n  ledgers agree`;
  const lines = r.findings.map((f) => {
    const amt = f.amountEur !== undefined ? ` (€${f.amountEur.toFixed(2)})` : "";
    return `  [${f.kind}]${amt} ${f.detail}`;
  });
  return `${head}\n${lines.join("\n")}`;
}
