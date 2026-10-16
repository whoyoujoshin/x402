import { SETTLEMENT_TTL_MS } from "./constants";

/**
 * In-memory guard against settling one signed transaction twice at once.
 *
 * Once a transaction is in a block, the chain's sequence check refuses the
 * same bytes again, and so does re-verification. Before that, two concurrent
 * `/settle` calls with the same bytes would both broadcast, and the second
 * would see the first's transaction land and report success. The check and
 * insert happen before the first `await` in settle, so no lock is needed.
 *
 * This is a per-process guard; a horizontally scaled facilitator must back
 * it with a shared atomic store.
 */
export class SettlementCache {
  private readonly entries = new Map<string, number>();

  /**
   * Returns true if key is already pending, or records it and returns false.
   *
   * @param key - The transaction hash
   * @param ttlMs - How long to keep the entry
   * @returns Whether key was already present
   */
  isDuplicate(key: string, ttlMs: number = SETTLEMENT_TTL_MS): boolean {
    const now = Date.now();
    for (const [k, expiresAt] of this.entries) {
      if (expiresAt <= now) {
        this.entries.delete(k);
      }
    }
    if (this.entries.has(key)) {
      return true;
    }
    this.entries.set(key, now + ttlMs);
    return false;
  }

  /**
   * Forgets a key, for a transaction the node refused at CheckTx.
   *
   * @param key - The transaction hash
   */
  release(key: string): void {
    this.entries.delete(key);
  }
}
