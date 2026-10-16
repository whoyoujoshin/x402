/**
 * Cosmos CAIP family pattern used in facilitator supported responses.
 */
export const COSMOS_CAIP_FAMILY = "cosmos:*";

/**
 * Largest `TxRaw` a payload may carry. A one-message send with an ML-DSA-44
 * key (1,312-byte key, 2,420-byte signature) is about 4 KiB.
 */
export const MAX_TRANSACTION_BYTES = 16 * 1024;

/**
 * Type URL of `cosmos.bank.v1beta1.MsgSend`.
 */
export const MSG_SEND_TYPE_URL = "/cosmos.bank.v1beta1.MsgSend";

/**
 * Type URL of the SDK's secp256k1 account key.
 */
export const SECP256K1_PUBKEY_TYPE_URL = "/cosmos.crypto.secp256k1.PubKey";

/**
 * Type URL of Injective's eth_secp256k1 account key.
 */
export const INJECTIVE_ETH_SECP256K1_PUBKEY_TYPE_URL =
  "/injective.crypto.v1beta1.ethsecp256k1.PubKey";

/**
 * Type URL of Aether's ML-DSA-44 account key.
 */
export const AETHER_MLDSA44_PUBKEY_TYPE_URL = "/aether.crypto.v1.PubKey";

/**
 * Gas limit multiplier applied to a client-side simulation.
 */
export const DEFAULT_GAS_ADJUSTMENT = 1.4;

/**
 * How often settlement polls for the transaction, in milliseconds.
 */
export const DEFAULT_POLL_INTERVAL_MS = 2_000;

/**
 * Settlement waits at least this long for inclusion, in milliseconds, or
 * `maxTimeoutSeconds` when that is longer.
 */
export const DEFAULT_SETTLE_TIMEOUT_MS = 90_000;

/**
 * Extra time a settled transaction hash stays in the duplicate cache.
 */
export const SETTLEMENT_TTL_MS = 120_000;
