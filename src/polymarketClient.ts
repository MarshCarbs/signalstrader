import { ClobClient } from '@polymarket/clob-client';
import { SignatureType } from '@polymarket/order-utils';
import { ethers } from 'ethers';
import type { AppConfig } from './config';

const RPC_CONNECT_TIMEOUT_MS = 8000;
const DEFAULT_RPC_FALLBACKS = [
  'https://polygon-rpc.com',
  'https://rpc.ankr.com/polygon',
  'https://polygon-bor-rpc.publicnode.com',
];

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function buildRpcCandidates(primary: string): string[] {
  const fromEnv = primary
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const merged = [...fromEnv, ...DEFAULT_RPC_FALLBACKS];
  return Array.from(new Set(merged));
}

async function resolveProvider(config: AppConfig): Promise<{ provider: ethers.providers.JsonRpcProvider; rpcUrl: string }> {
  const errors: string[] = [];
  const candidates = buildRpcCandidates(config.rpcUrl);

  for (const rpcUrl of candidates) {
    const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
    try {
      const network = await withTimeout(provider.getNetwork(), RPC_CONNECT_TIMEOUT_MS);
      if (network.chainId !== config.chainId) {
        errors.push(`${rpcUrl} (wrong chainId ${network.chainId})`);
        continue;
      }
      await withTimeout(provider.getBlockNumber(), RPC_CONNECT_TIMEOUT_MS);
      return { provider, rpcUrl };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${rpcUrl} (${message})`);
    }
  }

  throw new Error(
    `No reachable Polygon RPC endpoint. Tried: ${errors.join(' | ')}. ` +
      'Set RPC_URL in .env to a reachable endpoint (or comma-separated endpoint list).'
  );
}

export async function createPolymarketClient(config: AppConfig): Promise<ClobClient> {
  const { provider, rpcUrl } = await resolveProvider(config);
  config.rpcUrl = rpcUrl;

  const signer = new ethers.Wallet(config.privateKey, provider);

  const walletCode = await provider.getCode(config.walletAddress);
  const isSafeWallet = walletCode !== '0x';
  const signatureType = isSafeWallet ? SignatureType.POLY_GNOSIS_SAFE : SignatureType.EOA;

  const baseClient = new ClobClient(
    config.clobHttpUrl,
    config.chainId,
    signer,
    undefined,
    signatureType,
    isSafeWallet ? config.walletAddress : undefined
  );

  let credentials: any;
  try {
    credentials = await baseClient.deriveApiKey();
  } catch {
    credentials = await baseClient.createApiKey();
  }

  if (!credentials?.key) {
    throw new Error('Could not create or derive Polymarket API credentials.');
  }

  return new ClobClient(
    config.clobHttpUrl,
    config.chainId,
    signer,
    credentials,
    signatureType,
    isSafeWallet ? config.walletAddress : undefined
  );
}
