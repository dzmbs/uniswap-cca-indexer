# uniswap-cca-indexer

Envio HyperIndex indexer for Uniswap Continuous Clearing Auction (CCA) contracts.

- Chains: Ethereum, Base, Arbitrum, Unichain
- Data model: auctions, bids, ticks, steps, checkpoints
- Event source: HyperSync (logs) + selective RPC reads (`eth_call`) for derived state

## Features

- Factory-driven auction discovery (`AuctionCreated`)
- Direct auction indexing support (for custom/non-factory auctions)
- CCA fill math for fully/partially filled bids
- Multicall-bundled reads for hot paths
- Per-effect rate limiting via env vars

## Special case: Aztec auction on Ethereum

The Ethereum auction `0x608c4e792C65f5527B3f70715deA44d3b302F4Ee` is indexed as a direct `Auction` address in `config.yaml`.

Reason: it was not deployed through the currently indexed canonical CCA factory address, so factory discovery alone would not register it.

Implementation details:
- Added static contract registration for that address on chain `1`
- Added lazy auction bootstrap in `Auction` handlers so non-factory auctions can still initialize `Auction` + `Step` rows from on-chain reads

## Project structure

```text
src/
  handlers/
    CCAFactory.ts
    Auction.ts
  utils/
    clients.ts
    effects.ts
    math.ts
  abi.ts
config.yaml
schema.graphql
scripts/
  compare-envio-ponder.mjs
```

## Setup

```bash
pnpm install
cp .env.example .env
pnpm codegen
pnpm dev
```

GraphQL: `http://localhost:8080` (admin secret: `testing`)

## Environment

See `.env.example`.

Required:
- `ENVIO_API_TOKEN`
- `BASE_RPC_URL`
- `ARB_RPC_URL`
- `ETH_RPC_URL`
- `UNICHAIN_RPC_URL`

### RPC rate-limit controls

Effect-level request throttles are configurable via env (requests/second):

- `EFFECT_RPS_READ_TOTAL_SUPPLY` (default `2`)
- `EFFECT_RPS_READ_AUCTION_SNAPSHOT` (default `1`)
- `EFFECT_RPS_READ_STEPS` (default `1`)
- `EFFECT_RPS_READ_CHECKPOINT_BUNDLE` (default `6`)
- `EFFECT_RPS_READ_TICK_AT_BLOCK` (default `3`)
- `EFFECT_RPS_READ_TICK_PAIR` (default `6`)

Recommended tuning plan:
1. Start with defaults.
2. If you see 429s, reduce `READ_CHECKPOINT_BUNDLE` and `READ_TICK_PAIR` first.
3. Increase by +1 only after stable full backfill runs.

## Development commands

```bash
pnpm codegen
pnpm dev
pnpm start
pnpm compare:ponder
```

## Data validation

Use GraphQL aggregates to validate sync and event coverage:

```graphql
query {
  chain_metadata(order_by: { chain_id: asc }) {
    chain_id
    block_height
    latest_processed_block
    num_events_processed
  }
  Auction_aggregate { aggregate { count } }
  Bid_aggregate { aggregate { count } }
  Checkpoint_aggregate { aggregate { count } }
}
```

## Security notes

- `.env` is gitignored. Keep API keys only in local env files or secret managers.
- Never paste live keys into tracked docs/commits.
