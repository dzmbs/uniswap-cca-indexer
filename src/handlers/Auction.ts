import { Auction as AuctionContract } from 'generated';
import { MPS, Q96, RESOLUTION, q96ToWei } from '../utils/math';
import { readAuctionSnapshot, readCheckpointBundle, readSteps, readTickAtBlock, readTickPair } from '../utils/effects';

// --- Types ---

type CheckpointLike = {
  blockNumber: bigint;
  clearingPriceQ96: bigint;
  cumulativeMps: number;
  cumulativeMpsPerPrice: bigint;
  currencyRaisedAtClearingPriceQ96_X7: bigint;
};

function checkpointAtOrBefore(checkpoints: CheckpointLike[], blockNumber: bigint): CheckpointLike | undefined {
  return checkpoints
    .filter((c: CheckpointLike) => c.blockNumber <= blockNumber)
    .sort((a: CheckpointLike, b: CheckpointLike) => Number(b.blockNumber - a.blockNumber))[0];
}

async function ensureAuctionLoaded(event: any, context: any, auction: any) {
  if (auction) return auction;

  try {
    const addr = event.srcAddress.toLowerCase();
    const snapshotJson = await context.effect(
      readAuctionSnapshot,
      `${event.chainId}:${event.srcAddress}:${event.block.number.toString()}`,
    );
    const snapshot = JSON.parse(snapshotJson) as {
      token: string;
      currency: string;
      validationHook: string;
      startBlock: number;
      endBlock: number;
      claimBlock: number;
      floorPrice: string;
      tickSpacing: string;
      totalSupply: string;
    };

    const created = {
      id: addr,
      chainId: event.chainId,
      token: snapshot.token,
      currency: snapshot.currency,
      amount: BigInt(snapshot.totalSupply),
      startBlock: BigInt(snapshot.startBlock),
      endBlock: BigInt(snapshot.endBlock),
      claimBlock: BigInt(snapshot.claimBlock),
      totalSupply: BigInt(snapshot.totalSupply),
      floorPrice: BigInt(snapshot.floorPrice),
      tickSpacing: BigInt(snapshot.tickSpacing),
      validationHook: snapshot.validationHook,
      requiredCurrencyRaised: 0n,
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
    };

    const stepsJson = await context.effect(readSteps, `${event.chainId}:${event.srcAddress}:${snapshot.startBlock}`);
    const steps: { mps: number; startBlock: number; endBlock: number }[] = JSON.parse(stepsJson);
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i]!;
      context.Step.set({ id: `${addr}:${i}`, auctionId: addr, startBlock: BigInt(s.startBlock), endBlock: BigInt(s.endBlock), mps: s.mps });
    }

    if (steps.length > 0) {
      const first = steps[0]!;
      created.currentStepMps = first.mps;
      created.currentStepStartBlock = BigInt(first.startBlock);
      created.currentStepEndBlock = BigInt(first.endBlock);
    }

    context.Auction.set(created);
    return created;
  } catch (err) {
    context.log.warn(`[Auction] bootstrap failed for ${event.srcAddress.toLowerCase()}: ${(err as Error).message}`);
    return auction;
  }
}

// --- TokensReceived ---

AuctionContract.TokensReceived.handler(async ({ event, context }) => {
  const addr = event.srcAddress.toLowerCase();
  let auction = await context.Auction.get(addr);
  auction = await ensureAuctionLoaded(event, context, auction);
  if (!auction) return;
  context.Auction.set({ ...auction, totalSupply: event.params.totalSupply });
});

// --- AuctionStepRecorded ---

AuctionContract.AuctionStepRecorded.handler(async ({ event, context }) => {
  const addr = event.srcAddress.toLowerCase();
  let auction = await context.Auction.get(addr);
  auction = await ensureAuctionLoaded(event, context, auction);
  if (!auction) return;
  context.Auction.set({
    ...auction,
    currentStepMps: Number(event.params.mps),
    currentStepStartBlock: BigInt(event.params.startBlock),
    currentStepEndBlock: BigInt(event.params.endBlock),
    updatedAt: BigInt(event.block.timestamp),
  });
});

// --- TickInitialized ---

AuctionContract.TickInitialized.handler(async ({ event, context }) => {
  const addr = event.srcAddress.toLowerCase();
  context.Tick.set({
    id: `${addr}:${event.params.price.toString()}`,
    auctionId: addr,
    priceQ96: event.params.price,
    nextPriceQ96: 0n,
    currencyDemand: 0n,
    numBids: 0,
  });
});

// --- BidSubmitted ---

AuctionContract.BidSubmitted.handler(async ({ event, context }) => {
  const addr = event.srcAddress.toLowerCase();

  let auction = await context.Auction.get(addr);
  const existingBids = await context.Bid.getWhere.auctionId.eq(addr);
  const allTicks = await context.Tick.getWhere.auctionId.eq(addr);

  auction = await ensureAuctionLoaded(event, context, auction);
  if (!auction) return;

  const bidId = `${addr}:${event.params.id.toString()}`;

  context.Bid.set({
    id: bidId,
    auctionId: addr,
    amount: event.params.amount,
    maxPriceQ96: event.params.price,
    owner: event.params.owner.toLowerCase(),
    startBlock: BigInt(event.block.number),
    transactionHash: event.transaction.hash,
    tokensFilled: 0n,
    amountFilled: 0n,
    tokensClaimed: 0n,
    amountRefunded: 0n,
    exited: false,
    claimed: false,
    lastFullyFilledCheckpointBlock: BigInt(event.block.number),
    outbidCheckpointBlock: undefined,
    exitedBlock: undefined,
    exitTransactionHash: undefined,
    claimedBlock: undefined,
    claimTransactionHash: undefined,
  });

  const uniqueOwners = new Set(existingBids.map((b) => b.owner));
  uniqueOwners.add(event.params.owner.toLowerCase());

  context.Auction.set({
    ...auction,
    numBids: auction.numBids + 1,
    numBidders: uniqueOwners.size,
    totalBidAmount: auction.totalBidAmount + event.params.amount,
    updatedAt: BigInt(event.block.timestamp),
  });

  const prevTick = allTicks
    .filter((t) => t.priceQ96 < event.params.price)
    .sort((a, b) => (a.priceQ96 === b.priceQ96 ? 0 : a.priceQ96 > b.priceQ96 ? -1 : 1))[0];

  if (context.isPreload) return;

  const prevPrice = prevTick?.priceQ96 ?? 0n;
  let pairData: {
    tick: { next: string; currencyDemandQ96: string };
    prevTick: { next: string; currencyDemandQ96: string } | null;
  };
  try {
    const pairJson = await context.effect(
      readTickPair,
      `${event.chainId}:${event.srcAddress}:${event.params.price.toString()}:${prevPrice.toString()}:${event.block.number.toString()}`,
    );
    pairData = JSON.parse(pairJson) as {
      tick: { next: string; currencyDemandQ96: string };
      prevTick: { next: string; currencyDemandQ96: string } | null;
    };
  } catch (err) {
    context.log.warn(
      `[Auction] readTickPair failed auction=${addr} chain=${event.chainId} block=${event.block.number} bidId=${event.params.id.toString()} err=${(err as Error).message}`,
    );
    return;
  }

  const tickId = `${addr}:${event.params.price.toString()}`;
  const existingTick = allTicks.find((t) => t.id === tickId);
  context.Tick.set({
    id: tickId,
    auctionId: addr,
    priceQ96: event.params.price,
    nextPriceQ96: BigInt(pairData.tick.next),
    currencyDemand: q96ToWei(BigInt(pairData.tick.currencyDemandQ96)),
    numBids: (existingTick?.numBids ?? 0) + 1,
  });

  if (prevTick && pairData.prevTick) {
    context.Tick.set({ ...prevTick, nextPriceQ96: BigInt(pairData.prevTick.next) });
  }
});

// --- CheckpointUpdated ---

AuctionContract.CheckpointUpdated.handler(async ({ event, context }) => {
  const addr = event.srcAddress.toLowerCase();

  let auction = await context.Auction.get(addr);
  const allBids = await context.Bid.getWhere.auctionId.eq(addr);
  const allCheckpoints = await context.Checkpoint.getWhere.auctionId.eq(addr);

  auction = await ensureAuctionLoaded(event, context, auction);
  if (!auction) return;
  if (context.isPreload) return;

  const blockNumberStr = event.params.blockNumber.toString();

  let bundle: {
    currencyRaisedAtClearingPriceQ96_X7: string;
    cumulativeMpsPerPrice: string;
    totalCleared: string;
    currencyRaised: string;
  };
  try {
    const bundleJson = await context.effect(
      readCheckpointBundle,
      `${event.chainId}:${event.srcAddress}:${blockNumberStr}:${event.block.number.toString()}`,
    );
    bundle = JSON.parse(bundleJson) as {
      currencyRaisedAtClearingPriceQ96_X7: string;
      cumulativeMpsPerPrice: string;
      totalCleared: string;
      currencyRaised: string;
    };
  } catch (err) {
    context.log.warn(
      `[Auction] readCheckpointBundle failed auction=${addr} chain=${event.chainId} block=${event.block.number} cpBlock=${blockNumberStr} err=${(err as Error).message}`,
    );
    return;
  }

  const cpBlockNumber = BigInt(event.params.blockNumber);

  const cp = {
    id: `${addr}:${blockNumberStr}`,
    auctionId: addr,
    blockNumber: cpBlockNumber,
    clearingPriceQ96: event.params.clearingPrice,
    currencyRaisedAtClearingPriceQ96_X7: BigInt(bundle.currencyRaisedAtClearingPriceQ96_X7),
    cumulativeMps: Number(event.params.cumulativeMps),
    cumulativeMpsPerPrice: BigInt(bundle.cumulativeMpsPerPrice),
  };

  context.Checkpoint.set(cp);

  const remainingMps = MPS - BigInt(cp.cumulativeMps);
  const availableSupply =
    remainingMps > 0n ? auction.totalSupply - auction.totalSupply / remainingMps : 0n;

  context.Auction.set({
    ...auction,
    cumulativeMps: cp.cumulativeMps,
    lastCheckpointedBlock: cp.blockNumber,
    lastClearingPriceQ96: cp.clearingPriceQ96,
    currencyRaised: BigInt(bundle.currencyRaised),
    totalCleared: BigInt(bundle.totalCleared),
    remainingMps,
    availableSupply,
    updatedAt: BigInt(event.block.timestamp),
  });

  const bidsFullyFilled = allBids.filter((b) => b.maxPriceQ96 > cp.clearingPriceQ96 && !b.exited);
  const bidsPartiallyFilled = allBids.filter(
    (b) => b.maxPriceQ96 === cp.clearingPriceQ96 && !b.exited && b.outbidCheckpointBlock == null,
  );

  let tickDemandQ96 = 0n;
  if (bidsPartiallyFilled.length > 0) {
    try {
      const tickJson = await context.effect(
        readTickAtBlock,
        `${event.chainId}:${event.srcAddress}:${cp.clearingPriceQ96.toString()}:${event.block.number.toString()}`,
      );
      const tickData = JSON.parse(tickJson) as { currencyDemandQ96: string };
      tickDemandQ96 = BigInt(tickData.currencyDemandQ96);
    } catch (err) {
      context.log.warn(
        `[Auction] readTickAtBlock failed auction=${addr} chain=${event.chainId} block=${event.block.number} price=${cp.clearingPriceQ96.toString()} err=${(err as Error).message}`,
      );
      return;
    }
  }

  // Build checkpoint lookup map using bigint keys (as strings for Map compatibility).
  const cpMap = new Map<string, CheckpointLike>();
  for (const c of allCheckpoints) cpMap.set(c.blockNumber.toString(), c);
  cpMap.set(cp.blockNumber.toString(), cp);

  for (const b of bidsFullyFilled) {
    const bidCp = cpMap.get(b.startBlock.toString()) ?? checkpointAtOrBefore(allCheckpoints, b.startBlock);
    if (!bidCp) continue;

    const mpsRemaining = MPS - BigInt(bidCp.cumulativeMps);
    if (mpsRemaining === 0n) continue;

    const cumulativeMpsDelta = BigInt(cp.cumulativeMps - bidCp.cumulativeMps);
    const cumulativeMpsPerPriceDelta = cp.cumulativeMpsPerPrice - bidCp.cumulativeMpsPerPrice;

    const tokensFilled = (b.amount * cumulativeMpsPerPriceDelta) / (Q96 * mpsRemaining);
    const amountFilled = tokensFilled !== 0n ? (b.amount * cumulativeMpsDelta) / mpsRemaining : 0n;

    context.Bid.set({ ...b, tokensFilled, amountFilled, lastFullyFilledCheckpointBlock: cp.blockNumber });
  }

  if (bidsPartiallyFilled.length > 0) {
    const lastFullyCp = allCheckpoints
      .filter((c: CheckpointLike) => c.clearingPriceQ96 < cp.clearingPriceQ96)
      .sort((a: CheckpointLike, b: CheckpointLike) => Number(b.blockNumber - a.blockNumber))[0];

    for (const b of bidsPartiallyFilled) {
      const bidCp = cpMap.get(b.startBlock.toString()) ?? checkpointAtOrBefore(allCheckpoints, b.startBlock);
      if (!bidCp) continue;

      const mpsRemaining = MPS - BigInt(bidCp.cumulativeMps);
      if (mpsRemaining === 0n) continue;

      let tokensFilled = 0n;
      let currencySpent = 0n;
      if (lastFullyCp) {
        const cumulativeMpsDelta = BigInt(lastFullyCp.cumulativeMps - bidCp.cumulativeMps);
        const cumulativeMpsPerPriceDelta = lastFullyCp.cumulativeMpsPerPrice - bidCp.cumulativeMpsPerPrice;
        tokensFilled = (b.amount * cumulativeMpsPerPriceDelta) / (Q96 * mpsRemaining);
        currencySpent = tokensFilled !== 0n ? (b.amount * cumulativeMpsDelta) / mpsRemaining : 0n;
      }

      const denominator = tickDemandQ96 * mpsRemaining;
      if (denominator > 0n) {
        const partialCurrency =
          (b.amount * cp.currencyRaisedAtClearingPriceQ96_X7 + denominator - 1n) / denominator;
        const bidAmountQ96 = b.amount << RESOLUTION;
        const partialTokens =
          (bidAmountQ96 * cp.currencyRaisedAtClearingPriceQ96_X7) / denominator / b.maxPriceQ96;
        currencySpent += partialCurrency;
        tokensFilled += partialTokens;
      }

      context.Bid.set({ ...b, tokensFilled, amountFilled: currencySpent });
    }
  }

  for (const b of allBids) {
    if (b.maxPriceQ96 < cp.clearingPriceQ96 && b.outbidCheckpointBlock == null) {
      context.Bid.set({ ...b, outbidCheckpointBlock: cp.blockNumber });
    }
  }

  context.log.info(`[Auction] Checkpoint ${addr} block=${cp.blockNumber} clearingPrice=${cp.clearingPriceQ96} mps=${cp.cumulativeMps}`);
});

// --- BidExited ---

AuctionContract.BidExited.handler(async ({ event, context }) => {
  const addr = event.srcAddress.toLowerCase();
  const bidId = `${addr}:${event.params.bidId.toString()}`;

  const [bid, auction] = await Promise.all([
    context.Bid.get(bidId),
    context.Auction.get(addr),
  ]);

  if (!bid) return;

  context.Bid.set({
    ...bid,
    exited: true,
    exitedBlock: BigInt(event.block.number),
    exitTransactionHash: event.transaction.hash,
    tokensFilled: event.params.tokensFilled,
    amountFilled: bid.amount - event.params.currencyRefunded,
    amountRefunded: event.params.currencyRefunded,
  });

  if (auction) {
    context.Auction.set({
      ...auction,
      totalBidAmount: auction.totalBidAmount - event.params.currencyRefunded,
    });
  }
});

// --- TokensClaimed ---

AuctionContract.TokensClaimed.handler(async ({ event, context }) => {
  const addr = event.srcAddress.toLowerCase();
  const bidId = `${addr}:${event.params.bidId.toString()}`;

  const bid = await context.Bid.get(bidId);
  if (!bid) return;

  context.Bid.set({
    ...bid,
    claimed: true,
    claimedBlock: BigInt(event.block.number),
    claimTransactionHash: event.transaction.hash,
    tokensClaimed: event.params.tokensFilled,
    tokensFilled: event.params.tokensFilled,
  });
});
