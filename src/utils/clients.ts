import { createPublicClient, defineChain, http } from 'viem';
import { base, arbitrum, mainnet } from 'viem/chains';

const unichainMainnet = defineChain({
  id: 130,
  name: 'Unichain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://unichain-rpc.publicnode.com'] } },
  blockExplorers: { default: { name: 'Uniscan', url: 'https://uniscan.xyz' } },
  contracts: {
    multicall3: {
      address: '0xca11bde05977b3631167028862be2a173976ca11',
      blockCreated: 0,
    },
  },
});

const DEFAULT_RPC_URLS: Record<number, string> = {
  1: 'https://eth.llamarpc.com',
  8453: 'https://base.llamarpc.com',
  42161: 'https://api.zan.top/arb-one',
  130: 'https://unichain-rpc.publicnode.com',
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const clients = new Map<number, any>();

export function getClient(chainId: number) {
  if (clients.has(chainId)) return clients.get(chainId);

  let client;
  switch (chainId) {
    case 1: {
      const rpcUrl = process.env.ETH_RPC_URL || DEFAULT_RPC_URLS[1];
      client = createPublicClient({
        chain: mainnet,
        transport: http(rpcUrl),
        batch: { multicall: true },
      });
      break;
    }
    case 8453: {
      const rpcUrl = process.env.BASE_RPC_URL || DEFAULT_RPC_URLS[8453];
      client = createPublicClient({
        chain: base,
        transport: http(rpcUrl),
        batch: { multicall: true },
      });
      break;
    }
    case 42161: {
      const rpcUrl = process.env.ARB_RPC_URL || DEFAULT_RPC_URLS[42161];
      client = createPublicClient({
        chain: arbitrum,
        transport: http(rpcUrl),
        batch: { multicall: true },
      });
      break;
    }
    case 130: {
      const rpcUrl = process.env.UNICHAIN_RPC_URL || DEFAULT_RPC_URLS[130];
      client = createPublicClient({
        chain: unichainMainnet,
        transport: http(rpcUrl),
        batch: { multicall: true },
      });
      break;
    }
    default:
      throw new Error(`Unsupported chain: ${chainId}`);
  }

  clients.set(chainId, client);
  return client;
}
