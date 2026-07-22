/**
 * FP4 device key (browser side).
 *
 * The key that authorizes payments lives here — generated in this browser,
 * stored in localStorage, never sent anywhere. The server learns only the
 * address. RemitVault refuses any debit not signed by this key over the
 * payment's exact terms, so the server (which holds every other key in the
 * system) cannot move a balance on its own.
 *
 * Crypto is vendored @noble/secp256k1 + @noble/hashes (audited, no build
 * step; see /vendor). Signing is RFC6979 deterministic with low-s enforced
 * (canonical: true is the library default), matching the contract's EIP-2
 * check.
 *
 * Stated openly: localStorage is not a secure enclave. The honest upgrade
 * path is wrapping this key with the passkey's PRF extension, or replacing
 * it with a passkey-owned Safe as the authorizer (the contract already
 * accepts EIP-1271 for exactly that reason).
 */
import { keccak_256 } from "./vendor/hashes/sha3.js";
import * as secp from "./vendor/secp256k1.js";

const KEY_SLOT = "zoll-device-key";

const bytesToHex = (b) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const hexToBytes = (h) => {
  const s = h.replace(/^0x/, "");
  return Uint8Array.from({ length: s.length / 2 }, (_, i) => parseInt(s.substr(i * 2, 2), 16));
};
const concat = (...arrs) => {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};

/** One abi.encode word (32 bytes) for the atomic types EIP-712 needs here. */
function word(type, value) {
  if (type === "bytes32") return hexToBytes(value);
  if (type === "address") return concat(new Uint8Array(12), hexToBytes(value));
  if (type === "uint256") {
    const hex = BigInt(value).toString(16).padStart(64, "0");
    return hexToBytes("0x" + hex);
  }
  if (type === "string") return keccak_256(new TextEncoder().encode(value)); // dynamic: hash
  throw new Error(`unsupported EIP-712 type ${type}`);
}

function structHash(typeName, fields, values) {
  const typeString = `${typeName}(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`;
  const encoded = concat(
    keccak_256(new TextEncoder().encode(typeString)),
    ...fields.map((f) => word(f.type, values[f.name])),
  );
  return keccak_256(encoded);
}

/** EIP-712 digest for the flat typed data the API hands back. */
export function eip712Digest(typedData) {
  const d = typedData.domain;
  const domainFields = [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ];
  const domainSep = structHash("EIP712Domain", domainFields, d);
  const messageHash = structHash(
    typedData.primaryType,
    typedData.types[typedData.primaryType],
    typedData.message,
  );
  return keccak_256(concat(Uint8Array.of(0x19, 0x01), domainSep, messageHash));
}

/** The device's private key, minted on first use. */
function ensureKey() {
  let hex = localStorage.getItem(KEY_SLOT);
  if (!hex) {
    let priv;
    do { priv = crypto.getRandomValues(new Uint8Array(32)); } while (!secp.utils.isValidPrivateKey(priv));
    hex = bytesToHex(priv);
    localStorage.setItem(KEY_SLOT, hex);
  }
  return hexToBytes(hex);
}

export function deviceAddress() {
  const pub = secp.getPublicKey(ensureKey(), false); // uncompressed, 65 bytes
  return bytesToHex(keccak_256(pub.slice(1)).slice(12));
}

/** Sign the payment terms; returns r||s||v, the shape ecrecover expects. */
export async function signTypedData(typedData) {
  const digest = eip712Digest(typedData);
  const [sig, recovery] = await secp.sign(digest, ensureKey(), { der: false, recovered: true });
  return bytesToHex(concat(sig, Uint8Array.of(27 + recovery)));
}

// Hand the API to the classic script, which loaded before this module.
if (window.__deviceLibReady) window.__deviceLibReady({ deviceAddress, signTypedData });
