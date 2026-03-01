import { ClaimScheduler, ClaimService } from './src/claimService';
import { loadConfig } from './src/config';
import { logError, logInfo, logWarn } from './src/logger';
import { resolveMarketBySlug } from './src/marketResolver';
import { MarketWsConnection } from './src/marketWs';
import { createPolymarketClient } from './src/polymarketClient';
import { SignalSubscriber } from './src/signalSubscriber';
import { StatusBoard } from './src/statusBoard';
import { TradeExecutor } from './src/tradeExecutor';

let shuttingDown = false;
const MARKET_RESOLVE_RETRY_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveMarketWithRetry(config: ReturnType<typeof loadConfig>, marketSlug: string) {
  for (;;) {
    try {
      return await resolveMarketBySlug(marketSlug, config);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logWarn(`Market resolve failed (${marketSlug}): ${message}. Retrying in 5 seconds...`);
      await sleep(MARKET_RESOLVE_RETRY_MS);
    }
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  logInfo('Starting signal trader...');
  logInfo(`Order mode: FOK only`);
  logInfo(`Shares per trade: ${config.sharesPerTrade}`);
  logInfo(`Redis target: ${config.redisHost}:${config.redisPort}/${config.redisChannel}${config.redisPassword ? ' (auth enabled)' : ''}`);

  const clobClient = await createPolymarketClient(config);
  logInfo('Polymarket client initialized.');

  const wsConnection = new MarketWsConnection(config);
  wsConnection.start();
  logInfo('WS service started.');

  const tradeExecutor = new TradeExecutor(clobClient, config);

  let activeMarketSlug: string | null = null;
  const setActiveMarket = async (nextSlugRaw: string, source: 'signal' | 'market' | 'env'): Promise<void> => {
    const nextSlug = String(nextSlugRaw || '').trim().toLowerCase();
    if (!nextSlug) {
      return;
    }
    if (activeMarketSlug === nextSlug) {
      return;
    }

    const market = await resolveMarketWithRetry(config, nextSlug);
    activeMarketSlug = market.marketSlug;
    tradeExecutor.updateMarket(market);
    wsConnection.updateMarket(market);

    logInfo(`Active market (${source}): ${market.marketQuestion}`);
    logInfo(`Event slug: ${market.eventSlug}`);
    logInfo(`Market slug: ${market.marketSlug}`);
  };

  const bootMarketSlug = (process.env.MARKET_SLUG || '').trim();
  if (bootMarketSlug) {
    await setActiveMarket(bootMarketSlug, 'env');
  } else {
    logInfo('No MARKET_SLUG in env. Waiting for Redis market updates/signals.');
  }

  const signalSubscriber = new SignalSubscriber(config, tradeExecutor, async (nextSlug, source) => {
    await setActiveMarket(nextSlug, source);
  });
  await signalSubscriber.start();

  const claimService = new ClaimService(config);
  const claimScheduler = new ClaimScheduler(config, claimService);
  claimScheduler.start();

  const statusBoard = new StatusBoard(config, {
    ws: wsConnection,
    redis: signalSubscriber,
    trade: tradeExecutor,
    claim: claimService,
  });
  statusBoard.start();

  const shutdown = () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logInfo('Shutting down...');
    statusBoard.stop();
    claimScheduler.stop();
    signalSubscriber.stop();
    wsConnection.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  logError(`Startup failed: ${message}`);
  process.exit(1);
});
