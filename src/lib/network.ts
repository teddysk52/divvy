export type Cluster = 'devnet' | 'mainnet-beta' | 'testnet';

export const CLUSTER = ((import.meta.env.VITE_CLUSTER as string) || 'devnet') as Cluster;

const DEFAULT_RPC: Record<Cluster, string> = {
  devnet: 'https://api.devnet.solana.com',
  testnet: 'https://api.testnet.solana.com',
  'mainnet-beta': 'https://api.mainnet-beta.solana.com',
};

export const RPC_URL = (import.meta.env.VITE_RPC_URL as string) || DEFAULT_RPC[CLUSTER];
export const IS_TEST_NETWORK = CLUSTER !== 'mainnet-beta';
