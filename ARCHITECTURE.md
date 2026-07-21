# transF — On-Chain Remittance Platform: Architecture

Status: Draft v0.1 (2026-07-19)

## 1. Product model

Revolut-style account hierarchy, but on-chain:

- **Primary account** — every user gets one smart-contract account (ERC-4337) on Base,
  denominated in their home currency's stablecoin. Depending on the user's country it
  is fundable via:
  - **EUR users**: a real personal IBAN (Monerium). SEPA transfers to the IBAN are
    auto-minted as EURe directly into the user's on-chain account; sending EURe out
    burns it and settles to any bank account via SEPA.
  - **US users**: a virtual bank account (ACH/wire → USDC) via a licensed
    orchestration partner (e.g. Bridge/Stripe).
  - **Crypto-native users**: plain wallet address (deposit USDC/EURC directly).
- **Currency sub-accounts** — users can open additional accounts in any supported
  currency. Each sub-account is a position in a per-currency **vault** owned by the
  user's smart account. Opening one is free and instant (it's just a vault share
  balance, not new infrastructure).

## 2. Currency strategy at launch

| Currency | Token(s) | Rail in/out | Notes |
|---|---|---|---|
| USD | USDC (Base, native) | ACH/wire via partner; MoneyGram cash | Deepest liquidity; the settlement backbone |
| EUR | EURC (Base) + EURe (Monerium) | SEPA via Monerium IBAN | EURC for on-chain FX liquidity; EURe for bank rails. Swap between them at the edges |
| CHF | none held at launch | SIC/SEPA via partner FX | CHF stablecoins are too thin (~$41M total cap, ~$40k/day volume across VCHF/ZCHF). Treat CHF as a **display/payout currency**: price it, but settle through USDC/EURC and convert at the edge. Revisit holding ZCHF/VCHF inventory when depth improves |

Rule of thumb: only hold on-chain inventory in a currency when daily DEX depth
supports our expected flow at <30bps slippage. Everything else is quote-and-convert
at the boundary.

## 3. Settlement layer

- **Base** as the primary chain: native USDC + EURC, sub-cent fees, mature AA
  (account abstraction) tooling, Coinbase on/off-ramp adjacency.
- **Ethereum L1** for treasury custody of large balances only.
- **Stellar** as a *payout rail*, not a home chain: MoneyGram Ramps runs on Stellar
  USDC (SEP-10 auth, SEP-24 deposit/withdraw). We bridge Base-USDC → Stellar-USDC
  via Circle (CCTP where supported, Circle Mint redemption/mint otherwise) only at
  payout time.
- **Ethereum/Polygon/Gnosis** touched only where Monerium requires (EURe lives
  there); keep EURe inventory minimal and swap to EURC on Base for anything held.

## 4. On-chain architecture

```
User (passkey) ─▶ ERC-4337 Smart Account (per user, on Base)
                     │  gas sponsored via Paymaster
                     ├─ USD sub-account  ─┐
                     ├─ EUR sub-account  ─┼─▶ per-currency Vaults (ERC-4626)
                     └─ ...              ─┘        │
                                                   ▼
                                     Treasury / FX Vault (protocol-owned)
                                       ├─ holds USDC/EURC inventory
                                       ├─ executes swaps: DEX aggregator
                                       │   (Uniswap/Aerodrome on Base) w/ slippage
                                       │   guards; RFQ for size
                                       └─ rebalances across rails/chains
```

Components:

1. **Smart accounts (ERC-4337)** — Safe or ZeroDev Kernel. Passkey signer for
   consumers, session keys for the backend to execute user-approved flows, social
   recovery. Users never touch gas: paymaster sponsors, cost folded into FX spread.
2. **Per-currency vaults (ERC-4626-style)** — one vault per currency token. A user's
   "EUR account" is their share balance in the EUR vault. Gives us: single audited
   contract per currency, easy yield layering later (T-bill backed tokens), clean
   accounting.
3. **FX/Treasury vault** — protocol-owned inventory of USDC + EURC. User-facing FX
   executes against this vault at a quoted rate (oracle mid ± spread); the vault
   rebalances against DEXs/RFQ makers asynchronously. This decouples user UX from
   DEX slippage and lets us net opposing flows (USD→EUR vs EUR→USD) internally —
   the core margin engine of the business.
4. **Bridging module** — Base↔Stellar (MoneyGram payouts) and Base↔Ethereum/Gnosis
   (Monerium EURe). Isolated, rate-limited, with per-day caps.

## 5. Remittance flow (canonical example: US → Kenya cash pickup)

1. Sender funds primary account: ACH → partner mints USDC to their Base smart account.
2. Sender enters recipient + amount; quote = oracle mid-rate + spread + fixed fee,
   locked for N minutes.
3. FX vault fills the quote internally (USDC stays USDC here; for EUR corridors it
   swaps USDC→EURC).
4. Payout leg, by recipient's rail:
   - **Bank (EUR)**: swap EURC→EURe, burn via Monerium → SEPA Instant to any IBAN.
   - **Cash (170+ countries)**: bridge USDC to Stellar, SEP-24 withdrawal via
     MoneyGram Ramps → recipient gets a reference code, picks up cash at an agent.
   - **Wallet**: direct USDC/EURC transfer, any supported chain.
5. Receipt with on-chain tx hash; internal ledger reconciles vault positions.

## 6. Off-chain services

- **Ledger service** — double-entry ledger mirroring on-chain state; the source of
  truth for balances shown in-app; reconciler flags any drift vs chain.
- **Quote/FX engine** — Chainlink/Pyth FX oracles + DEX depth → executable quotes
  with TTL.
- **Orchestrator** — state machines per transfer (fund → convert → bridge → payout),
  idempotent, with compensation steps (refund path) on partner failure.
- **Compliance** — KYC/KYB (Sumsub/Persona), on-chain screening (TRM/Chainalysis)
  on every deposit address and payout, sanctions lists, Travel Rule messaging,
  velocity limits per risk tier.
- **Partner adapters** — Monerium API, MoneyGram Ramps (SEP-10/24), banking
  partner, each behind a common `PayoutRail` / `FundingRail` interface so new
  corridors are adapter work, not architecture work.

## 7. Regulatory posture (launch)

- Do **not** self-custody fiat or hold money-transmitter licenses at launch.
  Operate on partners' licenses: Monerium (EU EMI, MiCA-compliant EURe), a US
  orchestration partner (money transmission), MoneyGram (global payout licenses).
- Smart accounts are user-controlled (passkey) → strong argument for
  non-custodial positioning of the on-chain layer, but get counsel per market;
  the FX vault is clearly our regulated activity.
- MiCA note: in the EU only regulated e-money tokens (EURe, EURC) may be used for
  consumer payments — this is why the EUR strategy is built on those two.

## 8. Phased roadmap

- **Phase 0 — corridor MVP (one corridor, e.g. EU→cash-pickup):** Monerium IBAN in,
  MoneyGram out. No FX vault yet — route swaps straight through a DEX aggregator.
  Proves the full loop with minimal contracts (smart account + one vault).
- **Phase 1 — multi-currency accounts:** USD funding partner, EUR/USD sub-accounts,
  ERC-4626 vaults, FX vault v1 with internal netting.
- **Phase 2 — scale:** more corridors (adapter per rail), CHF + others as display
  currencies, yield on idle balances, business accounts (KYB).

## 9. Open decisions (need a call)

1. **First corridor** — pick one sender country + one recipient rail for Phase 0.
   Economics and licensing differ wildly; this drives partner sequencing.
2. **Custody stance** — fully non-custodial smart accounts (harder UX, lighter
   regulation) vs MPC-custodial (easier UX, heavier licensing). Recommendation:
   non-custodial with passkeys + session keys.
3. **US partner** — Bridge (Stripe) vs alternatives for USD virtual accounts.
4. **Entity/licensing domicile** — affects which partners will onboard us at all.
