/**
 * Stellar anchor client — SEP-10 (web auth) + SEP-24 (interactive withdraw).
 *
 * This IS the MoneyGram Ramps protocol: MoneyGram is a Stellar anchor
 * speaking exactly these SEPs from its own home domain, gated on partner
 * onboarding. Pointed at Stellar's public test anchor (testanchor.stellar.org)
 * the same code runs live today with no signup — so the integration is real
 * protocol code, and production MoneyGram is a config change:
 * MG_ANCHOR_DOMAIN + a partner-onboarded account + asset USDC.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { ROOT, STELLAR } from "../config.js";

// ---------------------------------------------------------------------------
// Treasury account (auto-provisioned on testnet via friendbot)

const TREASURY_PATH = path.join(ROOT, "data", "stellar-treasury.json");

export async function getTreasury(): Promise<Keypair> {
  if (STELLAR.treasurySecret) return Keypair.fromSecret(STELLAR.treasurySecret);
  if (existsSync(TREASURY_PATH)) {
    return Keypair.fromSecret(JSON.parse(readFileSync(TREASURY_PATH, "utf8")).secret);
  }
  const kp = Keypair.random();
  // Fund on testnet so the account exists on-ledger.
  const res = await fetch(`${STELLAR.friendbot}?addr=${kp.publicKey()}`);
  if (!res.ok) throw new Error(`friendbot funding failed (${res.status})`);
  mkdirSync(path.dirname(TREASURY_PATH), { recursive: true });
  writeFileSync(
    TREASURY_PATH,
    JSON.stringify({ publicKey: kp.publicKey(), secret: kp.secret() }, null, 2),
  );
  console.log(`stellar: provisioned treasury ${kp.publicKey()} (friendbot funded)`);
  return kp;
}

// ---------------------------------------------------------------------------
// stellar.toml discovery

export interface AnchorInfo {
  webAuthEndpoint: string;
  transferServerSep24: string;
  signingKey?: string;
}

export async function fetchAnchorInfo(homeDomain: string): Promise<AnchorInfo> {
  const res = await fetch(`https://${homeDomain}/.well-known/stellar.toml`);
  if (!res.ok) throw new Error(`stellar.toml fetch failed for ${homeDomain} (${res.status})`);
  const toml = await res.text();
  const get = (key: string) => toml.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "m"))?.[1];
  const webAuthEndpoint = get("WEB_AUTH_ENDPOINT");
  const transferServerSep24 = get("TRANSFER_SERVER_SEP0024");
  if (!webAuthEndpoint || !transferServerSep24) {
    throw new Error(`${homeDomain} toml missing WEB_AUTH_ENDPOINT / TRANSFER_SERVER_SEP0024`);
  }
  return { webAuthEndpoint, transferServerSep24, signingKey: get("SIGNING_KEY") };
}

// ---------------------------------------------------------------------------
// SEP-10: challenge -> sign -> JWT

export async function sep10Auth(homeDomain: string, keypair: Keypair): Promise<string> {
  const info = await fetchAnchorInfo(homeDomain);
  const chRes = await fetch(
    `${info.webAuthEndpoint}?account=${keypair.publicKey()}&home_domain=${homeDomain}`,
  );
  if (!chRes.ok) throw new Error(`SEP-10 challenge failed (${chRes.status}): ${await chRes.text()}`);
  const { transaction, network_passphrase } = (await chRes.json()) as {
    transaction: string;
    network_passphrase?: string;
  };

  const tx = TransactionBuilder.fromXDR(
    transaction,
    network_passphrase ?? STELLAR.networkPassphrase,
  );
  tx.sign(keypair);

  const tokRes = await fetch(info.webAuthEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transaction: tx.toXDR() }),
  });
  if (!tokRes.ok) throw new Error(`SEP-10 token failed (${tokRes.status}): ${await tokRes.text()}`);
  const { token } = (await tokRes.json()) as { token: string };
  return token;
}

// ---------------------------------------------------------------------------
// SEP-24: interactive withdrawal

export interface Sep24Withdrawal {
  id: string;
  url: string; // interactive KYC/details page (recipient-facing at MoneyGram)
  status?: string;
}

export async function sep24InitiateWithdraw(
  homeDomain: string,
  jwt: string,
  assetCode: string,
  account: string,
  amount?: string,
): Promise<Sep24Withdrawal> {
  const info = await fetchAnchorInfo(homeDomain);
  const res = await fetch(`${info.transferServerSep24}/transactions/withdraw/interactive`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ asset_code: assetCode, account, ...(amount ? { amount } : {}) }),
  });
  if (!res.ok) throw new Error(`SEP-24 withdraw failed (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as { id: string; url: string; type: string };
  return { id: data.id, url: data.url };
}

export interface Sep24Status {
  id: string;
  status: string;
  withdrawAnchorAccount?: string;
  withdrawMemo?: string;
  withdrawMemoType?: string;
  moreInfoUrl?: string;
}

export async function sep24GetTransaction(
  homeDomain: string,
  jwt: string,
  id: string,
): Promise<Sep24Status> {
  const info = await fetchAnchorInfo(homeDomain);
  const res = await fetch(`${info.transferServerSep24}/transaction?id=${id}`, {
    headers: { authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) throw new Error(`SEP-24 status failed (${res.status}): ${await res.text()}`);
  const { transaction: t } = (await res.json()) as { transaction: any };
  return {
    id: t.id,
    status: t.status,
    withdrawAnchorAccount: t.withdraw_anchor_account,
    withdrawMemo: t.withdraw_memo,
    withdrawMemoType: t.withdraw_memo_type,
    moreInfoUrl: t.more_info_url,
  };
}
