import WebSocket, { type RawData } from 'ws';
import type { AppConfig } from './config';
import { logInfo, logWarn } from './logger';
import type { ResolvedMarket } from './types';

export class MarketWsConnection {
  private ws: WebSocket | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private market: ResolvedMarket | null = null;
  private started = false;
  private stopped = false;
  private connected = false;
  private lastPriceLogAt = 0;
  private lastTickAtMs: number | null = null;
  private lastTickSummary = 'none';

  constructor(private readonly config: AppConfig) {}

  start(): void {
    this.started = true;
    this.stopped = false;
    if (!this.market) {
      logInfo('WS waiting for market slug from Redis...');
      return;
    }
    this.connect();
  }

  stop(): void {
    this.started = false;
    this.stopped = true;
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.terminate();
      this.ws = null;
    }
    this.connected = false;
  }

  updateMarket(market: ResolvedMarket): void {
    const current = this.market;
    const changed =
      !current ||
      current.marketSlug !== market.marketSlug ||
      current.upTokenId !== market.upTokenId ||
      current.downTokenId !== market.downTokenId;

    this.market = market;
    if (!changed) {
      return;
    }

    this.lastTickAtMs = null;
    this.lastTickSummary = `market=${market.marketSlug}`;
    this.lastPriceLogAt = 0;
    logInfo(`WS market set to ${market.marketSlug}`);

    if (!this.started || this.stopped) {
      return;
    }

    if (this.ws) {
      this.ws.terminate();
      return;
    }
    this.connect();
  }

  private connect(): void {
    if (this.stopped || !this.market) {
      return;
    }

    this.ws = new WebSocket(this.config.clobWsUrl, { perMessageDeflate: false });

    this.ws.on('open', () => {
      if (!this.market) {
        return;
      }
      this.connected = true;
      logInfo(`WS connected for market ${this.market.marketSlug}`);
      this.subscribe();
      this.startPing();
    });

    this.ws.on('message', (buffer: RawData) => {
      this.handleMessage(buffer.toString());
    });

    this.ws.on('error', (error: Error) => {
      logWarn(`WS error: ${error.message}`);
    });

    this.ws.on('close', () => {
      this.stopPing();
      this.connected = false;
      if (this.stopped) {
        return;
      }
      logWarn('WS disconnected. Reconnecting in 2s...');
      this.reconnectTimer = setTimeout(() => this.connect(), 2000);
    });
  }

  private subscribe(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.market) {
      return;
    }

    this.ws.send(
      JSON.stringify({
        type: 'market',
        assets_ids: [this.market.upTokenId, this.market.downTokenId],
      })
    );
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return;
      }
      this.ws.ping();
    }, 15000);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private handleMessage(raw: string): void {
    const market = this.market;
    if (!market) {
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }

    const messages = Array.isArray(payload) ? payload : [payload];
    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') {
        continue;
      }

      const eventType = String((msg as Record<string, unknown>).event_type || '');
      if (eventType !== 'last_trade_price') {
        continue;
      }

      const record = msg as Record<string, unknown>;
      const tokenId = String(record.token_id || record.asset_id || '');
      const price = Number(record.price);
      if (!Number.isFinite(price)) {
        continue;
      }

      const now = Date.now();
      if (now - this.lastPriceLogAt < 15000) {
        continue;
      }

      if (tokenId === market.upTokenId) {
        logInfo(`WS tick UP=${price.toFixed(3)}`);
        this.lastPriceLogAt = now;
        this.lastTickAtMs = now;
        this.lastTickSummary = `UP=${price.toFixed(3)}`;
      } else if (tokenId === market.downTokenId) {
        logInfo(`WS tick DOWN=${price.toFixed(3)}`);
        this.lastPriceLogAt = now;
        this.lastTickAtMs = now;
        this.lastTickSummary = `DOWN=${price.toFixed(3)}`;
      }
    }
  }

  getStats(): { connected: boolean; marketSlug: string | null; lastTickAtMs: number | null; lastTickSummary: string } {
    return {
      connected: this.connected,
      marketSlug: this.market?.marketSlug || null,
      lastTickAtMs: this.lastTickAtMs,
      lastTickSummary: this.lastTickSummary,
    };
  }
}
