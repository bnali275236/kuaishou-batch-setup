/**
 * 令牌桶。用于把对外调用速率压在快手开放平台的 QPM 配额之内。
 *
 * 关于 capacity（突发容量）：不能设成等于 QPM —— 那等于允许一秒钟打满
 * 整分钟配额，必然触发平台自适应限流。这里按「10 秒突发」折算，
 * 兼顾吞吐与安全。
 */
export class TokenBucket {
  private tokens: number;
  private lastRefillAt: number;

  constructor(
    /** 桶容量（突发上限） */
    private readonly capacity: number,
    /** 每分钟补充的令牌数（QPM） */
    private readonly qpm: number,
  ) {
    this.tokens = capacity;
    this.lastRefillAt = Date.now();
  }

  private refill(now: number): void {
    const elapsed = now - this.lastRefillAt;
    if (elapsed <= 0) return;
    const perMs = this.qpm / 60_000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * perMs);
    this.lastRefillAt = now;
  }

  /** 当前可用令牌数（不消费） */
  peek(): number {
    this.refill(Date.now());
    return this.tokens;
  }

  /** 尝试消费，成功返回 true */
  consume(n = 1): boolean {
    this.refill(Date.now());
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }

  /** 距离攒够 n 个令牌还需多少毫秒 */
  msUntil(n = 1): number {
    this.refill(Date.now());
    if (this.tokens >= n) return 0;
    const perMs = this.qpm / 60_000;
    if (perMs <= 0) return Number.MAX_SAFE_INTEGER;
    return Math.ceil((n - this.tokens) / perMs);
  }

  snapshot(): { tokens: number; capacity: number; qpm: number } {
    return { tokens: Math.floor(this.peek()), capacity: this.capacity, qpm: this.qpm };
  }
}

/** 由 QPM 推导合理的突发容量 */
export function burstFor(qpm: number): number {
  return Math.max(1, Math.floor(qpm / 12));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
