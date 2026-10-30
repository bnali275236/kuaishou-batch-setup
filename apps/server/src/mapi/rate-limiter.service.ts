import { Injectable, Logger } from '@nestjs/common';
import {
  ADAPTIVE_BLOCK_RATIO,
  ADAPTIVE_SLOWDOWN_RATIO,
  RATE_LIMITS,
} from '@wkbd/shared';
import { TokenBucket, burstFor, sleep } from './token-bucket';

/** 调用类别 —— 决定吃哪个配额桶 */
export type RateCategory = 'query' | 'create' | 'creative' | 'batch';

/** 自适应限流观测窗口 */
const OBSERVE_WINDOW_MS = 60_000;
/** 触发观测所需的最小样本量，避免刚启动时抖动就降速 */
const MIN_SAMPLES = 20;
/** 平台自适应限流命中后的暂停时长（官方口径：约 1 分钟恢复） */
const BLOCK_PAUSE_MS = 60_000;
/** 超时率偏高时的主动降速时长 */
const SOFT_SLOWDOWN_MS = 10_000;

interface Outcome {
  at: number;
  timedOut: boolean;
}

@Injectable()
export class RateLimiterService {
  private readonly logger = new Logger(RateLimiterService.name);

  /** L1 应用级全局桶 */
  private readonly globalBucket = new TokenBucket(burstFor(RATE_LIMITS.GLOBAL), RATE_LIMITS.GLOBAL);

  /** L2 按调用类别的桶 */
  private readonly categoryBuckets: Record<RateCategory, TokenBucket> = {
    query: new TokenBucket(burstFor(RATE_LIMITS.QUERY), RATE_LIMITS.QUERY),
    create: new TokenBucket(burstFor(RATE_LIMITS.CREATE), RATE_LIMITS.CREATE),
    creative: new TokenBucket(burstFor(RATE_LIMITS.CREATIVE), RATE_LIMITS.CREATIVE),
    batch: new TokenBucket(burstFor(RATE_LIMITS.BATCH), RATE_LIMITS.BATCH),
  };

  /** L3 单账户桶 —— 平台对账户维度单独限流 */
  private readonly advertiserBuckets = new Map<string, { bucket: TokenBucket; touchedAt: number }>();

  private outcomes: Outcome[] = [];
  /** 在此时间点之前，所有调用都要等待 */
  private pausedUntil = 0;

  /**
   * 取令牌。三层桶必须同时可消费才放行 —— 不能有先消费再回滚的情况。
   */
  async acquire(category: RateCategory, advertiserId?: string): Promise<void> {
    for (;;) {
      const now = Date.now();

      if (now < this.pausedUntil) {
        await sleep(Math.min(this.pausedUntil - now, 2000));
        continue;
      }

      const buckets = this.bucketsFor(category, advertiserId);
      const ready = buckets.every((b) => b.peek() >= 1);

      if (ready) {
        buckets.forEach((b) => b.consume(1));
        return;
      }

      const wait = Math.max(...buckets.map((b) => b.msUntil(1)));
      // 上限 1s：避免长等待后过期配额被其他请求抢走导致饥饿
      await sleep(Math.min(Math.max(wait, 5), 1000));
    }
  }

  /**
   * 上报一次调用结果，驱动自适应降速。
   * 依据官方说明：超时率达 20% 会触发平台侧限流，这里提前在 15% 就主动降速。
   */
  recordOutcome(timedOut: boolean): void {
    const now = Date.now();
    this.outcomes.push({ at: now, timedOut });
    this.outcomes = this.outcomes.filter((o) => now - o.at <= OBSERVE_WINDOW_MS);

    if (this.outcomes.length < MIN_SAMPLES) return;

    const ratio = this.outcomes.filter((o) => o.timedOut).length / this.outcomes.length;

    if (ratio >= ADAPTIVE_BLOCK_RATIO) {
      this.pausedUntil = Math.max(this.pausedUntil, now + BLOCK_PAUSE_MS);
      this.logger.warn(
        `超时率 ${(ratio * 100).toFixed(1)}% 已达平台限流阈值，暂停对外调用 ${BLOCK_PAUSE_MS / 1000}s`,
      );
    } else if (ratio >= ADAPTIVE_SLOWDOWN_RATIO) {
      this.pausedUntil = Math.max(this.pausedUntil, now + SOFT_SLOWDOWN_MS);
      this.logger.warn(`超时率 ${(ratio * 100).toFixed(1)}% 偏高，主动降速 ${SOFT_SLOWDOWN_MS / 1000}s`);
    }
  }

  private bucketsFor(category: RateCategory, advertiserId?: string): TokenBucket[] {
    const list = [this.globalBucket, this.categoryBuckets[category]];
    if (advertiserId) list.push(this.advertiserBucket(advertiserId).bucket);
    return list;
  }

  private advertiserBucket(advertiserId: string): { bucket: TokenBucket; touchedAt: number } {
    const now = Date.now();
    let entry = this.advertiserBuckets.get(advertiserId);
    if (!entry) {
      entry = {
        bucket: new TokenBucket(
          burstFor(RATE_LIMITS.PER_ADVERTISER),
          RATE_LIMITS.PER_ADVERTISER,
        ),
        touchedAt: now,
      };
      this.advertiserBuckets.set(advertiserId, entry);
    }
    entry.touchedAt = now;
    // 防止账户池长期运行后 Map 无限增长
    if (this.advertiserBuckets.size > 2000) this.pruneAdvertiserBuckets();
    return entry;
  }

  private pruneAdvertiserBuckets(): void {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, entry] of this.advertiserBuckets) {
      if (entry.touchedAt < cutoff) this.advertiserBuckets.delete(id);
    }
  }

  /** 供前端/健康检查展示当前配额水位 */
  snapshot() {
    const total = this.outcomes.length;
    const timedOut = this.outcomes.filter((o) => o.timedOut).length;
    return {
      pausedUntil: this.pausedUntil > Date.now() ? new Date(this.pausedUntil).toISOString() : null,
      timeoutRatio: total === 0 ? 0 : Number((timedOut / total).toFixed(4)),
      sampleSize: total,
      global: this.globalBucket.snapshot(),
      categories: {
        query: this.categoryBuckets.query.snapshot(),
        create: this.categoryBuckets.create.snapshot(),
        creative: this.categoryBuckets.creative.snapshot(),
        batch: this.categoryBuckets.batch.snapshot(),
      },
      trackedAdvertisers: this.advertiserBuckets.size,
    };
  }
}
