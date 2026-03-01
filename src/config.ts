import * as dotenv from 'dotenv';

dotenv.config();

export interface ClaimConfig {
  enabled: boolean;
  intervalMinutes: number;
  walletAddress: string;
  safeAddress?: string;
  dataApiUrl: string;
  ctfAddress: string;
  collateralTokenAddress: string;
}

export interface AppConfig {
  walletAddress: string;
  privateKey: string;
  chainId: number;
  rpcUrl: string;
  clobHttpUrl: string;
  clobWsUrl: string;
  gammaEventsUrl: string;
  redisHost: string;
  redisPort: number;
  redisChannel: string;
  redisPassword?: string;
  signalMaxAgeMs: number;
  statusIntervalSeconds: number;
  sharesPerTrade: number;
  claim: ClaimConfig;
}

const HARD_CODED_SIGNAL_MAX_AGE_MS = 1000;
const HARD_CODED_STATUS_INTERVAL_SECONDS = 20;
const DEFAULT_CLAIM_INTERVAL_MINUTES = 15;

function getEnv(keys: string[]): string | undefined {
  for (const key of keys) {
    const raw = process.env[key];
    if (typeof raw === 'string' && raw.trim() !== '') {
      return raw.trim();
    }
  }
  return undefined;
}

function requireString(keys: string[]): string {
  const value = getEnv(keys);
  if (!value) {
    throw new Error(`Missing required env var: ${keys.join(' | ')}`);
  }
  return value;
}

function parseIntEnv(keys: string[], fallback: number): number {
  const value = getEnv(keys);
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid integer env var: ${keys.join(' | ')}`);
  }
  return parsed;
}

function parseFloatEnv(keys: string[], fallback: number): number {
  const value = getEnv(keys);
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid number env var: ${keys.join(' | ')}`);
  }
  return parsed;
}

function isAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

function assertAddress(name: string, value: string): void {
  if (!isAddress(value)) {
    throw new Error(`Invalid address for ${name}: ${value}`);
  }
}

export function loadConfig(): AppConfig {
  const walletAddress = requireString(['WALLET_ADDRESS', 'PROXY_WALLET']);
  const privateKey = requireString(['PRIVATE_KEY']);
  const chainId = parseIntEnv(['CHAIN_ID'], 137);
  const rpcUrl = getEnv(['RPC_URL']) || 'https://polygon-rpc.com';
  const clobHttpUrl = getEnv(['CLOB_HTTP_URL']) || 'https://clob.polymarket.com';
  const clobWsUrl = getEnv(['CLOB_WS_URL']) || 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
  const gammaEventsUrl = getEnv(['GAMMA_EVENTS_URL']) || 'https://gamma-api.polymarket.com/events';
  const redisHost = getEnv(['REDIS_HOST', 'COMMUNITY_REDIS_HOST']) || '127.0.0.1';
  const redisPort = parseIntEnv(['REDIS_PORT', 'COMMUNITY_REDIS_PORT'], 6379);
  const redisChannel = getEnv(['REDIS_CHANNEL', 'COMMUNITY_REDIS_CHANNEL']) || 'ODDS_FOR_COMMUNITY';
  const redisPassword = getEnv(['REDIS_PASSWORD', 'REDIS_PW', 'COMMUNITY_REDIS_PASSWORD', 'COMMUNITY_REDIS_PW']);
  const signalMaxAgeMs = HARD_CODED_SIGNAL_MAX_AGE_MS;
  const statusIntervalSeconds = HARD_CODED_STATUS_INTERVAL_SECONDS;
  const sharesPerTrade = parseFloatEnv(['SHARES_PER_TRADE', 'SIZE_PER_TRADE'], 10);

  if (sharesPerTrade <= 0) {
    throw new Error(`SHARES_PER_TRADE must be > 0. Received: ${sharesPerTrade}`);
  }
  if (redisPort <= 0 || redisPort > 65535) {
    throw new Error(`REDIS_PORT must be in range 1..65535. Received: ${redisPort}`);
  }
  if (!redisChannel.trim()) {
    throw new Error('REDIS_CHANNEL must not be empty.');
  }

  assertAddress('WALLET_ADDRESS / PROXY_WALLET', walletAddress);

  const claimIntervalMinutes = parseIntEnv(['CLAIM_INTERVAL_MINUTES'], DEFAULT_CLAIM_INTERVAL_MINUTES);
  const claimWalletAddress = requireString(['CLAIM_WALLET_ADDRESS']);
  const claimSafeAddressRaw = getEnv(['CLAIM_SAFE_ADDRESS']);
  const claimSafeAddress =
    claimSafeAddressRaw ||
    (claimWalletAddress.toLowerCase() !== walletAddress.toLowerCase() ? walletAddress : undefined);
  const claimDataApiUrl = getEnv(['CLAIM_DATA_API_URL']) || 'https://data-api.polymarket.com/positions';
  const claimCtfAddress = getEnv(['CTF_ADDRESS']) || '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
  const claimCollateral = getEnv(['COLLATERAL_TOKEN_ADDRESS', 'USDC_CONTRACT_ADDRESS']) || '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

  assertAddress('CLAIM_WALLET_ADDRESS', claimWalletAddress);
  assertAddress('CTF_ADDRESS', claimCtfAddress);
  assertAddress('COLLATERAL_TOKEN_ADDRESS / USDC_CONTRACT_ADDRESS', claimCollateral);
  if (claimSafeAddress) {
    assertAddress('CLAIM_SAFE_ADDRESS', claimSafeAddress);
  }

  return {
    walletAddress,
    privateKey,
    chainId,
    rpcUrl,
    clobHttpUrl,
    clobWsUrl,
    gammaEventsUrl,
    redisHost,
    redisPort,
    redisChannel,
    redisPassword,
    signalMaxAgeMs,
    statusIntervalSeconds,
    sharesPerTrade,
    claim: {
      enabled: claimIntervalMinutes > 0,
      intervalMinutes: claimIntervalMinutes,
      walletAddress: claimWalletAddress,
      safeAddress: claimSafeAddress,
      dataApiUrl: claimDataApiUrl,
      ctfAddress: claimCtfAddress,
      collateralTokenAddress: claimCollateral,
    },
  };
}
