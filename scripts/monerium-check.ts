/**
 * Validates Monerium sandbox credentials and shows what the integration can
 * see: auth context, profiles, linked addresses, IBANs, and recent orders.
 * Run after filling in .env:  npm run monerium:check
 */
import { MONERIUM, moneriumSandboxEnabled } from "../services/api/src/config.js";
import { MoneriumClient } from "../services/api/src/adapters/monerium-client.js";

if (!moneriumSandboxEnabled()) {
  console.error(
    "No credentials. Copy .env.example to .env and set MONERIUM_CLIENT_ID / MONERIUM_CLIENT_SECRET\n" +
      "(create a sandbox app at https://monerium.dev).",
  );
  process.exit(1);
}

const api = new MoneriumClient({
  baseUrl: MONERIUM.baseUrl,
  clientId: MONERIUM.clientId,
  clientSecret: MONERIUM.clientSecret,
});

console.log(`checking ${MONERIUM.baseUrl} (chain: ${MONERIUM.chain})…\n`);

try {
  const ctx = await api.authContext();
  console.log("auth ok:", JSON.stringify(ctx, null, 2));
} catch (err: any) {
  console.error(`AUTH FAILED: ${err.message}`);
  process.exit(1);
}

for (const [label, fn] of [
  ["profiles", () => api.profiles()],
  ["addresses", () => api.addresses()],
  ["ibans", () => api.ibans()],
  ["orders", () => api.orders()],
] as const) {
  try {
    const res = await fn();
    console.log(`\n${label}:`, JSON.stringify(res, null, 2).slice(0, 2000));
  } catch (err: any) {
    console.log(`\n${label}: unavailable (${err.message.split("\n")[0]})`);
  }
}

console.log(
  "\nAll good. Start the stack (npm run dev), create a user in the UI, then make a\n" +
    "simulated SEPA transfer to its IBAN from the Monerium sandbox portal — the\n" +
    "deposit poller mirrors it into the vault automatically.",
);
