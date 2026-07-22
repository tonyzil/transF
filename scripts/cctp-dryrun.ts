/**
 * CCTP bridge plan: Base Sepolia -> Stellar testnet. Dry-run prints the exact
 * transactions; CCTP_LIVE=1 + CCTP_BURNER_KEY (funded via faucet.circle.com
 * and a Base Sepolia ETH faucet) executes the burn and fetches the Iris
 * attestation for real.
 * Run: npm run cctp:dryrun [amountUsdc]
 */
import { CCTP } from "../services/api/src/config.js";
import { bridgeUsdcToStellar } from "../services/api/src/bridge/cctp.js";
import { getTreasury } from "../services/api/src/stellar/anchor.js";

const amount = Number(process.argv[2] ?? 25);
const treasury = await getTreasury();

console.log(`CCTP ${CCTP.live ? "LIVE" : "dry-run"}: ${amount} USDC  Base Sepolia -> Stellar testnet`);
console.log(`recipient: ${treasury.publicKey()} (treasury)\n`);

const plan = await bridgeUsdcToStellar(amount, treasury.publicKey());

console.log(`mode: ${plan.mode}`);
console.log(`1. approve   -> ${plan.approveTx.to}`);
console.log(`   data: ${plan.approveTx.data.slice(0, 74)}…`);
console.log(`2. burn      -> ${plan.burnTx.to} (depositForBurnWithHook, domain ${CCTP.stellarDomain})`);
console.log(`   data: ${plan.burnTx.data.slice(0, 74)}…`);
console.log(`3. attest    -> ${plan.irisPollUrl}<burnTxHash>`);
console.log(`4. mint      -> ${plan.stellarMint.contract} :: ${plan.stellarMint.method}(${plan.stellarMint.args})`);

if (plan.burnTxHash) {
  console.log(`\nburn tx: ${plan.burnTxHash}`);
  console.log(`attestation: ${plan.attestation ? "received ✓" : "pending"}`);
  console.log(`stellar mint: ${plan.stellarMintTxHash ?? "not submitted"}`);
} else {
  console.log(
    "\n(dry-run — no funds moved. To go live: fund an EOA with Base Sepolia ETH + " +
      "testnet USDC from faucet.circle.com, set CCTP_BURNER_KEY and CCTP_LIVE=1.)",
  );
}
