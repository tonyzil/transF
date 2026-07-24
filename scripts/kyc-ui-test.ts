/**
 * Static KYC UI regression test.
 *
 * The API gate can be correct while the single-file browser app still strands
 * pending users in provisioning. This checks the app has an explicit KYC review
 * surface, dashboard state, and client-side guards for add-money/send controls.
 *
 * Run: npm run kyc:ui:test
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(path.join(ROOT, "services/api/public/index.html"), "utf8");

const mustContain = [
  'id="kyc-review"',
  'id="kyc-card"',
  'id="btn-kyc-refresh"',
  'id="btn-dash-kyc-refresh"',
  "function enterKycReview",
  "function refreshKycStatus",
  "if (!kycApproved(user)) return enterKycReview",
  "identity review must be approved before adding money",
  "identity review must be approved before sending",
];

for (const needle of mustContain) {
  assert.ok(html.includes(needle), `missing KYC UI marker: ${needle}`);
}

const script = html.match(/<script>\n([\s\S]*)\n<\/script>\s*<\/body>/)?.[1];
assert.ok(script, "classic app script not found");
new Function(script);

console.log("KYC UI TEST PASSED — pending/rejected review states are visible and guarded");
