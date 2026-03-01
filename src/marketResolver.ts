import type { AppConfig } from './config';
import type { ResolvedMarket } from './types';

interface GammaMarket {
  slug?: string;
  question?: string;
  title?: string;
  clobTokenIds?: string | string[];
  outcomes?: string | string[];
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  eventSlug?: string;
  event_slug?: string;
  eventTitle?: string;
  event_title?: string;
  event?: {
    slug?: string;
    title?: string;
  };
}

interface GammaEvent {
  slug?: string;
  title?: string;
  markets?: GammaMarket[];
}

function deriveMarketsUrl(eventsUrl: string): string {
  const replaced = eventsUrl.replace(/\/events(?=\/|$|\?)/, '/markets');
  if (replaced !== eventsUrl) {
    return replaced;
  }
  return 'https://gamma-api.polymarket.com/markets';
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter((item) => item.length > 0);
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return [];
    }

    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        return parseStringArray(parsed);
      } catch {
        return [];
      }
    }

    return trimmed
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }

  return [];
}

function chooseUpDownIndices(outcomes: string[], tokenCount: number): [number, number] {
  let upIndex = -1;
  let downIndex = -1;

  outcomes.forEach((raw, index) => {
    const outcome = raw.toLowerCase().trim();
    if (upIndex === -1 && (outcome === 'yes' || outcome.includes('up'))) {
      upIndex = index;
    }
    if (downIndex === -1 && (outcome === 'no' || outcome.includes('down'))) {
      downIndex = index;
    }
  });

  if (upIndex >= 0 && downIndex >= 0 && upIndex !== downIndex) {
    return [upIndex, downIndex];
  }

  return [0, Math.min(1, tokenCount - 1)];
}

function buildResolvedMarket(
  candidate: string,
  market: GammaMarket,
  fallbackEventSlug: string,
  fallbackTitle: string
): ResolvedMarket | null {
  const tokenIds = parseStringArray(market.clobTokenIds);
  if (tokenIds.length < 2) {
    return null;
  }

  const outcomes = parseStringArray(market.outcomes);
  const [upIndex, downIndex] = chooseUpDownIndices(outcomes, tokenIds.length);
  const upTokenId = tokenIds[upIndex];
  const downTokenId = tokenIds[downIndex];
  if (!upTokenId || !downTokenId) {
    return null;
  }

  const eventSlug = market.eventSlug || market.event_slug || market.event?.slug || fallbackEventSlug || candidate;
  const marketQuestion =
    market.question || market.title || market.eventTitle || market.event_title || market.event?.title || fallbackTitle || candidate;

  return {
    sourceText: candidate,
    eventSlug,
    marketSlug: market.slug || candidate,
    marketQuestion,
    upTokenId,
    downTokenId,
  };
}

export async function resolveMarketBySlug(candidate: string, config: AppConfig): Promise<ResolvedMarket> {
  const normalized = String(candidate || '').trim().toLowerCase();
  if (!normalized) {
    throw new Error('Market slug is empty.');
  }

  const url = `${config.gammaEventsUrl}?slug=${encodeURIComponent(normalized)}`;
  const response = await fetch(url);
  if (response.ok) {
    const events = (await response.json()) as GammaEvent[];
    if (Array.isArray(events) && events.length > 0) {
      const event = events[0];
      const markets = Array.isArray(event.markets) ? event.markets : [];
      if (markets.length > 0) {
        const market = markets.find((entry) => entry.active !== false && !entry.closed && !entry.archived) || markets[0];
        const resolved = buildResolvedMarket(normalized, market, event.slug || normalized, event.title || normalized);
        if (resolved) {
          return resolved;
        }
      }
    }
  }

  const marketsUrl = deriveMarketsUrl(config.gammaEventsUrl);
  const marketResponse = await fetch(`${marketsUrl}?slug=${encodeURIComponent(normalized)}`);
  if (!marketResponse.ok) {
    throw new Error(`Gamma market lookup failed with HTTP ${marketResponse.status} for slug ${normalized}`);
  }

  const markets = (await marketResponse.json()) as GammaMarket[];
  if (!Array.isArray(markets) || markets.length === 0) {
    throw new Error(`No market found for slug ${normalized}`);
  }

  const market = markets.find((entry) => entry.active !== false && !entry.closed && !entry.archived) || markets[0];
  const resolved = buildResolvedMarket(normalized, market, normalized, normalized);
  if (!resolved) {
    throw new Error(`Market ${normalized} has no usable token ids.`);
  }
  return resolved;
}
