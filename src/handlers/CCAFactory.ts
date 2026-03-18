import { CCAFactory } from 'generated';
import { decodeAbiParameters } from 'viem';
import { readTotalSupply, readSteps } from '../utils/effects';

const CONFIG_COMPONENTS = [{ type: 'tuple', components: [
  { name: 'currency',               type: 'address' },
  { name: 'tokensRecipient',        type: 'address' },
  { name: 'fundsRecipient',         type: 'address' },
  { name: 'startBlock',             type: 'uint64'  },
  { name: 'endBlock',               type: 'uint64'  },
  { name: 'claimBlock',             type: 'uint64'  },
  { name: 'tickSpacing',            type: 'uint256' },
  { name: 'validationHook',         type: 'address' },
  { name: 'floorPrice',             type: 'uint256' },
  { name: 'requiredCurrencyRaised', type: 'uint128' },
  { name: 'auctionStepsData',       type: 'bytes'   },
]}] as const;

type DecodedConfig = {
  currency: string;
  validationHook: string;
  startBlock: bigint;
  endBlock: bigint;
  claimBlock: bigint;
  floorPrice: bigint;
  tickSpacing: bigint;
  requiredCurrencyRaised: bigint;
};

function decodeConfig(configData: string): DecodedConfig | null {
  try {
    const [p] = decodeAbiParameters(CONFIG_COMPONENTS, configData as `0x${string}`);
    return {
      currency:               p.currency.toLowerCase(),
      validationHook:         p.validationHook.toLowerCase(),
      startBlock:             BigInt(p.startBlock),
      endBlock:               BigInt(p.endBlock),
      claimBlock:             BigInt(p.claimBlock),
      floorPrice:             p.floorPrice,
      tickSpacing:            p.tickSpacing,
      requiredCurrencyRaised: p.requiredCurrencyRaised,
    };
  } catch {
    return null;
  }
}

CCAFactory.AuctionCreated.contractRegister(({ event, context }) => {
  context.addAuction(event.params.auction);
});

CCAFactory.AuctionCreated.handler(async ({ event, context }) => {
  const cfg = decodeConfig(event.params.configData);
  if (!cfg) return;

  const addr = event.params.auction.toLowerCase();

  context.Auction.set({
    id: addr,
    chainId: event.chainId,
    token: event.params.token.toLowerCase(),
    currency: cfg.currency,
    amount: event.params.amount,
    startBlock: cfg.startBlock,
    endBlock: cfg.endBlock,
    claimBlock: cfg.claimBlock,
    totalSupply: 0n,
    floorPrice: cfg.floorPrice,
    tickSpacing: cfg.tickSpacing,
    validationHook: cfg.validationHook,
    requiredCurrencyRaised: cfg.requiredCurrencyRaised,
    createdAt: BigInt(event.block.number),
    lastCheckpointedBlock: 0n,
    lastClearingPriceQ96: 0n,
    currencyRaised: 0n,
    totalCleared: 0n,
    cumulativeMps: 0,
    remainingMps: 0n,
    availableSupply: 0n,
    currentStepMps: 0,
    currentStepStartBlock: 0n,
    currentStepEndBlock: 0n,
    numBids: 0,
    numBidders: 0,
    totalBidAmount: 0n,
    updatedAt: BigInt(event.block.timestamp),
  });

  if (context.isPreload) return;

  const key = `${event.chainId}:${event.params.auction}`;

  try {
    const totalSupplyStr = await context.effect(readTotalSupply, key);
    const totalSupply = BigInt(totalSupplyStr);
    if (totalSupply > 0n) {
      const auction = await context.Auction.get(addr);
      if (auction) context.Auction.set({ ...auction, totalSupply });
    }
  } catch (err) {
    context.log.warn(`[Factory] readTotalSupply failed for ${addr}: ${(err as Error).message}`);
  }

  let steps: { mps: number; startBlock: number; endBlock: number }[] = [];
  try {
    const stepsJson = await context.effect(readSteps, `${key}:${cfg.startBlock}`);
    steps = JSON.parse(stepsJson) as { mps: number; startBlock: number; endBlock: number }[];
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i]!;
      context.Step.set({ id: `${addr}:${i}`, auctionId: addr, startBlock: BigInt(s.startBlock), endBlock: BigInt(s.endBlock), mps: s.mps });
    }

    if (steps.length > 0) {
      const auction = await context.Auction.get(addr);
      const first = steps[0]!;
      if (auction) {
        context.Auction.set({
          ...auction,
          currentStepMps: first.mps,
          currentStepStartBlock: BigInt(first.startBlock),
          currentStepEndBlock: BigInt(first.endBlock),
          updatedAt: BigInt(event.block.timestamp),
        });
      }
    }
  } catch (err) {
    context.log.warn(`[Factory] readSteps failed for ${addr}: ${(err as Error).message}`);
  }

  context.log.info(`[Factory] Registered auction ${addr} on chain ${event.chainId} with ${steps.length} steps`);
});
