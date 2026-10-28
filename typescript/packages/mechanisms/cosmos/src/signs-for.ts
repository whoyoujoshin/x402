import { ACCOUNT_KEY_TTL_MS } from "./constants";
import type { CosmosAccountPubKey, CosmosPubKeyVerifier } from "./types";
import { bytesEqual } from "./utils";

/** Past this many cached accounts, the cache starts over. */
const MAX_CACHED_ACCOUNT_KEYS = 10_000;

/**
 * Whether `key` signs for the account at `address`.
 *
 * The key that signs for an account is the one stored on it. Only an account
 * with no stored key yet is signed for by the key its address hashes from.
 * After a rotation the stored key is the new one: the retired key still
 * hashes to the address and must not be accepted.
 *
 * @param address - Account address bytes
 * @param typeUrl - Type URL of the key presented by the signer
 * @param key - Raw key bytes presented by the signer
 * @param stored - Key stored on the account, if it has one
 * @param verifier - Address and signature rules for `typeUrl`
 * @returns True when this key signs for the account
 */
export function signsFor(
  address: Uint8Array,
  typeUrl: string,
  key: Uint8Array,
  stored: CosmosAccountPubKey | undefined,
  verifier: CosmosPubKeyVerifier,
): boolean {
  if (stored && stored.key.length > 0) {
    return stored.typeUrl === typeUrl && bytesEqual(stored.key, key);
  }
  try {
    return bytesEqual(verifier.address(key), address);
  } catch {
    return false;
  }
}

type CachedKey = { at: number; key: CosmosAccountPubKey | undefined };

/**
 * Remembers each account's stored key for {@link ACCOUNT_KEY_TTL_MS}.
 * A failed lookup is not remembered.
 */
export class AccountKeyCache {
  private entries = new Map<string, CachedKey>();

  /**
   * Creates a cache.
   *
   * @param ttlMs - How long an answer is reused
   */
  constructor(private readonly ttlMs = ACCOUNT_KEY_TTL_MS) {}

  /**
   * The stored key for an account: the cached answer, or the result of `load`.
   *
   * @param address - Bech32 account address
   * @param load - Reads the key from the chain. Throw to fail the lookup
   * @returns The stored key, or undefined when the account has none
   */
  async get(
    address: string,
    load: () => Promise<CosmosAccountPubKey | undefined>,
  ): Promise<CosmosAccountPubKey | undefined> {
    const now = Date.now();
    const hit = this.entries.get(address);
    if (hit && now - hit.at < this.ttlMs) {
      return hit.key;
    }
    const loaded = await load();
    const key =
      loaded && loaded.key.length > 0
        ? { typeUrl: loaded.typeUrl, key: Uint8Array.from(loaded.key) }
        : undefined;
    if (!this.entries.has(address) && this.entries.size >= MAX_CACHED_ACCOUNT_KEYS) {
      this.entries = new Map();
    }
    this.entries.set(address, { at: now, key });
    return key;
  }
}
