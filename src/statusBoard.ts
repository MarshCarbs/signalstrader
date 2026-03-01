import type { AppConfig } from './config';
import { logInfo } from './logger';
import type { MarketWsConnection } from './marketWs';
import type { ClaimService } from './claimService';
import type { SignalSubscriber } from './signalSubscriber';
import type { TradeExecutor } from './tradeExecutor';

function ageText(timestampMs: number | null): string {
  if (!timestampMs) {
    return 'never';
  }
  const seconds = Math.floor((Date.now() - timestampMs) / 1000);
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

export class StatusBoard {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly services: {
      ws: MarketWsConnection;
      redis: SignalSubscriber;
      trade: TradeExecutor;
      claim: ClaimService;
    }
  ) {}

  start(): void {
    this.printSummary('BOOT');
    this.timer = setInterval(() => {
      this.printSummary('STATUS');
    }, this.config.statusIntervalSeconds * 1000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private printSummary(kind: 'BOOT' | 'STATUS'): void {
    const ws = this.services.ws.getStats();
    const redis = this.services.redis.getStats();
    const trade = this.services.trade.getStats();
    const claim = this.services.claim.getStats();

    logInfo(
      [
        `${kind} | WS=${ws.connected ? 'UP' : 'DOWN'} (market=${ws.marketSlug || 'n/a'}, ${ageText(ws.lastTickAtMs)} ${ws.lastTickSummary})`,
        `REDIS=${redis.connected ? 'UP' : 'DOWN'} (${redis.host}:${redis.port}, channel=${redis.channel}, recv=${redis.receivedCount}, ok=${redis.processedCount}, stale=${redis.staleCount}, fail=${redis.failedCount}, last=${ageText(redis.lastSignalAtMs)} ${redis.lastSignalSummary})`,
        `TRADES=(market=${trade.marketSlug || 'n/a'}, ok=${trade.sentCount}, fail=${trade.failedCount}, last=${ageText(trade.lastTradeAtMs)} ${trade.lastTradeSummary}, order=${trade.lastOrderId || 'n/a'})`,
        `CLAIM=(enabled=${this.config.claim.enabled}, running=${claim.running}, runs=${claim.runCount}, groups=${claim.claimedGroupCount}, fail=${claim.failedRunCount}, last=${ageText(claim.lastRunAtMs)}${claim.lastError ? `, err=${claim.lastError}` : ''})`,
      ].join(' | ')
    );
  }
}
