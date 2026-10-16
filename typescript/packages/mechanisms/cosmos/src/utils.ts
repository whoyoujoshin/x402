import { sha256 } from "@noble/hashes/sha2.js";
import { bech32, hex } from "@scure/base";
import type { Network } from "@x402/core/types";
import type { CosmosNetwork } from "./types";

const DENOM_PATTERN = /^[a-zA-Z][a-zA-Z0-9/:._-]{2,127}$/;

/**
 * Whether a network is in the `cosmos` CAIP-2 namespace.
 *
 * @param network - Network identifier
 * @returns True for `cosmos:<chain-id>`
 */
export function isCosmosNetwork(network: Network): network is CosmosNetwork {
  return /^cosmos:[a-zA-Z0-9_-]{1,32}$/.test(network);
}

/**
 * The chain ID of a `cosmos:<chain-id>` network.
 *
 * @param network - Network identifier
 * @returns Chain ID
 */
export function chainIdOf(network: Network): string {
  if (!isCosmosNetwork(network)) {
    throw new Error(`Not a Cosmos network: ${network}`);
  }
  return network.slice("cosmos:".length);
}

/**
 * Whether a string is a valid bank denom (the SDK's default denom rule).
 *
 * @param denom - Candidate denom
 * @returns True if valid
 */
export function isDenom(denom: string): boolean {
  return DENOM_PATTERN.test(denom);
}

/**
 * Whether a string is a positive integer with no leading zeros.
 *
 * @param value - Candidate amount
 * @returns True if valid
 */
export function isPositiveIntegerString(value: string): boolean {
  return /^[1-9][0-9]*$/.test(value);
}

/**
 * The address bytes of a bech32 address, or undefined if it isn't one.
 *
 * @param address - Bech32 address
 * @returns Address bytes
 */
export function addressBytes(address: string): Uint8Array | undefined {
  try {
    return bech32.decodeToBytes(address as `${string}1${string}`).bytes;
  } catch {
    return undefined;
  }
}

/**
 * A transaction's hash as the chain indexes it: uppercase hex SHA-256 of the `TxRaw` bytes.
 *
 * @param txBytes - Encoded `TxRaw`
 * @returns Transaction hash
 */
export function transactionHash(txBytes: Uint8Array): string {
  return hex.encode(sha256(txBytes)).toUpperCase();
}

/**
 * Whether two byte arrays are equal.
 *
 * @param a - First array
 * @param b - Second array
 * @returns True if equal
 */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * The fee for a gas limit at a gas price like `"0.025uatom"`, rounded up.
 *
 * @param gasLimit - Gas limit
 * @param gasPrice - Decimal amount per unit of gas, followed by the denom
 * @returns Fee coin
 */
export function feeForGas(gasLimit: bigint, gasPrice: string): { denom: string; amount: string } {
  const match = /^(\d+)(?:\.(\d+))?([a-zA-Z][a-zA-Z0-9/:._-]{2,127})$/.exec(gasPrice);
  if (!match) {
    throw new Error(`Invalid gas price "${gasPrice}"; expected e.g. "0.025uatom"`);
  }
  const [, whole, fraction = "", denom] = match;
  const scale = 10n ** BigInt(fraction.length);
  const price = BigInt(whole + fraction);
  return { denom, amount: ((gasLimit * price + scale - 1n) / scale).toString() };
}
