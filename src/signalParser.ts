import type { ParsedRedisMessage, TradingSignal } from './types';

function normalizeDirection(raw: unknown): 'BUY' | 'SELL' {
  const value = String(raw || '').trim().toLowerCase();
  if (value === 'buy' || value === 'b') {
    return 'BUY';
  }
  if (value === 'sell' || value === 's') {
    return 'SELL';
  }
  throw new Error(`Invalid signal direction: ${raw}`);
}

function normalizeToken(raw: unknown): 'UP' | 'DOWN' {
  const value = String(raw || '').trim().toLowerCase();
  if (value === 'up' || value === 'yes' || value === 'long' || value === '1') {
    return 'UP';
  }
  if (value === 'down' || value === 'no' || value === 'short' || value === '0') {
    return 'DOWN';
  }
  throw new Error(`Invalid signal token: ${raw}`);
}

function normalizeTimestamp(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw < 1e12 ? Math.floor(raw * 1000) : Math.floor(raw);
  }

  if (typeof raw === 'string') {
    const asNumber = Number(raw);
    if (Number.isFinite(asNumber)) {
      return asNumber < 1e12 ? Math.floor(asNumber * 1000) : Math.floor(asNumber);
    }

    const parsedDate = Date.parse(raw);
    if (!Number.isNaN(parsedDate)) {
      return parsedDate;
    }
  }

  throw new Error(`Invalid signal timestamp: ${raw}`);
}

function normalizePrice(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid signal price: ${raw}`);
  }

  const price = value > 1 ? value / 100 : value;
  if (price <= 0 || price >= 1) {
    throw new Error(`Signal price must be in (0,1): ${price}`);
  }

  return Number(price.toFixed(4));
}

function normalizeMarketSlug(raw: unknown): string {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) {
    throw new Error('Missing market slug in Redis message.');
  }
  if (!/^[a-z0-9-]{6,}$/.test(value)) {
    throw new Error(`Invalid market slug: ${raw}`);
  }
  return value;
}

function extractObject(rawMessage: string): Record<string, unknown> {
  let payload: unknown;
  try {
    payload = JSON.parse(rawMessage);
  } catch {
    throw new Error('Signal is not valid JSON.');
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Signal payload must be a JSON object.');
  }

  return payload as Record<string, unknown>;
}

function parseSignalPayload(payload: Record<string, unknown>): TradingSignal {
  const timestamp = payload.timestamp ?? payload.ts ?? payload.time;
  const direction = payload.direction ?? payload.side ?? payload.orderSide ?? payload.action;
  const token = payload.token ?? payload.outcome ?? payload.marketSide ?? payload.position;
  const limitPrice = payload.limitPrice ?? payload.limit_price ?? payload.price;
  const marketSlug = payload.market_slug ?? payload.marketSlug ?? payload.slug;

  return {
    timestampMs: normalizeTimestamp(timestamp),
    direction: normalizeDirection(direction),
    token: normalizeToken(token),
    limitPrice: normalizePrice(limitPrice),
    marketSlug: normalizeMarketSlug(marketSlug),
    raw: payload,
  };
}

export function parseSignal(rawMessage: string): TradingSignal {
  const payload = extractObject(rawMessage);
  return parseSignalPayload(payload);
}

export function parseRedisMessage(rawMessage: string): ParsedRedisMessage {
  const payload = extractObject(rawMessage);
  const marketSlugRaw = payload.market_slug ?? payload.marketSlug ?? payload.slug;
  const timestampRaw = payload.timestamp ?? payload.ts ?? payload.time ?? Date.now();
  const hasDirection = payload.direction !== undefined || payload.side !== undefined || payload.orderSide !== undefined || payload.action !== undefined;
  const hasToken = payload.token !== undefined || payload.outcome !== undefined || payload.marketSide !== undefined || payload.position !== undefined;
  const hasPrice = payload.limitPrice !== undefined || payload.limit_price !== undefined || payload.price !== undefined;

  if (!hasDirection && !hasToken && !hasPrice) {
    return {
      kind: 'market',
      update: {
        timestampMs: normalizeTimestamp(timestampRaw),
        marketSlug: normalizeMarketSlug(marketSlugRaw),
        raw: payload,
      },
    };
  }

  return {
    kind: 'signal',
    signal: parseSignalPayload(payload),
  };
}
