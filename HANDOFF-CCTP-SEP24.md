# Handoff: make the cash rail actually move value

Written for an agent picking this up cold. Read `CLAUDE.md` first for
environment and branch rules; this file covers only the cash corridor.

> **This describes the tree with PR #16 merged.** `sep24WithdrawLimits` and
> `refreshAnchorPickup` land in that PR — if you are on a checkout without
> them, you are on a stale base. See "Depends on" at the end.

## The one-sentence problem

The Kenya cash rail is protocol-correct right up to the point where money
should move, and then it stops: we lock mock USDC in a local escrow contract,
open a real SEP-24 withdrawal session at the anchor, and never bridge or send
anything. A recipient could not collect cash.

## What is true today

**The bridge leg is a local mock.** `executeTransfer` in
`services/api/src/orchestrator.ts` calls `BridgeEscrow.lockForPayout`, which
moves mock USDC between addresses on the local Hardhat chain. Nothing crosses
to Stellar.

**Real CCTP code exists and is wired to nothing.** `bridgeUsdcToStellar` in
`services/api/src/bridge/cctp.ts` builds the Base Sepolia burn, polls Circle's
Iris attestation API, and prepares the Soroban mint. It has exactly one
caller: `scripts/cctp-dryrun.ts`. It has never run against the orchestrator.

**The anchor session is real but inert.** `createCashPickupViaAnchor` in
`services/api/src/adapters/moneygram.ts` does genuine SEP-10 auth and opens a
genuine SEP-24 withdrawal with a validated amount. But SEP-24 only completes
once the asset is sent **on-ledger to the anchor's account with its memo**,
and we never do that. A real withdrawal sits at `pending_user_transfer_start`
forever. `refreshAnchorPickup` polls and reports that honestly.

**Settlement is simulated.** `POST /api/simulate/pickup` marks the transfer
PAID and settles the escrow. That endpoint is dev-only (`ALLOW_SIMULATION`),
so in production the rail currently has no completion path at all.

## Two tasks, in this order

### A. SEP-24 on-ledger payment (do this first)

Make a withdrawal actually complete. Self-contained, needs only Stellar
testnet, and it is the half that turns the rail from a demo into a payment.

`sep24GetTransaction` in `services/api/src/stellar/anchor.ts` already returns
`withdrawAnchorAccount`, `withdrawMemo` and `withdrawMemoType` — everything
the payment needs. The missing piece is a Stellar payment operation from the
treasury to that account, carrying that memo, followed by polling until the
anchor reports `completed`.

Acceptance:

- a transfer in anchor mode reaches `completed` at the anchor without anyone
  calling a simulate endpoint
- the transfer only moves to PAID on the anchor's own status, never on ours
- a payment that fails or times out routes into the existing FP3 compensation
  path (see `failAndCompensate`) rather than stranding the transfer
- `npm run anchor:test` still passes, extended with the new behaviour

### B. Wire CCTP into the bridge leg

Replace the mock escrow with a real burn on Base Sepolia and mint on Stellar,
so there is genuine USDC on Stellar for task A to send.

`CCTP` config lives in `services/api/src/config.ts`: Stellar domain is 27,
mints route through the `CctpForwarder` (both `mintRecipient` **and**
`destinationCaller` must be the forwarder — this is a Circle rule, not a
choice), Iris attestation polling is already implemented.

Acceptance:

- the orchestrator's bridge step performs a real burn when `CCTP_LIVE=1`, and
  the existing dry-run plan otherwise
- attestation polling failures compensate rather than strand
- the transfer records the burn tx hash and the Stellar mint, the way other
  legs record `txs` entries
- dry-run remains the default so `npm run e2e` keeps working with no funds

## Prerequisites only the repo owner can supply

Neither task can be *proven* without these. If you cannot get them, say so
explicitly and deliver dry-run code plus tests — do not merge something that
reads as finished but has never executed. That is exactly how the existing
CCTP worker ended up written, wired to nothing, and unexercised.

- `CCTP_BURNER_KEY` funded with Base Sepolia ETH **and** testnet USDC
  (faucet.circle.com)
- a Stellar treasury holding the anchor's asset, with the trustline
  established. Note SRT on `testanchor.stellar.org` is obtained through the
  anchor's *interactive deposit flow*, so it is not scriptable
- confirmation of which asset to use: testanchor supports SRT, native and
  USDC for withdrawal

## Traps

**The unit trap — this one has already bitten once.** The anchor withdraws an
*asset* (USDC/SRT). `receiveKes` is what the recipient collects after the
anchor's own FX. They differ by the whole exchange rate: ~108 vs ~13,778 for a
€100 transfer. The orchestrator previously passed the KES figure into the
anchor call and it went unnoticed because the amount was never sent. Any code
that puts a local-currency figure where an asset amount belongs is wrong.

**Anchor limits are small.** `testanchor.stellar.org` caps withdrawals at 10
units. Corridor-sized transfers are refused there by design — that is the
anchor's limit, not a bug to work around. Demo with small amounts.

**`orchestrator.ts` is the contended file.** Several agents change it. Rebase
often, and keep your diff to the bridge and pickup legs.

## House standards

The value of recent work is not the code, it is that `npm run check` fails
when a property breaks. Match that:

- write a test that **fails against current code and passes after your change**
- add it to the `check` script in `package.json`
- live integration tests are welcome (`npm run anchor:test` runs against the
  real anchor with no credentials) — prefer them to mocks where a real
  endpoint is reachable
- say plainly in code comments what is real and what is simulated; the README
  voice is specifics over adjectives, shortcuts stated openly

## Branch rules (from CLAUDE.md)

- use your own branch prefix; **never** push to a `claude/*` branch
- `main` is PR-merge only
- `git fetch` before starting — `main` moves under you
- after a merge, confirm the head SHA is what you pushed and grep the tree to
  confirm the content landed. A merge silently dropped a commit once already
  (PR #3, recovered in PR #4)

## Depends on

PR #16 (`claude/anchor-withdrawal-amounts`) must merge first. It changes
`createCashPickupViaAnchor`'s signature, adds `sep24WithdrawLimits`, and
changes the orchestrator's pickup call — the same three files this work
touches. Starting before it lands means conflicting inside the function you
are changing.

## Not in scope

- FP4's remaining half (`user.privateKey` still signs Monerium linking and
  redeem orders server-side). Someone is already on it — do not start.
- The mirror seam and its reconciler. Both disappear on the Polygon migration.
