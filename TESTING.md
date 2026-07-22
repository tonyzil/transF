# Testing Zoll end to end

Everything below runs on macOS/Linux with **Node.js ≥ 22** and free ports
`3000`, `8545`, `8546`. No other system dependencies.

```sh
npm install
npm run compile
```

## Level 0 — automated checks (5 min, no accounts needed)

```sh
npm run test:contracts   # 14 Solidity tests: vault caps/roles/replay, FX slippage, escrow
npm run e2e              # full corridor 3x: cash pickup, SEPA exit, UPI scan-and-pay
```

Both must end green (`14 tests passed`, `E2E PASSED`). The e2e boots its own
chain + API, so stop `npm run dev` first if it's running (it will tell you).

## Level 1 — the app in mock mode (10 min, no accounts needed)

```sh
npm run dev              # then open http://localhost:3000
```

1. **Onboarding** — enter a name, "Open my account". The setup screen steps
   through instantly in mock mode and lands on the dashboard. You get an IBAN
   (mock-issued) and a real Candide Safe smart-account address (computed
   offline, same tech as production).
2. **Add money** — deposit €250. Watch the balance: this is a real ERC-20 mint
   + vault credit on the local chain.
3. **🇰🇪 Cash pickup** — send €100. Expect: quote with mid-market rate, 0.50%
   spread, €0.99 fee → animated timeline of 5 real transactions (debit,
   FX-swap approve, EURe→USDC swap, bridge approve, escrow lock) → amber
   MoneyGram-style pickup reference → "Simulate cash pickup" → escrow settles,
   history flips to PAID.
4. **🏦 Bank transfer** — send €40 to any IBAN. Expect: fee-only quote
   (€39.01), single debit tx, simulated SEPA payout, PAID.
5. **🇮🇳 UPI** — paste this into the QR field:
   `upi://pay?pa=chaiwala@okhdfcbank&pn=Mumbai%20Chai%20Stand&am=450&cu=INR`
   Expect: merchant + ₹450 parsed automatically, INR-fixed quote ("You pay
   €5.09"), timeline incl. a 12-digit UTR receipt, PAID.

## Level 2 — real sandboxes (optional, ~20 min setup)

### Monerium (real IBANs on real smart wallets)

1. Create a (free) sandbox app at <https://monerium.dev> → copy credentials.
2. `cp .env.example .env`, fill `MONERIUM_CLIENT_ID` / `MONERIUM_CLIENT_SECRET`.
3. `npm run monerium:check` — must print `auth ok`.
4. `npm run dev` → create a user. The onboarding steps now run for real
   (~30s): Safe deployed gasless on Sepolia via Candide's public bundler,
   address linked to Monerium via EIP-1271, real sandbox IBAN issued.
5. Fund it: log into the sandbox portal → *Receive* → simulate a SEPA
   transfer to the user's IBAN. Real test EURe mints to the Safe on Sepolia;
   the app mirrors it into the vault within ~15s.
   (Shortcut without the portal: `npx tsx scripts/credit-test.ts <smart-account-address> 250`)
6. **Real exit flow**: after a portal deposit, a 🏦 Bank transfer places a
   real Monerium redeem order (watch `sepa.orderId` on the transfer, state
   PAYOUT_SUBMITTED → PAID). Without a portal deposit it falls back to a
   simulated payout and records Monerium's actual rejection on the transfer.

### Stellar anchor (the MoneyGram protocol, live)

```sh
npm run stellar:check    # friendbot treasury + SEP-10 auth + SEP-24 withdrawal
```

Runs against Stellar's public test anchor — no signup. With
`MG_ANCHOR_DOMAIN=testanchor.stellar.org` in `.env`, cash-pickup transfers
create real SEP-24 withdrawals (the ticket links the anchor's interactive
page).

### CCTP bridge (Base Sepolia → Stellar testnet)

```sh
npm run cctp:dryrun      # prints the exact burn/attest/mint plan, moves nothing
```

To execute for real: fund an EOA with Base Sepolia ETH (any faucet) + testnet
USDC (<https://faucet.circle.com>), set `CCTP_BURNER_KEY` + `CCTP_LIVE=1`.

## Known limitations (by design, MVP)

- Settlement chain is a local Hardhat node; EURe/USDC there are mocks.
- Owner keys of user Safes are stored server-side (`data/db.json`) — custodial
  MVP; passkey owners are the production path.
- MoneyGram/UPI partners are protocol-shaped mocks unless pointed at a real
  anchor; FX rates are a mock oracle.
- Fresh `npm run dev` resets the local chain + demo users (`data/db.json`).
