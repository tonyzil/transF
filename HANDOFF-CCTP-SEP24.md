# Handoff: make the cash rail actually move value

Written for an agent picking this up cold. Read `CLAUDE.md` first for
environment and branch rules; this file covers only the cash corridor.

> **Current after PR #33.** The old Base Sepolia CCTP path still exists in code
> as the first live bridge worker, but the chosen public-chain target is now
> **Polygon + its testnet (Amoy)** because EURe is native there. Do not deepen
> Base-specific assumptions unless the user explicitly reopens that path.

## The one-sentence problem

The Kenya cash rail is protocol-correct and has a real Stellar anchor payment
path, but it is not yet proven as a live value corridor on the chosen chain.
The next version should run on Polygon/Amoy so Monerium EURe is native there,
then prove EURe funding, USDC/CCTP or partner settlement, Stellar treasury
funding, and anchor completion end to end.

## What is true today

**The demo settlement leg is still local.** In dry-run/default mode,
`executeTransfer` records the CCTP burn/mint plan and still uses
`BridgeEscrow.lockForPayout` with mock USDC on local Hardhat so the no-credential
demo can finish.

**The existing CCTP worker is Base Sepolia-specific.** `bridgeUsdcToStellar` in
`services/api/src/bridge/cctp.ts` can build and, with `CCTP_LIVE=1`, submit the
Base Sepolia burn, poll Circle's Iris attestation API, and submit Stellar
`mint_and_forward`. It is wired into the cash orchestrator now, but it is no
longer the strategic target. Treat it as the reference worker to port to
Polygon/Amoy unless the user asks for Base.

**The anchor session can be funded on-ledger.** `createCashPickupViaAnchor`
does genuine SEP-10 auth and opens a genuine SEP-24 withdrawal with a validated
asset amount. `refreshPayout` calls `fundAndRefreshAnchorPickup`, persists the
Stellar payment hash as soon as it exists, and marks PAID only after the anchor
reports completion. The unproven part is operational: the treasury must actually
hold the selected anchor asset with the right trustline/balance, and the whole
path needs a live small-amount run.

**Simulation remains dev-only.** `POST /api/simulate/pickup` is still the mock
completion button for local demos. It must stay disabled for real hosted demos
unless a live payout adapter has completed or the response clearly says the
payout is simulated.

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

### B. Port the bridge/funding leg to Polygon/Amoy

Replace the local mock escrow / Base-specific worker with the chosen Polygon
path. The reason for Polygon is native EURe availability: it removes the local
EURe mirror seam and makes the user's IBAN-funded asset live on the same public
chain as the app's settlement contracts.

Use Amoy for testnet work. Keep the existing Base Sepolia CCTP worker as a
reference for Circle burn/attestation/mint mechanics, but do not assume its
contract addresses, source domain, gas asset, or funding checklist carry over.
Confirm the current Polygon/Amoy CCTP deployments and domain from primary
Circle docs before changing config defaults.

Acceptance:

- the orchestrator's funding/bridge step uses Polygon/Amoy when live mode is
  enabled, and the existing dry-run/demo path otherwise
- attestation polling failures compensate rather than strand
- the transfer records the burn tx hash and the Stellar mint, the way other
  legs record `txs` entries
- dry-run remains the default so `npm run e2e` keeps working with no funds

## Prerequisites only the repo owner can supply

Neither task can be *proven* without these. If you cannot get them, say so
explicitly and deliver dry-run code plus tests — do not merge something that
reads as finished but has never executed. That is how bridge code becomes
believable on paper while the corridor still has not moved real value.

- Polygon/Amoy funding for the live worker: native gas token plus whatever
  Circle/partner test asset the chosen path burns or settles
- a Stellar treasury holding the anchor's asset, with the trustline
  established. Note SRT on `testanchor.stellar.org` is obtained through the
  anchor's *interactive deposit flow*, so it is not scriptable
- confirmation of which asset to use: testanchor supports SRT, native and
  USDC for withdrawal
- Monerium configured for Polygon/Amoy so EURe is native on the public-chain
  target rather than mirrored into local Hardhat

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

## Not in scope

- FP4's remaining half (`user.privateKey` still signs Monerium linking and
  redeem orders server-side). Someone is already on it — do not start.
- The mirror seam and its reconciler, except to remove them as part of the
  Polygon migration once native EURe replaces the local mirror.
