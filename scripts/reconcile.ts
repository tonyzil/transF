/**
 * Reconcile the local vault ledger against Monerium's, and check the chain's
 * own invariants. Reports drift; never repairs it.
 *
 * Needs the chain running (the API need not be). With Monerium credentials in
 * .env it also compares against the real sandbox ledger; without them it
 * checks the on-chain invariants only.
 *
 * Run: npm run reconcile
 */
import { initStore } from "../services/api/src/store.js";
import { formatReport, reconcile } from "../services/api/src/reconcile.js";

initStore();
const report = await reconcile();
console.log(formatReport(report));
process.exit(report.ok ? 0 : 1);
