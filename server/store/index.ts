import { Store } from "./types";
import { MemoryStore } from "./memory";
import { RedisStore } from "./redis";

export * from "./types";
export { MemoryStore } from "./memory";
export { RedisStore } from "./redis";

/**
 * One env var decides. No REDIS_URL means local dev with in-process state;
 * set it and the same server is multi-instance safe and survives a restart.
 *
 * The leaderboard is the reason this matters more than it looks. Tokens,
 * rounds and duels are all short-lived — losing them costs someone a round.
 * Standings are the only record a season has.
 */
export function createStore(redisUrl?: string): Store {
  return redisUrl ? new RedisStore(redisUrl) : new MemoryStore();
}

export function describeStore(redisUrl?: string): string {
  if (!redisUrl) return "in-memory (single process, lost on restart)";
  try {
    const u = new URL(redisUrl);
    return `redis ${u.hostname}:${u.port || 6379}`; // never log credentials
  } catch {
    return "redis";
  }
}
