/**
 * 令牌桶限流。
 *
 * 存在的理由很具体：个人微信号的封号画像里，「短时间内高频发消息」是最常见的一条。
 * 与其等服务端 429 再退避，不如在本地就把突发压平。
 */

export type TokenBucketOptions = {
  /** 桶容量，也就是允许的最大瞬时突发。 */
  capacity: number;
  /** 每分钟补充多少令牌。 */
  refillPerMinute: number;
  now?: () => number;
};

export type TokenBucket = {
  /** 取一个令牌；取不到返回 false。 */
  tryTake(atMs: number): boolean;
  /** 当前剩余整数额度（向下取整），用于提前判断要不要降级。 */
  remaining(atMs: number): number;
};

export function createTokenBucket(options: TokenBucketOptions): TokenBucket {
  const capacity = Math.max(1, options.capacity);
  const refillPerMs = Math.max(0, options.refillPerMinute) / 60_000;
  const now = options.now ?? Date.now;

  let tokens = capacity;
  let lastRefillAt = now();

  function refill(atMs: number): void {
    const elapsed = atMs - lastRefillAt;
    if (elapsed <= 0) return;
    tokens = Math.min(capacity, tokens + elapsed * refillPerMs);
    lastRefillAt = atMs;
  }

  return {
    tryTake(atMs: number): boolean {
      refill(atMs);
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
    remaining(atMs: number): number {
      refill(atMs);
      return Math.floor(tokens);
    },
  };
}
