/**
 * Server-side WebAuthn verification (FP2 of the red-team fixes).
 *
 * Dependency-free implementation of the two ceremonies:
 *  - registration: parse attestationObject (CBOR) -> authData -> COSE public
 *    key; verify rpIdHash + challenge + origin; store key + sign counter.
 *  - assertion (login): verify clientData (type/challenge/origin), rpIdHash,
 *    user-presence flag, monotonic counter, and the signature over
 *    authenticatorData || sha256(clientDataJSON) with the stored key.
 *
 * Supports ES256 (P-256, the passkey default) and RS256.
 */
import { createHash, randomBytes, webcrypto } from "node:crypto";

// ---------------------------------------------------------------------------
// helpers

export const b64urlToBuf = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
export const bufToB64url = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest();

// ---------------------------------------------------------------------------
// minimal CBOR decoder (enough for attestation objects / COSE keys)

function cborDecode(buf: Buffer, offset = 0): { value: any; offset: number } {
  const first = buf[offset];
  const major = first >> 5;
  const info = first & 0x1f;
  let len = 0;
  let o = offset + 1;
  if (info < 24) len = info;
  else if (info === 24) { len = buf[o]; o += 1; }
  else if (info === 25) { len = buf.readUInt16BE(o); o += 2; }
  else if (info === 26) { len = buf.readUInt32BE(o); o += 4; }
  else if (info === 27) { len = Number(buf.readBigUInt64BE(o)); o += 8; }
  else throw new Error(`cbor: unsupported additional info ${info}`);

  switch (major) {
    case 0: return { value: len, offset: o };
    case 1: return { value: -1 - len, offset: o };
    case 2: return { value: buf.subarray(o, o + len), offset: o + len };
    case 3: return { value: buf.subarray(o, o + len).toString("utf8"), offset: o + len };
    case 4: {
      const arr: any[] = [];
      for (let i = 0; i < len; i++) { const r = cborDecode(buf, o); arr.push(r.value); o = r.offset; }
      return { value: arr, offset: o };
    }
    case 5: {
      const map = new Map<any, any>();
      for (let i = 0; i < len; i++) {
        const k = cborDecode(buf, o); o = k.offset;
        const v = cborDecode(buf, o); o = v.offset;
        map.set(k.value, v.value);
      }
      return { value: map, offset: o };
    }
    default: throw new Error(`cbor: unsupported major type ${major}`);
  }
}

// ---------------------------------------------------------------------------
// COSE key -> JWK

export interface StoredKey { jwk: JsonWebKey; alg: "ES256" | "RS256" }

function coseToJwk(cose: Map<number, any>): StoredKey {
  const kty = cose.get(1);
  if (kty === 2) {
    if (cose.get(-1) !== 1) throw new Error("webauthn: unsupported EC curve");
    return {
      alg: "ES256",
      jwk: { kty: "EC", crv: "P-256", x: bufToB64url(cose.get(-2)), y: bufToB64url(cose.get(-3)) },
    };
  }
  if (kty === 3) {
    return { alg: "RS256", jwk: { kty: "RSA", n: bufToB64url(cose.get(-1)), e: bufToB64url(cose.get(-2)) } };
  }
  throw new Error(`webauthn: unsupported key type ${kty}`);
}

// ---------------------------------------------------------------------------
// authenticator data

export interface AuthData {
  rpIdHash: Buffer;
  flags: number;
  signCount: number;
  credentialId?: Buffer;
  key?: StoredKey;
}

export function parseAuthData(data: Buffer): AuthData {
  const rpIdHash = data.subarray(0, 32);
  const flags = data[32];
  const signCount = data.readUInt32BE(33);
  const out: AuthData = { rpIdHash, flags, signCount };
  if (flags & 0x40) { // attested credential data present
    const credLen = data.readUInt16BE(53);
    out.credentialId = data.subarray(55, 55 + credLen);
    const cose = cborDecode(data, 55 + credLen);
    out.key = coseToJwk(cose.value);
  }
  return out;
}

// DER ECDSA signature -> raw r||s (64 bytes) for WebCrypto
function derToRaw(der: Buffer): Buffer {
  if (der[0] !== 0x30) throw new Error("webauthn: bad DER signature");
  let o = 2;
  if (der[1] & 0x80) o += der[1] & 0x7f;
  const readInt = () => {
    if (der[o] !== 0x02) throw new Error("webauthn: bad DER integer");
    const len = der[o + 1];
    let v = der.subarray(o + 2, o + 2 + len);
    o += 2 + len;
    while (v.length > 32 && v[0] === 0) v = v.subarray(1);
    return Buffer.concat([Buffer.alloc(32 - v.length), v]);
  };
  const r = readInt();
  const s = readInt();
  return Buffer.concat([r, s]);
}

async function importKey(k: StoredKey) {
  return k.alg === "ES256"
    ? webcrypto.subtle.importKey("jwk", k.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"])
    : webcrypto.subtle.importKey("jwk", { ...k.jwk, alg: "RS256" }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
}

// ---------------------------------------------------------------------------
// challenges (in-memory, single-use, 5 min TTL)

const challenges = new Map<string, { purpose: "register" | "login"; exp: number }>();

export function issueChallenge(purpose: "register" | "login"): string {
  const c = randomBytes(32).toString("base64url");
  challenges.set(c, { purpose, exp: Date.now() + 5 * 60_000 });
  return c;
}

function consumeChallenge(c: string, purpose: "register" | "login"): boolean {
  const e = challenges.get(c);
  challenges.delete(c);
  for (const [k, v] of challenges) if (v.exp < Date.now()) challenges.delete(k);
  return !!e && e.purpose === purpose && e.exp >= Date.now();
}

// ---------------------------------------------------------------------------
// ceremonies

function checkClientData(clientDataJSON: Buffer, expectedType: string, origins: string[], purpose: "register" | "login") {
  const cd = JSON.parse(clientDataJSON.toString("utf8"));
  if (cd.type !== expectedType) throw new Error(`webauthn: unexpected type ${cd.type}`);
  if (!consumeChallenge(cd.challenge, purpose)) throw new Error("webauthn: unknown or expired challenge");
  if (!origins.includes(cd.origin)) throw new Error(`webauthn: origin ${cd.origin} not allowed`);
}

export interface RegistrationResult { credentialId: string; key: StoredKey; signCount: number }

export function verifyRegistration(
  attestationObjectB64: string,
  clientDataJSONB64: string,
  rpId: string,
  origins: string[],
): RegistrationResult {
  const clientDataJSON = b64urlToBuf(clientDataJSONB64);
  checkClientData(clientDataJSON, "webauthn.create", origins, "register");
  const att = cborDecode(b64urlToBuf(attestationObjectB64)).value as Map<string, any>;
  const authData = parseAuthData(Buffer.from(att.get("authData")));
  if (!authData.rpIdHash.equals(sha256(rpId))) throw new Error("webauthn: rpId mismatch");
  if (!(authData.flags & 0x01)) throw new Error("webauthn: user presence not asserted");
  if (!authData.credentialId || !authData.key) throw new Error("webauthn: no credential in attestation");
  return { credentialId: bufToB64url(authData.credentialId), key: authData.key, signCount: authData.signCount };
}

export async function verifyAssertion(
  authenticatorDataB64: string,
  clientDataJSONB64: string,
  signatureB64: string,
  storedKey: StoredKey,
  storedCount: number,
  rpId: string,
  origins: string[],
): Promise<{ signCount: number }> {
  const clientDataJSON = b64urlToBuf(clientDataJSONB64);
  checkClientData(clientDataJSON, "webauthn.get", origins, "login");
  const authData = b64urlToBuf(authenticatorDataB64);
  const parsed = parseAuthData(authData);
  if (!parsed.rpIdHash.equals(sha256(rpId))) throw new Error("webauthn: rpId mismatch");
  if (!(parsed.flags & 0x01)) throw new Error("webauthn: user presence not asserted");
  if (storedCount > 0 && parsed.signCount > 0 && parsed.signCount <= storedCount) {
    throw new Error("webauthn: sign counter did not advance (possible clone)");
  }
  const sigRaw = b64urlToBuf(signatureB64);
  const sig = storedKey.alg === "ES256" ? derToRaw(sigRaw) : sigRaw;
  const data = Buffer.concat([authData, sha256(clientDataJSON)]);
  const key = await importKey(storedKey);
  const ok = await webcrypto.subtle.verify(
    storedKey.alg === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : "RSASSA-PKCS1-v1_5",
    key,
    sig,
    data,
  );
  if (!ok) throw new Error("webauthn: signature verification failed");
  return { signCount: parsed.signCount };
}
