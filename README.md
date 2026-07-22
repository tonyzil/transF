![transF on-chain remittance banner](assets/readme-banner.png)

# transF — on-chain remittance platform (Phase 0 MVP)

One corridor in, two payout rails out:

- **In**: EUR by SEPA to a per-user IBAN → minted as EURe on-chain
- **Out (cash)**: EURe → USDC → bridge → KES cash pickup (MoneyGram-style)
- **Out (bank)**: EURe redeemed via a Monerium `redeem` order → SEPA transfer
  to any IBAN (the exit flow)
- **Out (UPI scan-and-pay)**: scan any Indian merchant's UPI QR, pay the INR
  bill from the EUR balance — EURe → USDC on-chain (partner settlement pool),
  mock licensed partner credits the VPA instantly and returns a UTR.
  INR-fixed quoting: the merchant gets exactly the billed amount. Production
  path: a licensed Indian PA/PPI partner with a pre-funded INR float
  (TerraPay-style), net-settled in USDC — the Devcon visitor-payments model.

Users get a Revolut-style primary account: a Candide Safe smart wallet with an
IBAN attached, balances held in a vault contract, spendable on either rail.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full platform design this MVP is
Phase 0 of.

## What's real vs mocked

| Layer | MVP | Production path |
|---|---|---|
| Chain | Local Hardhat node | Base (USDC/EURC native) |
| Tokens | `MockToken` EURe/USDC | Real EURe (Monerium), USDC (Circle) |
| Wallets | **Candide Safe smart accounts (real)** — deterministic address computed offline, deployed gasless on Sepolia via Candide's public bundler/paymaster | Same, on Base with passkey owners |
| Custody | `RemitVault` per-user ledger keyed by Safe address; owner keys stored server-side | KMS/passkey owners, session keys |
| FX | `FxSwapper`, owner-set rate | DEX aggregator + RFQ, oracle-priced |
| Bridge | `BridgeEscrow` lock/settle/release + **real CCTP worker wired to Base Sepolia → Stellar testnet contracts** (dry-run by default; `CCTP_LIVE=1` + funded key executes) | Same worker on Base mainnet → Stellar (domain 27) |
| EUR in | Simulated SEPA webhook, or **real Monerium sandbox** (see below) | Monerium API production (real IBANs, auto-mint) |
| Cash out | **Real SEP-10 + SEP-24 anchor client** (live against testanchor.stellar.org — the exact MoneyGram Ramps protocol), or mock reference codes | Same code, MoneyGram home domain + partner account + asset USDC |
| KYC | Auto-approved | Sumsub/Persona gate before IBAN issuance |

## Layout

- `contracts/src/` — Solidity: `RemitVault` (per-user custody, daily caps,
  idempotent transferIds), `FxSwapper` (slippage-guarded EURe→USDC),
  `BridgeEscrow` (payout lock + refund path), `MockToken`
- `services/api/` — Express API + orchestrator state machine
  (`CREATED → DEBITED → SWAPPED → BRIDGED → PAYOUT_READY → PAID`), Monerium and
  MoneyGram adapters, quote engine, demo UI in `public/`
- `scripts/` — `deploy.ts`, `dev.ts` (full local stack), `e2e.ts`

## Run it

Prerequisite: **Node.js ≥ 22** ([nodejs.org](https://nodejs.org)) — that's the only
system dependency; everything else comes via npm.

```sh
npm install
npm run compile        # build contracts
npm run test:contracts # 14 contract tests (own chain on :8546)
npm run e2e            # full corridor: all three rails, asserts states/balances
npm run dev            # chain + contracts + API + UI at http://localhost:3000
```

New to the repo? **[TESTING.md](TESTING.md)** is the end-to-end test walkthrough.

## Monerium sandbox mode

The funding leg can run against the real Monerium sandbox (`api.monerium.dev`)
instead of the local mock:

1. Create a developer app at <https://monerium.dev> (sandbox environment) —
   this needs a human; there's no API for it.
2. `cp .env.example .env` and fill in `MONERIUM_CLIENT_ID` / `MONERIUM_CLIENT_SECRET`.
3. `npm run monerium:check` — validates credentials and prints what the app
   can see (profiles, addresses, IBANs, orders).
4. `npm run dev` — the API now provisions each new user end-to-end in the
   background: Candide Safe smart wallet deployed gasless on Sepolia →
   Monerium profile created → Safe linked via EIP-1271 signature (owner signs
   the Safe EIP-712 message envelope) → personal IBAN issued to the Safe
   address. The UI polls until the IBAN lands (~30s).
5. Fund it: make a simulated SEPA transfer to the user's IBAN from the
   Monerium sandbox portal. A poller (15s) mirrors processed EURe issue
   orders into the local RemitVault; the balance appears in the UI.
6. Exit flow: the "Bank transfer" rail places a **real Monerium redeem
   order** — the Safe signs the payment message (`Send EUR <amt> to <iban>
   at <time>`, EIP-1271) and Monerium burns EURe from the Safe and pays out
   via SEPA. The poller advances the transfer PAYOUT_SUBMITTED → PAID. If the
   Safe holds no EURe on the sandbox chain (no portal deposit yet), the order
   is rejected and the payout falls back to a simulated leg with the real
   error recorded on the transfer (`sepa.detail`).
   Dev helper: `npx tsx scripts/credit-test.ts <address> <eur>` credits a
   user's local vault directly when you want to test sends without a portal
   deposit.

Notes: without credentials everything stays in mock mode and works as before.
A webhook receiver (`POST /api/webhooks/monerium`) exists for the production
path but local dev uses polling (no public URL). Webhook signature
verification is a TODO.

## Stellar leg: anchor payouts + CCTP bridge

- `npm run stellar:check` — live proof of the payout protocol: provisions a
  Stellar testnet treasury (friendbot), does SEP-10 web-auth, initiates a
  SEP-24 interactive withdrawal at the configured anchor. Works today with no
  signup against `testanchor.stellar.org`.
- Set `MG_ANCHOR_DOMAIN=testanchor.stellar.org` in `.env` and cash-pickup
  transfers create **real anchor withdrawals** (reference code + interactive
  URL on the ticket) instead of mock codes; falls back to mock (logged) if the
  anchor errors. MoneyGram production is the same code: their home domain, a
  partner-onboarded account, `MG_ANCHOR_ASSET=USDC`.
- `npm run cctp:dryrun [amount]` — builds the exact CCTP v2 transactions for
  Base Sepolia → Stellar testnet (burn via `depositForBurnWithHook`, domain
  27, CctpForwarder as mint recipient + destination caller, final recipient in
  the hook data; Iris sandbox attestation; `mint_and_forward` on Soroban).
  Dry-run moves nothing; to execute: fund an EOA (Base Sepolia ETH + USDC from
  faucet.circle.com), set `CCTP_BURNER_KEY` and `CCTP_LIVE=1`.

## Demo flow (UI)

1. Create an account → get an IBAN + on-chain address
2. Simulate a SEPA deposit → EURe minted to the vault, balance appears
3. Get a quote (mid-market EUR→KES, 0.50% spread, €0.99 fixed fee)
4. Send → five on-chain txs execute; a MoneyGram-style pickup code appears
5. Simulate pickup → escrow settles, transfer is PAID

## Known MVP shortcuts

- Orchestrator hot key is a Hardhat dev key; production: KMS + smart-account
  session keys
- Failed transfers park as `FAILED`; `BridgeEscrow.release()` refunds are wired
  in the contract but not automated
- The JSON file store stands in for Postgres + a proper double-entry ledger
- Quotes lock a rate for 10 min but FX inventory risk is unhedged
