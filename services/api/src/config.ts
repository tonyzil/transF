import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "../../..");

// Load .env if present (Node 20.12+ built-in; no dotenv dependency).
try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {
  // no .env — mock mode
}

export const RPC_URL = process.env.TRANSF_RPC_URL ?? "http://127.0.0.1:8545";
export const API_PORT = Number(process.env.TRANSF_API_PORT ?? 3000);

/**
 * Monerium integration. Mock mode by default; sandbox mode activates when
 * client credentials are present (create an app at https://monerium.dev,
 * sandbox environment, and put the credentials in .env).
 */
export const MONERIUM = {
  clientId: process.env.MONERIUM_CLIENT_ID ?? "",
  clientSecret: process.env.MONERIUM_CLIENT_SECRET ?? "",
  baseUrl: process.env.MONERIUM_BASE_URL ?? "https://api.monerium.dev",
  // Chain identifier Monerium should associate linked addresses with.
  // The sandbox expects testnet names ("sepolia", ...); production uses
  // mainnet names ("ethereum", "gnosis", "polygon").
  chain: process.env.MONERIUM_CHAIN ?? "sepolia",
  // Optional: pin a profile id instead of creating/discovering one.
  profileId: process.env.MONERIUM_PROFILE_ID ?? "",
  // How often to poll for incoming EURe issue orders (webhooks need a public
  // URL; polling works for local dev).
  pollMs: Number(process.env.MONERIUM_POLL_MS ?? 15_000),
};

export const moneriumSandboxEnabled = () =>
  Boolean(MONERIUM.clientId && MONERIUM.clientSecret);

/**
 * CCTP bridge (Base Sepolia -> Stellar testnet). Dry-run by default: the
 * worker builds and logs the exact transactions; CCTP_LIVE=1 plus a funded
 * key executes them for real.
 */
export const CCTP = {
  live: process.env.CCTP_LIVE === "1",
  baseRpc: process.env.CCTP_BASE_RPC ?? "https://sepolia.base.org",
  // Circle CCTP V2 testnet deployments (Base Sepolia, domain 6).
  tokenMessenger: (process.env.CCTP_TOKEN_MESSENGER ??
    "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA") as `0x${string}`,
  messageTransmitter: (process.env.CCTP_MESSAGE_TRANSMITTER ??
    "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275") as `0x${string}`,
  usdc: (process.env.CCTP_USDC ??
    "0x036CbD53842c5426634e7929541eC2318f3dCF7e") as `0x${string}`,
  stellarDomain: 27,
  // Stellar testnet CCTP contracts (C-strkeys). All mints route through the
  // CctpForwarder: mintRecipient AND destinationCaller must be the forwarder.
  stellarForwarder:
    process.env.CCTP_STELLAR_FORWARDER ?? "CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ",
  stellarMessageTransmitter:
    process.env.CCTP_STELLAR_MSG_TRANSMITTER ?? "CBJ6MTCKKZG73PMDZCJMSFRD7DQEMI4FKDH7CGDSV4W6FHCRBCQAVVJY",
  irisBase: process.env.CCTP_IRIS_BASE ?? "https://iris-api-sandbox.circle.com",
  // Funded Base Sepolia EOA for live burns (never a hardhat dev key).
  burnerKey: (process.env.CCTP_BURNER_KEY ?? "") as `0x${string}` | "",
};

/** Stellar treasury + MoneyGram-style anchor (SEP-10/SEP-24). */
export const STELLAR = {
  horizon: process.env.STELLAR_HORIZON ?? "https://horizon-testnet.stellar.org",
  sorobanRpc: process.env.STELLAR_SOROBAN_RPC ?? "https://soroban-testnet.stellar.org",
  networkPassphrase: process.env.STELLAR_PASSPHRASE ?? "Test SDF Network ; September 2015",
  friendbot: process.env.STELLAR_FRIENDBOT ?? "https://friendbot.stellar.org",
  // Anchor home domain for SEP-10/24. Stellar's public test anchor works
  // without any signup; MoneyGram production is the same protocol at their
  // domain with a partner-onboarded account.
  anchorDomain: process.env.MG_ANCHOR_DOMAIN ?? "",
  anchorAsset: process.env.MG_ANCHOR_ASSET ?? "SRT", // testanchor's reference token
  treasurySecret: process.env.STELLAR_TREASURY_SECRET ?? "",
};

export const anchorModeEnabled = () => Boolean(STELLAR.anchorDomain);

// Hardhat's well-known dev accounts. On testnet/mainnet these come from a KMS.
export const KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  orchestrator: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  ramp: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
} as const;

export interface Deployments {
  eure: `0x${string}`;
  usdc: `0x${string}`;
  vault: `0x${string}`;
  swapper: `0x${string}`;
  bridge: `0x${string}`;
}

export function loadDeployments(): Deployments {
  const p = path.join(ROOT, "deployments.json");
  return JSON.parse(readFileSync(p, "utf8"));
}

export function loadAbi(contract: string): any[] {
  const p = path.join(
    ROOT,
    "contracts/artifacts/contracts/src",
    `${contract}.sol`,
    `${contract}.json`,
  );
  return JSON.parse(readFileSync(p, "utf8")).abi;
}

// FX configuration for the launch corridor (EUR -> KES cash pickup).
// Mid rates are a mock oracle; in production: Chainlink/Pyth FX feeds.
export const FX = {
  EURUSD_MID: 1.08,
  USDKES_MID: 129.5,
  USDINR_MID: 87.2,
  SPREAD_BPS: 50, // our FX spread
  FIXED_FEE_EUR: 0.99,
  // UPI is a point-of-sale rail — small fixed fee, same spread.
  UPI_FIXED_FEE_EUR: 0.29,
  QUOTE_TTL_MS: 10 * 60 * 1000,
  DAILY_CAP_EUR: 2500, // mirrors RemitVault.dailyCap
};
