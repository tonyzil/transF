import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./config.js";

export interface User {
  id: string;
  name: string;
  email?: string;
  country: string;
  kycStatus: "approved"; // mock KYC auto-approves; real flow: Sumsub/Persona
  iban: string; // funding IBAN — mock-issued, or real from Monerium sandbox
  /** Candide Safe smart-account address — the user's identity everywhere:
   *  the RemitVault ledger and the address Monerium attaches the IBAN to. */
  address: `0x${string}`;
  ownerAddress?: `0x${string}`; // EOA owner (signer) of the Safe
  /** Owner key of the Safe. MVP-grade custody: needed to sign Monerium's
   *  ownership declaration and UserOperations. Production: KMS/passkeys. */
  privateKey?: `0x${string}`;
  wallet?: { type: "candide-safe"; deployed: boolean; deployOpHash?: string };
  /** WebAuthn credential bound to this account. Public key + counter are
   *  stored from a verified registration; login verifies assertions. */
  passkey?: {
    credentialId: string;
    publicKey?: { jwk: JsonWebKey; alg: "ES256" | "RS256" };
    signCount?: number;
    rpId?: string;
    attestation?: string;
    createdAt: string;
  };
  /** mock: IBAN issued locally. sandbox states track Monerium provisioning. */
  funding?: {
    mode: "mock" | "sandbox";
    status: "active" | "provisioning" | "iban_pending" | "error";
    moneriumProfileId?: string;
    detail?: string;
  };
  createdAt: string;
}

export type PayoutRail = "cash" | "sepa" | "upi";

export interface Quote {
  id: string;
  userId: string;
  rail: PayoutRail;
  sendEur: number;
  fixedFeeEur: number;
  fxRate: number; // all-in rate after spread (EUR->KES, 1 for sepa, EUR->INR)
  receiveKes: number; // cash rail (0 otherwise)
  receiveEur: number; // sepa rail (0 otherwise)
  receiveInr: number; // upi rail (0 otherwise) — INR-fixed: this drives sendEur
  midRate: number;
  expiresAt: string;
  createdAt: string;
}

export type TransferState =
  | "CREATED"
  | "DEBITED"
  | "SWAPPED"
  | "BRIDGED"
  | "PAYOUT_READY"
  | "PAYOUT_SUBMITTED"
  | "PAID"
  | "FAILED"
  | "REFUNDED";

export interface Transfer {
  id: string;
  userId: string;
  quoteId: string;
  rail: PayoutRail;
  recipientName: string;
  recipientPhone?: string; // cash rail
  recipientIban?: string; // sepa rail
  recipientVpa?: string; // upi rail (merchant/recipient UPI ID)
  state: TransferState;
  sendEur: number;
  receiveKes: number; // cash rail
  receiveEur?: number; // sepa rail
  receiveInr?: number; // upi rail
  usdcOut?: number;
  txs: { step: string; hash: string }[];
  pickup?: {
    referenceCode: string;
    provider: string;
    status: string;
    /** SEP-24 interactive URL (recipient-facing page at the anchor). */
    interactiveUrl?: string;
  };
  /** SEPA payout leg: a real Monerium redeem order in sandbox, or a mock. */
  sepa?: { mode: "sandbox" | "mock"; orderId?: string; state: string; detail?: string };
  /** UPI payout leg (mock partner): UTR is the bank-side reference. */
  upi?: { provider: string; utr: string; state: string };
  error?: string;
  /** FP3: automated compensation after failure. Refund amount depends on
   *  which step failed — costs incurred up to that point are itemized. */
  refund?: {
    amountEur: number;
    recoveredFrom: string; // furthest completed step
    deductions: string;
    at: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface Session {
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: string;
  lastUsedAt: string;
}

interface Db {
  users: User[];
  quotes: Quote[];
  transfers: Transfer[];
  sessions: Session[];
  /** Monerium issue-order ids already mirrored into the vault. */
  processedMoneriumOrders: string[];
}

const DATA_DIR = path.join(ROOT, "data");
const DB_PATH = path.join(DATA_DIR, "db.json");

let db: Db = { users: [], quotes: [], transfers: [], sessions: [], processedMoneriumOrders: [] };

export function initStore() {
  mkdirSync(DATA_DIR, { recursive: true });
  if (existsSync(DB_PATH)) {
    db = JSON.parse(readFileSync(DB_PATH, "utf8"));
    db.sessions ??= [];
    db.processedMoneriumOrders ??= [];
  } else {
    persist();
  }
}

function persist() {
  const tmp = DB_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(db, null, 2));
  renameSync(tmp, DB_PATH);
}

export const store = {
  get users() {
    return db.users;
  },
  get quotes() {
    return db.quotes;
  },
  get transfers() {
    return db.transfers;
  },
  get sessions() {
    return db.sessions;
  },
  addUser(u: User) {
    db.users.push(u);
    persist();
  },
  updateUser(id: string, patch: Partial<User>) {
    const u = db.users.find((x) => x.id === id);
    if (!u) throw new Error(`unknown user ${id}`);
    Object.assign(u, patch);
    persist();
    return u;
  },
  findUserByAddress(address: string) {
    return db.users.find((u) => u.address.toLowerCase() === address.toLowerCase());
  },
  findUserByCredential(credentialId: string) {
    return db.users.find((u) => u.passkey?.credentialId === credentialId);
  },
  isOrderProcessed(orderId: string) {
    return db.processedMoneriumOrders.includes(orderId);
  },
  markOrderProcessed(orderId: string) {
    db.processedMoneriumOrders.push(orderId);
    persist();
  },
  addQuote(q: Quote) {
    db.quotes.push(q);
    persist();
  },
  addTransfer(t: Transfer) {
    db.transfers.push(t);
    persist();
  },
  updateTransfer(id: string, patch: Partial<Transfer>) {
    const t = db.transfers.find((x) => x.id === id);
    if (!t) throw new Error(`unknown transfer ${id}`);
    Object.assign(t, patch, { updatedAt: new Date().toISOString() });
    persist();
    return t;
  },
  addSession(s: Session) {
    db.sessions.push(s);
    persist();
  },
  findSessionByTokenHash(tokenHash: string) {
    return db.sessions.find((s) => s.tokenHash === tokenHash);
  },
  touchSession(id: string) {
    const s = db.sessions.find((x) => x.id === id);
    if (!s) throw new Error(`unknown session ${id}`);
    s.lastUsedAt = new Date().toISOString();
    persist();
    return s;
  },
  findUser(id: string) {
    return db.users.find((u) => u.id === id);
  },
  findUserByIban(iban: string) {
    const norm = iban.replace(/\s/g, "").toUpperCase();
    return db.users.find((u) => u.iban.replace(/\s/g, "").toUpperCase() === norm);
  },
  findQuote(id: string) {
    return db.quotes.find((q) => q.id === id);
  },
  findTransfer(id: string) {
    return db.transfers.find((t) => t.id === id);
  },
};
