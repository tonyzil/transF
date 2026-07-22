/**
 * FP4 device-key tests (headless).
 *
 * Covers the parts of services/api/public/device.js that don't need a real
 * authenticator: EIP-712 digest parity with viem, signature recovery, and
 * the passkey-PRF wrapping of the key at rest. The PRF secret is injected
 * directly here — a real authenticator produces it, but the AES-GCM/HKDF
 * envelope it feeds is exactly this code path.
 *
 * What this canNOT prove, and needs a real browser: that the authenticator
 * returns a PRF result at all, and that it returns the SAME 32 bytes across
 * ceremonies (if it didn't, the key would be unrecoverable after reload).
 *
 * Run: npm run fp4:test
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashTypedData, recoverAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Browser globals device.js expects. localStorage is the only real stand-in;
// crypto.subtle and crypto.getRandomValues come from node's WebCrypto.
const slots = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => slots.get(k) ?? null,
  setItem: (k: string, v: string) => slots.set(k, v),
  removeItem: (k: string) => slots.delete(k),
};
(globalThis as any).window = {};
(globalThis as any).btoa = (s: string) => Buffer.from(s, "binary").toString("base64");
(globalThis as any).atob = (s: string) => Buffer.from(s, "base64").toString("binary");

const dev = await import(path.join(ROOT, "services/api/public/device.js"));

let pass = 0;
const t = async (label: string, fn: () => Promise<void> | void) => {
  await fn();
  pass++;
  console.log(`  ok  ${label}`);
};

const TYPED_DATA = {
  domain: {
    name: "RemitVault",
    version: "1",
    chainId: 31337,
    verifyingContract: "0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0",
  },
  types: {
    PaymentAuthorization: [
      { name: "account", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "to", type: "address" },
      { name: "transferId", type: "bytes32" },
      { name: "deadline", type: "uint256" },
    ],
  },
  primaryType: "PaymentAuthorization",
  message: {
    account: "0x1111111111111111111111111111111111111111",
    amount: "100000000000000000000",
    to: "0x2222222222222222222222222222222222222222",
    transferId: `0x${"ab".repeat(32)}`,
    deadline: 1790000000,
  },
} as const;

const viemDigest = hashTypedData({
  ...(TYPED_DATA as any),
  message: { ...TYPED_DATA.message, amount: 100000000000000000000n, deadline: 1790000000n },
});

console.log("EIP-712:");
await t("digest matches viem byte for byte", () => {
  const ours = `0x${Buffer.from(dev.eip712Digest(TYPED_DATA)).toString("hex")}`;
  assert.equal(ours, viemDigest);
});

console.log("device key — unprotected fallback (no PRF authenticator):");
await t("createKey mints a key and reports protection: none", async () => {
  const { address, protection } = await dev.createKey(null);
  assert.equal(protection, "none");
  assert.match(address, /^0x[0-9a-f]{40}$/);
});

await t("signature recovers to the device address", async () => {
  const address = await dev.deviceAddress(null);
  const sig = await dev.signTypedData(TYPED_DATA, null);
  assert.equal((await recoverAddress({ hash: viemDigest, signature: sig })).toLowerCase(), address);
});

await t("address derivation matches viem for the same key", async () => {
  const blob = JSON.parse(slots.get("zoll-device-key")!);
  assert.equal(privateKeyToAccount(blob.key).address.toLowerCase(), (await dev.deviceAddress(null)).toLowerCase());
});

console.log("device key — passkey-wrapped at rest (PRF):");
const PRF_SECRET = new Uint8Array(32).fill(7);
const WRONG_SECRET = new Uint8Array(32).fill(9);

await t("wrap/unwrap round-trips with the same PRF secret", async () => {
  const priv = `0x${"11".repeat(32)}`;
  const blob = await dev.wrapKey(priv, PRF_SECRET);
  assert.equal(blob.protection, "prf");
  assert.equal(await dev.unwrapKey(blob, PRF_SECRET), priv);
});

await t("the wrapped blob does not contain the key", async () => {
  const priv = `0x${"11".repeat(32)}`;
  const blob = await dev.wrapKey(priv, PRF_SECRET);
  assert.ok(!JSON.stringify(blob).includes("11".repeat(32)), "plaintext key leaked into storage blob");
  assert.equal(blob.key, undefined);
});

await t("a different PRF secret cannot unwrap it", async () => {
  const blob = await dev.wrapKey(`0x${"11".repeat(32)}`, PRF_SECRET);
  await assert.rejects(() => dev.unwrapKey(blob, WRONG_SECRET));
});

await t("each wrap uses a fresh IV", async () => {
  const priv = `0x${"11".repeat(32)}`;
  const a = await dev.wrapKey(priv, PRF_SECRET);
  const b = await dev.wrapKey(priv, PRF_SECRET);
  assert.notEqual(a.iv, b.iv, "IV reused across wraps");
  assert.notEqual(a.ct, b.ct, "identical ciphertext implies a fixed IV");
});

await t("a PRF-wrapped key refuses to sign without the passkey", async () => {
  const priv = `0x${"11".repeat(32)}`;
  slots.set("zoll-device-key", JSON.stringify({
    ...(await dev.wrapKey(priv, PRF_SECRET)),
    address: privateKeyToAccount(priv as `0x${string}`).address.toLowerCase(),
  }));
  // No window.PublicKeyCredential here, so prfSecret() returns null — the
  // same path a browser takes when the ceremony is cancelled or unavailable.
  await assert.rejects(
    () => dev.signTypedData(TYPED_DATA, "some-credential-id"),
    /passkey is needed/,
    "a locked key must not sign without the authenticator",
  );
});

await t("the cached address is readable while the key stays locked", async () => {
  const priv = `0x${"11".repeat(32)}`;
  const expected = privateKeyToAccount(priv as `0x${string}`).address.toLowerCase();
  assert.equal(await dev.deviceAddress("some-credential-id"), expected);
});

console.log(`\nFP4 DEVICE-KEY TEST PASSED — ${pass}/${pass}`);
console.log("note: PRF availability and cross-ceremony stability need a real browser");
