import { ClobClient, OrderType, Side } from '@polymarket/clob-client';
import type { AppConfig } from './config';
import { logInfo, logWarn } from './logger';
import type { ResolvedMarket, TradingSignal } from './types';

const SELL_SAFETY_BUFFER_SHARES = 0.5;
const SELL_SIZE_DECIMALS = 1;

export class TradeExecutor {
  private market: ResolvedMarket | null = null;
  private sentCount = 0;
  private failedCount = 0;
  private lastTradeAtMs: number | null = null;
  private lastOrderId: string | null = null;
  private lastTradeSummary = 'none';
  private knownShares: Record<'UP' | 'DOWN', number> = { UP: 0, DOWN: 0 };

  constructor(private readonly client: ClobClient, private readonly config: AppConfig) {}

  updateMarket(market: ResolvedMarket): void {
    const changed =
      !this.market ||
      this.market.marketSlug !== market.marketSlug ||
      this.market.upTokenId !== market.upTokenId ||
      this.market.downTokenId !== market.downTokenId;

    this.market = market;
    if (changed) {
      this.knownShares = { UP: 0, DOWN: 0 };
      logInfo(`Trade executor market set to ${market.marketSlug}`);
    }
  }

  private mapTokenToId(token: 'UP' | 'DOWN'): string {
    if (!this.market) {
      throw new Error('No active market is set.');
    }
    return token === 'UP' ? this.market.upTokenId : this.market.downTokenId;
  }

  private mapDirection(direction: 'BUY' | 'SELL'): Side {
    return direction === 'BUY' ? Side.BUY : Side.SELL;
  }

  private parseMaybeFixed6(value: unknown): number {
    if (value === undefined || value === null) {
      return 0;
    }
    const text = String(value).trim().replace(/^['"]|['"]$/g, '');
    if (!text) {
      return 0;
    }
    if (text.includes('.')) {
      const parsedFloat = Number.parseFloat(text);
      return Number.isFinite(parsedFloat) ? parsedFloat : 0;
    }
    const parsedNumber = Number(text);
    if (!Number.isFinite(parsedNumber)) {
      return 0;
    }
    if (Math.abs(parsedNumber) >= 100000) {
      return parsedNumber / 1_000_000;
    }
    return parsedNumber;
  }

  private roundDown(value: number, decimals: number): number {
    const factor = Math.pow(10, decimals);
    return Math.floor(value * factor) / factor;
  }

  private async syncConditionalBalance(token: 'UP' | 'DOWN', tokenId: string): Promise<number> {
    const client = this.client as any;
    if (typeof client.getBalanceAllowance !== 'function') {
      return this.knownShares[token];
    }

    try {
      if (typeof client.updateBalanceAllowance === 'function') {
        await client.updateBalanceAllowance({ asset_type: 'CONDITIONAL', token_id: String(tokenId) });
      }
      const response = await client.getBalanceAllowance({ asset_type: 'CONDITIONAL', token_id: String(tokenId) });
      const balance = this.parseMaybeFixed6(response?.balance);
      if (Number.isFinite(balance) && balance >= 0) {
        this.knownShares[token] = balance;
      }
      return this.knownShares[token];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logWarn(`Could not refresh ${token} balance. Using cached value ${this.knownShares[token]} (${message}).`);
      return this.knownShares[token];
    }
  }

  private async computeOrderSize(signal: TradingSignal, tokenId: string): Promise<number> {
    if (signal.direction === 'BUY') {
      return this.config.sharesPerTrade;
    }

    const availableShares = await this.syncConditionalBalance(signal.token, tokenId);
    const tradeCap = Math.min(this.config.sharesPerTrade, availableShares);
    const buffered = tradeCap - SELL_SAFETY_BUFFER_SHARES;
    const roundedDown = this.roundDown(buffered, SELL_SIZE_DECIMALS);
    return Number(roundedDown.toFixed(SELL_SIZE_DECIMALS));
  }

  async execute(signal: TradingSignal): Promise<void> {
    if (!this.market) {
      throw new Error(`No active market yet. Cannot execute signal for ${signal.marketSlug}.`);
    }

    if (signal.marketSlug !== this.market.marketSlug) {
      throw new Error(`Signal market mismatch. Active=${this.market.marketSlug}, signal=${signal.marketSlug}`);
    }

    const tokenId = this.mapTokenToId(signal.token);
    const side = this.mapDirection(signal.direction);
    const size = await this.computeOrderSize(signal, tokenId);
    const price = Number(Math.min(0.99, Math.max(0.01, signal.limitPrice)).toFixed(2));
    const notional = Number((size * price).toFixed(2));

    if (size <= 0) {
      this.lastTradeAtMs = Date.now();
      this.lastTradeSummary = `SKIPPED ${signal.direction} ${signal.token} (insufficient shares after -${SELL_SAFETY_BUFFER_SHARES} buffer)`;
      logWarn(this.lastTradeSummary);
      return;
    }

    if (notional < 1) {
      logWarn(`Order below $1 notional may fail (size=${size}, price=${price}).`);
    }

    const signedOrder = await this.client.createOrder({
      tokenID: tokenId,
      side,
      price,
      size,
      expiration: 0,
      feeRateBps: 1000,
    });

    try {
      const response: any = await this.client.postOrder(signedOrder, OrderType.FOK);
      const orderId = response?.orderID ? String(response.orderID) : 'n/a';

      this.sentCount += 1;
      this.lastTradeAtMs = Date.now();
      this.lastOrderId = orderId;
      this.lastTradeSummary = `${signal.direction} ${signal.token} @ ${price} x ${size}`;

      logInfo(`Trade sent (FOK): ${this.lastTradeSummary} | orderId=${orderId}`);
      if (signal.direction === 'BUY') {
        this.knownShares[signal.token] = Number((this.knownShares[signal.token] + size).toFixed(6));
      } else {
        this.knownShares[signal.token] = Math.max(0, Number((this.knownShares[signal.token] - size).toFixed(6)));
      }
    } catch (error) {
      this.failedCount += 1;
      this.lastTradeAtMs = Date.now();
      const message = error instanceof Error ? error.message : String(error);
      this.lastTradeSummary = `FAILED ${signal.direction} ${signal.token} @ ${price} x ${size}`;
      throw new Error(`Trade failed (FOK): ${message}`);
    }
  }

  getStats(): {
    marketSlug: string | null;
    sentCount: number;
    failedCount: number;
    lastTradeAtMs: number | null;
    lastOrderId: string | null;
    lastTradeSummary: string;
  } {
    return {
      marketSlug: this.market?.marketSlug || null,
      sentCount: this.sentCount,
      failedCount: this.failedCount,
      lastTradeAtMs: this.lastTradeAtMs,
      lastOrderId: this.lastOrderId,
      lastTradeSummary: this.lastTradeSummary,
    };
  }
}
