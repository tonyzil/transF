/**
 * Anchor withdrawal tests — live, against the configured anchor (Stellar's
 * public test anchor by default; no signup, no credentials).
 *
 * The cash rail used to open a SEP-24 withdrawal with no amount at all, and
 * the orchestrator passed the recipient's KES figure where the anchor's asset
 * amount belongs — off by the whole exchange rate, masked only because the
 * value was never sent. These check that the amount is real, correct, and
 * validated against what the anchor will actually accept.
 *
 * Run: npm run anchor:test
 */
import assert from "node:assert/strict";
import { Keypair, Networks, WebAuth } from "@stellar/stellar-sdk";
import { STELLAR } from "../services/api/src/config.js";
import {
  getTreasury,
  sep10Auth,
  validateSep10Challenge,
  sep24GetTransaction,
  sep24InitiateWithdraw,
  sendSep24WithdrawalPayment,
  sep24WithdrawLimits,
} from "../services/api/src/stellar/anchor.js";

const domain = STELLAR.anchorDomain || "testanchor.stellar.org";
const asset = STELLAR.anchorAsset || "SRT";

let pass = 0;
const t = async (label: string, fn: () => Promise<void>) => {
  await fn();
  pass++;
  console.log(`  ok  ${label}`);
};

console.log(`anchor: ${domain} · asset: ${asset}\n`);

const treasury = await getTreasury();
const jwt = await sep10Auth(domain, treasury);

console.log("SEP-10:");
await t("auth returns a JWT", async () => {
  assert.ok(jwt.split(".").length === 3, "expected a JWT");
});

await t("challenge validation rejects the wrong home domain", async () => {
  const server = Keypair.random();
  const client = Keypair.random();
  const challenge = WebAuth.buildChallengeTx(
    server,
    client.publicKey(),
    domain,
    300,
    Networks.TESTNET,
    domain,
    "123",
  );
  assert.throws(
    () =>
      validateSep10Challenge(
        challenge,
        server.publicKey(),
        Networks.TESTNET,
        "evil.example",
        `https://${domain}/auth`,
        client.publicKey(),
        "123",
      ),
    /homeDomains|home domain/,
  );
});

await t("challenge validation rejects the wrong signing key", async () => {
  const realServer = Keypair.random();
  const imposterServer = Keypair.random();
  const client = Keypair.random();
  const challenge = WebAuth.buildChallengeTx(
    imposterServer,
    client.publicKey(),
    domain,
    300,
    Networks.TESTNET,
    domain,
    "123",
  );
  assert.throws(
    () =>
      validateSep10Challenge(
        challenge,
        realServer.publicKey(),
        Networks.TESTNET,
        domain,
        `https://${domain}/auth`,
        client.publicKey(),
        "123",
      ),
    /signature|signed|server/i,
  );
});

await t("challenge validation rejects account and memo mismatch", async () => {
  const server = Keypair.random();
  const client = Keypair.random();
  const otherClient = Keypair.random();
  const challenge = WebAuth.buildChallengeTx(
    server,
    client.publicKey(),
    domain,
    300,
    Networks.TESTNET,
    domain,
    "123",
  );
  assert.throws(
    () =>
      validateSep10Challenge(
        challenge,
        server.publicKey(),
        Networks.TESTNET,
        domain,
        `https://${domain}/auth`,
        otherClient.publicKey(),
        "123",
      ),
    /account mismatch/,
  );
  assert.throws(
    () =>
      validateSep10Challenge(
        challenge,
        server.publicKey(),
        Networks.TESTNET,
        domain,
        `https://${domain}/auth`,
        client.publicKey(),
        "456",
      ),
    /memo mismatch/,
  );
});

await t("challenge validation rejects the wrong network passphrase", async () => {
  const server = Keypair.random();
  const client = Keypair.random();
  const challenge = WebAuth.buildChallengeTx(
    server,
    client.publicKey(),
    domain,
    300,
    Networks.TESTNET,
    domain,
    "123",
  );
  assert.throws(
    () =>
      validateSep10Challenge(
        challenge,
        server.publicKey(),
        Networks.PUBLIC,
        domain,
        `https://${domain}/auth`,
        client.publicKey(),
        "123",
      ),
    /signature|signed|sequence|valid/i,
  );
});

await t("custodial auth refuses a non-integer memo", async () => {
  await assert.rejects(() => sep10Auth(domain, treasury, { memo: "user-123" }), /positive integer/);
});

await t("a second auth is served from cache, not a new round trip", async () => {
  const again = await sep10Auth(domain, treasury);
  assert.equal(again, jwt, "JWT should be cached until near expiry");
});

console.log("SEP-24 limits:");
let limits: Awaited<ReturnType<typeof sep24WithdrawLimits>>;
await t("the anchor publishes withdraw limits for our asset", async () => {
  limits = await sep24WithdrawLimits(domain, asset);
  assert.equal(limits.enabled, true, `${asset} withdrawals should be enabled`);
  assert.ok(limits.maxAmount !== undefined, "expected a published max");
  console.log(`      ${asset}: min ${limits.minAmount} · max ${limits.maxAmount}`);
});

await t("an unknown asset reports disabled rather than throwing", async () => {
  const nonsense = await sep24WithdrawLimits(domain, "NOTAREALASSET");
  assert.equal(nonsense.enabled, false);
});

console.log("SEP-24 withdrawal:");
const within = Math.max(limits!.minAmount ?? 1, 1);
let txId = "";
await t(`initiating a withdrawal for ${within} ${asset} carries the amount`, async () => {
  const wd = await sep24InitiateWithdraw(domain, jwt, asset, treasury.publicKey(), String(within));
  assert.ok(wd.id, "anchor returned no transaction id");
  assert.ok(wd.url.startsWith("http"), "anchor returned no interactive url");
  txId = wd.id;
});

await t("the anchor reports the amount we asked for", async () => {
  const status = await sep24GetTransaction(domain, jwt, txId);
  assert.equal(status.id, txId);
  // The anchor echoes the requested amount once the session exists. Some
  // anchors only populate it after the interactive flow, so treat a missing
  // value as "not yet known" rather than a failure — but a WRONG value is a
  // failure, since that is the bug this file exists for.
  const echoed = (status as any).amountIn ?? (status as any).amount_in;
  if (echoed !== undefined && echoed !== null && echoed !== "") {
    assert.equal(Number(echoed), within, "anchor echoed a different amount than requested");
    console.log(`      anchor echoed amount_in ${echoed}`);
  } else {
    console.log("      anchor has not populated amount_in yet (pre-interactive)");
  }
  console.log(`      status: ${status.status}`);
});

await t("on-ledger funding waits for anchor payment instructions", async () => {
  await assert.rejects(
    () => sendSep24WithdrawalPayment(domain, jwt, txId, treasury, asset, within),
    /has not provided a withdrawal account yet/,
  );
});

console.log("guard rails:");
await t("a corridor-sized amount is refused by the max check", async () => {
  const tooBig = (limits!.maxAmount ?? 10) + 100;
  // This is the €100-transfer case: ~108 USDC against a 10-unit cap.
  const { createCashPickupViaAnchor } = await import(
    "../services/api/src/adapters/moneygram.js"
  );
  await assert.rejects(
    () =>
      createCashPickupViaAnchor("anchor-test-toobig", {
        amountAsset: tooBig,
        payoutKes: 13778,
        recipientName: "Joseph Otieno",
        recipientPhone: "+254700000000",
      }),
    /exceeds the anchor's .* maximum/,
    "an over-limit withdrawal must be refused before opening a session",
  );
});

await t("a zero amount is refused", async () => {
  const { createCashPickupViaAnchor } = await import(
    "../services/api/src/adapters/moneygram.js"
  );
  await assert.rejects(
    () =>
      createCashPickupViaAnchor("anchor-test-zero", {
        amountAsset: 0,
        payoutKes: 0,
        recipientName: "X",
        recipientPhone: "+254700000000",
      }),
    /non-positive/,
  );
});

console.log(`\nANCHOR TEST PASSED — ${pass}/${pass}: withdrawals carry a real, validated asset amount`);
console.log(
  `note: ${domain} caps withdrawals at ${limits!.maxAmount} ${asset}, so corridor-sized\n` +
    "      transfers cannot settle there — that is the anchor's limit, not a bug.",
);
