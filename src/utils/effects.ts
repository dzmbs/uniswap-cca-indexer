import { createEffect, S } from 'envio';
import { AuctionABI } from '../abi';
import { getClient } from './clients';

type RatePerSecond = { calls: number; per: 'second' };

function effectRate(envKey: string, fallback: number): RatePerSecond {
  const parsed = Number(process.env[envKey]);
  if (Number.isFinite(parsed) && parsed > 0) return { calls: Math.floor(parsed), per: 'second' };
  return { calls: fallback, per: 'second' };
}

function splitKey2(key: string): [number, `0x${string}`] {
  const idx = key.indexOf(':');
  const chainId = parseInt(key.slice(0, idx));
  const address = key.slice(idx + 1) as `0x${string}`;
  return [chainId, address];
}

// --- totalSupply ---
// cache: false — may be 0 at auction creation; TokensReceived event updates it.
export const readTotalSupply = createEffect(
  {
    name: 'readTotalSupply',
    input: S.string,
    output: S.string,
    rateLimit: effectRate('EFFECT_RPS_READ_TOTAL_SUPPLY', 40),
    cache: false,
  },
  async ({ input }) => {
    const [chainId, address] = splitKey2(input);
    const result = await getClient(chainId).readContract({ address, abi: AuctionABI, functionName: 'totalSupply' });
    return result.toString();
  },
);

// --- auction snapshot ---
// Reads core auction fields for direct-address indexing where AuctionCreated may not be present.
// Input: "chainId:address:blockNumber"
export const readAuctionSnapshot = createEffect(
  {
    name: 'readAuctionSnapshot',
    input: S.string,
    output: S.string,
    rateLimit: effectRate('EFFECT_RPS_READ_AUCTION_SNAPSHOT', 20),
    cache: true,
  },
  async ({ input }) => {
    const first = input.indexOf(':');
    const second = input.indexOf(':', first + 1);
    const chainId = parseInt(input.slice(0, first));
    const address = input.slice(first + 1, second) as `0x${string}`;
    const blockNumber = BigInt(input.slice(second + 1));
    const client = getClient(chainId);

    const [token, currency, validationHook, startBlock, endBlock, claimBlock, floorPrice, tickSpacing, totalSupply] =
      await Promise.all([
        client.readContract({ address, abi: AuctionABI, functionName: 'token', blockNumber }),
        client.readContract({ address, abi: AuctionABI, functionName: 'currency', blockNumber }),
        client.readContract({ address, abi: AuctionABI, functionName: 'validationHook', blockNumber }),
        client.readContract({ address, abi: AuctionABI, functionName: 'startBlock', blockNumber }),
        client.readContract({ address, abi: AuctionABI, functionName: 'endBlock', blockNumber }),
        client.readContract({ address, abi: AuctionABI, functionName: 'claimBlock', blockNumber }),
        client.readContract({ address, abi: AuctionABI, functionName: 'floorPrice', blockNumber }),
        client.readContract({ address, abi: AuctionABI, functionName: 'tickSpacing', blockNumber }),
        client.readContract({ address, abi: AuctionABI, functionName: 'totalSupply', blockNumber }),
      ]);

    return JSON.stringify({
      token: token.toLowerCase(),
      currency: currency.toLowerCase(),
      validationHook: validationHook.toLowerCase(),
      startBlock: Number(startBlock),
      endBlock: Number(endBlock),
      claimBlock: Number(claimBlock),
      floorPrice: floorPrice.toString(),
      tickSpacing: tickSpacing.toString(),
      totalSupply: totalSupply.toString(),
    });
  },
);

// --- SSTORE2 steps ---
// cache: true — pointer bytecode is immutable once deployed.
// Input: "chainId:address:startBlock"
export const readSteps = createEffect(
  {
    name: 'readSteps',
    input: S.string,
    output: S.string,
    rateLimit: effectRate('EFFECT_RPS_READ_STEPS', 40),
    cache: true,
  },
  async ({ input }) => {
    const first = input.indexOf(':');
    const second = input.indexOf(':', first + 1);
    const chainId = parseInt(input.slice(0, first));
    const address = input.slice(first + 1, second) as `0x${string}`;
    const startBlock = parseInt(input.slice(second + 1));
    const client = getClient(chainId);

    const pointer = await client.readContract({ address, abi: AuctionABI, functionName: 'pointer' });
    const code = await client.getCode({ address: pointer as `0x${string}` });

    if (!code || code.length <= 4) return JSON.stringify([]);

    // code = "0x" + "00" (STOP byte) + packed step data
    // Each step: 8 bytes = 16 hex chars — [3 bytes mps][5 bytes blockDelta]
    const data = code.slice(4);
    const steps: { mps: number; startBlock: number; endBlock: number }[] = [];
    let stepStart = startBlock;

    for (let i = 0; i < data.length; i += 16) {
      const chunk = data.slice(i, i + 16);
      if (chunk.length < 16) break;
      const mps = parseInt(chunk.slice(0, 6), 16);
      const blockDelta = parseInt(chunk.slice(6), 16);
      const stepEnd = stepStart + blockDelta;
      steps.push({ mps, startBlock: stepStart, endBlock: stepEnd });
      stepStart = stepEnd;
    }

    return JSON.stringify(steps);
  },
);

// --- Checkpoint bundle ---
// Reads checkpoints() + totalCleared() + currencyRaised() in ONE multicall.
// Input: "chainId:address:checkpointBlock:readBlock"
// cache: false — live state changes every checkpoint.
export const readCheckpointBundle = createEffect(
  {
    name: 'readCheckpointBundle',
    input: S.string,
    output: S.string,
    rateLimit: effectRate('EFFECT_RPS_READ_CHECKPOINT_BUNDLE', 50),
    cache: false,
  },
  async ({ input }) => {
    const parts = input.split(':');
    const chainId = parseInt(parts[0]!);
    const address = parts[1]! as `0x${string}`;
    const checkpointBlock = BigInt(parts[2]!);
    const readBlock = BigInt(parts[3]!);
    const client = getClient(chainId);

    const [cp, totalCleared, currencyRaised] = await client.multicall({
      contracts: [
        { address, abi: AuctionABI, functionName: 'checkpoints', args: [checkpointBlock] },
        { address, abi: AuctionABI, functionName: 'totalCleared' },
        { address, abi: AuctionABI, functionName: 'currencyRaised' },
      ],
      allowFailure: false,
      blockNumber: readBlock,
    });

    return JSON.stringify({
      currencyRaisedAtClearingPriceQ96_X7: cp.currencyRaisedAtClearingPriceQ96_X7.toString(),
      cumulativeMpsPerPrice: cp.cumulativeMpsPerPrice.toString(),
      totalCleared: totalCleared.toString(),
      currencyRaised: currencyRaised.toString(),
    });
  },
);

// --- Tick at block ---
// Reads ticks(price) at a specific block number.
// Input: "chainId:address:priceQ96:blockNumber"
// cache: false — tick linked list and demand mutate as bids arrive.
export const readTickAtBlock = createEffect(
  {
    name: 'readTickAtBlock',
    input: S.string,
    output: S.string,
    rateLimit: effectRate('EFFECT_RPS_READ_TICK_AT_BLOCK', 40),
    cache: false,
  },
  async ({ input }) => {
    const parts = input.split(':');
    const chainId = parseInt(parts[0]!);
    const address = parts[1]! as `0x${string}`;
    const price = BigInt(parts[2]!);
    const blockNumber = BigInt(parts[3]!);
    const tick = await getClient(chainId).readContract({
      address,
      abi: AuctionABI,
      functionName: 'ticks',
      args: [price],
      blockNumber,
    });

    return JSON.stringify({ next: tick.next.toString(), currencyDemandQ96: tick.currencyDemandQ96.toString() });
  },
);

// --- Tick pair ---
// Reads one or two ticks in a single multicall.
// Input: "chainId:address:currentPriceQ96:prevPriceQ96:blockNumber" (prevPriceQ96 = "0" if no previous tick)
// cache: false — tick linked list and demand mutate as bids arrive.
export const readTickPair = createEffect(
  {
    name: 'readTickPair',
    input: S.string,
    output: S.string,
    rateLimit: effectRate('EFFECT_RPS_READ_TICK_PAIR', 50),
    cache: false,
  },
  async ({ input }) => {
    const parts = input.split(':');
    const chainId = parseInt(parts[0]!);
    const address = parts[1]! as `0x${string}`;
    const currentPrice = BigInt(parts[2]!);
    const prevPrice = BigInt(parts[3]!);
    const blockNumber = BigInt(parts[4]!);
    const client = getClient(chainId);

    if (prevPrice === 0n) {
      const tick = await client.readContract({
        address,
        abi: AuctionABI,
        functionName: 'ticks',
        args: [currentPrice],
        blockNumber,
      });
      return JSON.stringify({
        tick: { next: tick.next.toString(), currencyDemandQ96: tick.currencyDemandQ96.toString() },
        prevTick: null,
      });
    }

    const [tick, prevTick] = await client.multicall({
      contracts: [
        { address, abi: AuctionABI, functionName: 'ticks', args: [currentPrice] },
        { address, abi: AuctionABI, functionName: 'ticks', args: [prevPrice] },
      ],
      allowFailure: false,
      blockNumber,
    });

    return JSON.stringify({
      tick: { next: tick.next.toString(), currencyDemandQ96: tick.currencyDemandQ96.toString() },
      prevTick: { next: prevTick.next.toString(), currencyDemandQ96: prevTick.currencyDemandQ96.toString() },
    });
  },
);
