/**
 * Self-test for the WebAuthn verifier: fabricates a genuine P-256 credential
 * (node webcrypto), builds real CBOR attestation + assertion payloads the way
 * an authenticator would, and runs them through verifyRegistration /
 * verifyAssertion — including negative cases (bad challenge, tampered
 * signature, cloned-counter). Run: npm run webauthn:selftest
 */
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import {
  issueChallenge,
  verifyRegistration,
  verifyAssertion,
  b64urlToBuf,
  bufToB64url,
} from "../services/api/src/webauthn.js";

const RP_ID = "localhost";
const ORIGIN = "http://localhost:3000";
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest();

// --- minimal CBOR encoder (uint, neg, bstr, tstr, map) ----------------------
function enc(v: any): Buffer {
  const head = (major: number, len: number) => {
    if (len < 24) return Buffer.from([(major << 5) | len]);
    if (len < 256) return Buffer.from([(major << 5) | 24, len]);
    const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(len, 1); return b;
  };
  if (typeof v === "number") {
    return v >= 0 ? head(0, v) : head(1, -1 - v);
  }
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
    const b = Buffer.from(v); return Buffer.concat([head(2, b.length), b]);
  }
  if (typeof v === "string") {
    const b = Buffer.from(v, "utf8"); return Buffer.concat([head(3, b.length), b]);
  }
  if (v instanceof Map) {
    const parts: Buffer[] = [head(5, v.size)];
    for (const [k, val] of v) parts.push(enc(k), enc(val));
    return Buffer.concat(parts);
  }
  throw new Error("enc: unsupported");
}

// raw r||s -> DER (what real authenticators emit)
function rawToDer(raw: Buffer): Buffer {
  const int = (b: Buffer) => {
    let v = b; while (v.length > 1 && v[0] === 0) v = v.subarray(1);
    if (v[0] & 0x80) v = Buffer.concat([Buffer.from([0]), v]);
    return Buffer.concat([Buffer.from([0x02, v.length]), v]);
  };
  const r = int(raw.subarray(0, 32));
  const s = int(raw.subarray(32));
  return Buffer.concat([Buffer.from([0x30, r.length + s.length]), r, s]);
}

function authDataBytes(flags: number, count: number, credId?: Buffer, coseKey?: Buffer): Buffer {
  const base = Buffer.alloc(37);
  sha256(RP_ID).copy(base, 0);
  base[32] = flags;
  base.writeUInt32BE(count, 33);
  if (credId && coseKey) {
    const cred = Buffer.alloc(18 + credId.length);
    cred.writeUInt16BE(credId.length, 16);
    credId.copy(cred, 18);
    return Buffer.concat([base, cred, coseKey]);
  }
  return base;
}

const clientData = (type: string, challenge: string) =>
  bufToB64url(Buffer.from(JSON.stringify({ type, challenge, origin: ORIGIN }), "utf8"));

// --- fabricate a credential ---------------------------------------------------
const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const jwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
const cose = enc(new Map<number, any>([
  [1, 2], [3, -7], [-1, 1],
  [-2, b64urlToBuf(jwk.x!)], [-3, b64urlToBuf(jwk.y!)],
]));
const credId = Buffer.from("self-test-credential-0001");

// 1. registration
const regChallenge = issueChallenge("register");
const attObj = enc(new Map<string, any>([
  ["fmt", "none"],
  ["attStmt", new Map()],
  ["authData", authDataBytes(0x41, 0, credId, cose)],
]));
const reg = verifyRegistration(bufToB64url(attObj), clientData("webauthn.create", regChallenge), RP_ID, [ORIGIN]);
assert.equal(reg.credentialId, bufToB64url(credId));
assert.equal(reg.key.alg, "ES256");
console.log("1. registration verifies, COSE key extracted");

// 2. good assertion
const login = async (count: number, tamper = false, challenge?: string) => {
  const ch = challenge ?? issueChallenge("login");
  const cdj = clientData("webauthn.get", ch);
  const ad = authDataBytes(0x01, count);
  const data = Buffer.concat([ad, sha256(b64urlToBuf(cdj))]);
  const raw = Buffer.from(await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, data));
  const der = rawToDer(raw);
  if (tamper) der[der.length - 1] ^= 0xff;
  return verifyAssertion(bufToB64url(ad), cdj, bufToB64url(der), reg.key, reg.signCount, RP_ID, [ORIGIN]);
};
const ok = await login(1);
assert.equal(ok.signCount, 1);
console.log("2. valid assertion verifies, counter advances");

// 3. tampered signature rejected
await assert.rejects(() => login(2, true), /signature verification failed/);
console.log("3. tampered signature rejected");

// 4. stale/unknown challenge rejected
await assert.rejects(() => login(3, false, "bogus-challenge"), /unknown or expired challenge/);
console.log("4. unknown challenge rejected");

// 5. counter regression rejected (stored count 5, assertion count 5)
{
  const ch = issueChallenge("login");
  const cdj = clientData("webauthn.get", ch);
  const ad = authDataBytes(0x01, 5);
  const data = Buffer.concat([ad, sha256(b64urlToBuf(cdj))]);
  const raw = Buffer.from(await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, data));
  await assert.rejects(
    () => verifyAssertion(bufToB64url(ad), cdj, bufToB64url(rawToDer(raw)), reg.key, 5, RP_ID, [ORIGIN]),
    /counter did not advance/,
  );
  console.log("5. cloned-authenticator counter rejected");
}

// 6. wrong origin rejected
{
  const ch = issueChallenge("login");
  const cdj = bufToB64url(Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: ch, origin: "https://evil.example" })));
  const ad = authDataBytes(0x01, 9);
  const data = Buffer.concat([ad, sha256(b64urlToBuf(cdj))]);
  const raw = Buffer.from(await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, data));
  await assert.rejects(
    () => verifyAssertion(bufToB64url(ad), cdj, bufToB64url(rawToDer(raw)), reg.key, 0, RP_ID, [ORIGIN]),
    /origin .* not allowed/,
  );
  console.log("6. foreign origin rejected");
}

console.log("\nWEBAUTHN SELF-TEST PASSED — 6/6");
