import { createPublicClient, defineChain, http } from 'viem';
import { base, arbitrum, mainnet } from 'viem/chains';

const unichainMainnet = defineChain({
  id: 130,
  name: 'Unichain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://unichain-mainnet.g.alchemy.com/v2'] } },
  blockExplorers: { default: { name: 'Uniscan', url: 'https://uniscan.xyz' } },
  contracts: {
    multicall3: {
      address: '0xca11bde05977b3631167028862be2a173976ca11',
      blockCreated: 0,
    },
  },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const clients = new Map<number, any>();

export function getClient(chainId: number) {
  if (clients.has(chainId)) return clients.get(chainId);

  let client;
  switch (chainId) {
    case 1:
      if (!process.env.ETH_RPC_URL) throw new Error('ETH_RPC_URL not set');
      client = createPublicClient({
        chain: mainnet,
        transport: http(process.env.ETH_RPC_URL),
        batch: { multicall: true },
      });
      break;
    case 8453:
      if (!process.env.BASE_RPC_URL) throw new Error('BASE_RPC_URL not set');
      client = createPublicClient({
        chain: base,
        transport: http(process.env.BASE_RPC_URL),
        batch: { multicall: true },
      });
      break;
    case 42161:
      if (!process.env.ARB_RPC_URL) throw new Error('ARB_RPC_URL not set');
      client = createPublicClient({
        chain: arbitrum,
        transport: http(process.env.ARB_RPC_URL),
        batch: { multicall: true },
      });
      break;
    case 130:
      if (!process.env.UNICHAIN_RPC_URL) throw new Error('UNICHAIN_RPC_URL not set');
      client = createPublicClient({
        chain: unichainMainnet,
        transport: http(process.env.UNICHAIN_RPC_URL),
        batch: { multicall: true },
      });
      break;
    default:
      throw new Error(`Unsupported chain: ${chainId}`);
  }

  clients.set(chainId, client);
  return client;
}
