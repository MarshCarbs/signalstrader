import Redis from 'ioredis';
import type { AppConfig } from './config';
import { logError, logInfo, logWarn } from './logger';
import { parseRedisMessage } from './signalParser';
import { TradeExecutor } from './tradeExecutor';
import type { RedisRuntimeConfig } from './types';

export class SignalSubscriber {
  private redis: Redis | null = null;
  private queue: Promise<void> = Promise.resolve();
  private currentHost: string;
  private currentPort: number;
  private currentChannel: string;
  private currentPassword: string | undefined;
  private connected = false;
  private receivedCount = 0;
  private staleCount = 0;
  private processedCount = 0;
  private failedCount = 0;
  private lastSignalAtMs: number | null = null;
  private lastSignalSummary = 'none';

  constructor(private readonly config: AppConfig, private readonly executor: TradeExecutor, private readonly onMarketSlug: (marketSlug: string, source: 'signal' | 'market') => Promise<void>) {
    this.currentHost = config.redisHost;
    this.currentPort = config.redisPort;
    this.currentChannel = config.redisChannel;
    this.currentPassword = config.redisPassword;
  }

  async start(): Promise<void> {
    await this.connectAndSubscribe(this.currentHost, this.currentPort, this.currentChannel, this.currentPassword);
  }

  stop(): void {
    if (this.redis) {
      this.redis.disconnect();
      this.redis = null;
    }
    this.connected = false;
  }

  async updateRedisTarget(next: Partial<RedisRuntimeConfig>): Promise<void> {
    const nextHost = (next.host || this.currentHost).trim();
    const nextPort = Number.isFinite(Number(next.port)) ? Number(next.port) : this.currentPort;
    const nextChannel = (next.channel || this.currentChannel).trim();
    const nextPassword =
      typeof next.password === 'string' && next.password.trim().length > 0
        ? next.password
        : this.currentPassword;

    if (!nextHost || !nextChannel || !Number.isFinite(nextPort) || nextPort <= 0) {
      return;
    }

    const hostChanged = nextHost !== this.currentHost;
    const portChanged = nextPort !== this.currentPort;
    const channelChanged = nextChannel !== this.currentChannel;
    const passwordChanged = nextPassword !== this.currentPassword;

    if (!hostChanged && !portChanged && !channelChanged && !passwordChanged) {
      return;
    }

    if (hostChanged || portChanged || passwordChanged) {
      const previousHost = this.currentHost;
      const previousPort = this.currentPort;
      const previousChannel = this.currentChannel;
      const previousPassword = this.currentPassword;
      const previousRedis = this.redis;
      try {
        await this.connectAndSubscribe(nextHost, nextPort, nextChannel, nextPassword);
      } catch (error) {
        if (this.redis && this.redis !== previousRedis) {
          this.redis.disconnect();
        }
        this.redis = previousRedis;
        if (previousRedis) {
          this.currentHost = previousHost;
          this.currentPort = previousPort;
          this.currentChannel = previousChannel;
          this.currentPassword = previousPassword;
          this.connected = previousRedis.status === 'ready' || previousRedis.status === 'connect';
        } else {
          this.connected = false;
        }
        const message = error instanceof Error ? error.message : String(error);
        logWarn(
          `Redis target switch failed (${nextHost}:${nextPort}/${nextChannel}): ${message}. Keeping previous target ${previousHost}:${previousPort}/${previousChannel}.`
        );
        return;
      }

      if (previousRedis && previousRedis !== this.redis) {
        previousRedis.disconnect();
      }
      logInfo(
        `Redis target changed: ${previousHost}:${previousPort}/${previousChannel} -> ${nextHost}:${nextPort}/${nextChannel}${passwordChanged ? ' (auth updated)' : ''}`
      );
      return;
    }

    if (channelChanged && this.redis) {
      const previous = this.currentChannel;
      await this.redis.unsubscribe(previous);
      await this.redis.subscribe(nextChannel);
      this.currentChannel = nextChannel;
      logInfo(`Redis channel changed from '${previous}' to '${nextChannel}'.`);
      return;
    }

    this.currentHost = nextHost;
    this.currentPort = nextPort;
    this.currentChannel = nextChannel;
    this.currentPassword = nextPassword;
  }

  private async connectAndSubscribe(host: string, port: number, channel: string, password?: string): Promise<void> {
    const redis = new Redis({
      host,
      port,
      ...(password ? { password } : {}),
      maxRetriesPerRequest: null,
      retryStrategy: (times: number) => Math.min(times * 1000, 10000),
    });
    this.redis = redis;

    redis.on('connect', () => {
      if (this.redis !== redis) {
        return;
      }
      this.connected = true;
      logInfo(`Redis connected: ${host}:${port}`);
    });

    redis.on('close', () => {
      if (this.redis !== redis) {
        return;
      }
      this.connected = false;
      logWarn('Redis disconnected.');
    });

    redis.on('error', (error: Error) => {
      if (this.redis !== redis) {
        return;
      }
      logWarn(`Redis error: ${error.message}`);
    });

    redis.on('message', (_channel: string, message: string) => {
      if (this.redis !== redis) {
        return;
      }
      this.queue = this.queue
        .then(() => this.handleMessage(message))
        .catch((error: Error) => {
          logError(`Signal processing error: ${error.message}`);
        });
    });

    await redis.subscribe(channel);
    this.currentHost = host;
    this.currentPort = port;
    this.currentChannel = channel;
    this.currentPassword = password;
    logInfo(`Subscribed to Redis channel: ${channel}`);
  }

  private async handleMessage(rawMessage: string): Promise<void> {
    this.receivedCount += 1;
    try {
      const parsed = parseRedisMessage(rawMessage);

      if (parsed.kind === 'market') {
        this.lastSignalAtMs = Date.now();
        this.lastSignalSummary = `MARKET ${parsed.update.marketSlug}`;
        await this.onMarketSlug(parsed.update.marketSlug, 'market');
        this.processedCount += 1;
        return;
      }

      const signal = parsed.signal;
      this.lastSignalAtMs = Date.now();
      this.lastSignalSummary = `${signal.direction} ${signal.token} @ ${signal.limitPrice} [${signal.marketSlug}]`;

      const ageMs = Date.now() - signal.timestampMs;
      if (ageMs > this.config.signalMaxAgeMs) {
        this.staleCount += 1;
        logWarn(`Ignoring stale signal (${ageMs}ms old).`);
        await this.onMarketSlug(signal.marketSlug, 'signal');
        return;
      }

      await this.onMarketSlug(signal.marketSlug, 'signal');

      await this.executor.execute(signal);
      this.processedCount += 1;
    } catch (error) {
      this.failedCount += 1;
      throw error;
    }
  }

  getStats(): {
    connected: boolean;
    host: string;
    port: number;
    channel: string;
    receivedCount: number;
    staleCount: number;
    processedCount: number;
    failedCount: number;
    lastSignalAtMs: number | null;
    lastSignalSummary: string;
  } {
    return {
      connected: this.connected,
      host: this.currentHost,
      port: this.currentPort,
      channel: this.currentChannel,
      receivedCount: this.receivedCount,
      staleCount: this.staleCount,
      processedCount: this.processedCount,
      failedCount: this.failedCount,
      lastSignalAtMs: this.lastSignalAtMs,
      lastSignalSummary: this.lastSignalSummary,
    };
  }
}
