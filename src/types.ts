export interface RedisRuntimeConfig {
  host: string;
  port: number;
  channel: string;
  password?: string;
}

export interface ResolvedMarket {
  sourceText: string;
  eventSlug: string;
  marketSlug: string;
  marketQuestion: string;
  upTokenId: string;
  downTokenId: string;
  redisConfigFromInstruction?: RedisRuntimeConfig;
}

export type SignalDirection = 'BUY' | 'SELL';
export type SignalToken = 'UP' | 'DOWN';

export interface TradingSignal {
  timestampMs: number;
  direction: SignalDirection;
  token: SignalToken;
  limitPrice: number;
  marketSlug: string;
  raw: unknown;
}

export interface MarketUpdate {
  timestampMs: number;
  marketSlug: string;
  raw: unknown;
}

export type ParsedRedisMessage =
  | {
      kind: 'signal';
      signal: TradingSignal;
    }
  | {
      kind: 'market';
      update: MarketUpdate;
    };
