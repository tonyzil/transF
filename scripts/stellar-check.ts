/**
 * Live validation of the Stellar/anchor stack — runs against the real Stellar
 * testnet and the configured anchor (Stellar's public test anchor by default;
 * no signup needed). Proves: treasury provisioning (friendbot), SEP-10 auth,
 * SEP-24 interactive withdrawal — the exact protocol MoneyGram Ramps speaks.
 * Run: npm run stellar:check
 */
import { STELLAR } from "../services/api/src/config.js";
import {
  getTreasury,
  sep10Auth,
  sep24GetTransaction,
  sep24InitiateWithdraw,
} from "../services/api/src/stellar/anchor.js";

const domain = STELLAR.anchorDomain || "testanchor.stellar.org";
const asset = STELLAR.anchorAsset || "SRT";
console.log(`anchor: ${domain} · asset: ${asset}\n`);

console.log("1/4 provisioning Stellar treasury (friendbot if new)…");
const treasury = await getTreasury();
console.log(`      account ${treasury.publicKey()}`);

console.log("2/4 SEP-10 web auth (challenge -> sign -> JWT)…");
const jwt = await sep10Auth(domain, treasury);
console.log(`      jwt received (${jwt.slice(0, 24)}…)`);

console.log("3/4 SEP-24 interactive withdrawal…");
const wd = await sep24InitiateWithdraw(domain, jwt, asset, treasury.publicKey());
console.log(`      anchor tx id: ${wd.id}`);
console.log(`      interactive url: ${wd.url.slice(0, 90)}…`);

console.log("4/4 SEP-24 transaction status…");
const status = await sep24GetTransaction(domain, jwt, wd.id);
console.log(`      status: ${status.status}`);

console.log(
  "\nSTELLAR CHECK PASSED — SEP-10 + SEP-24 work end-to-end against a real anchor.\n" +
    "MoneyGram production = MG_ANCHOR_DOMAIN + partner-onboarded account + asset USDC.",
);
