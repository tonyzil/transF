/** Temp: credit a user's local vault (as if a SEPA deposit was mirrored). */
import { simulateSepaDeposit } from "../services/api/src/adapters/monerium.js";
const [address, amount] = process.argv.slice(2);
await simulateSepaDeposit(address as `0x${string}`, Number(amount), `manual-${Date.now()}`);
console.log("credited", amount, "to", address);
