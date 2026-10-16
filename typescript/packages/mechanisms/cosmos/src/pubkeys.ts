import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import {
  AETHER_MLDSA44_PUBKEY_TYPE_URL,
  INJECTIVE_ETH_SECP256K1_PUBKEY_TYPE_URL,
  SECP256K1_PUBKEY_TYPE_URL,
} from "./constants";
import type { CosmosPubKeyVerifier } from "./types";

const MLDSA44_PUBKEY_BYTES = 1312;
const MLDSA44_SIGNATURE_BYTES = 2420;

/**
 * The SDK's secp256k1 keys: ECDSA over SHA-256 of the sign bytes, low S,
 * address RIPEMD-160(SHA-256(compressed key)).
 */
export const secp256k1Verifier: CosmosPubKeyVerifier = {
  address: key => ripemd160(sha256(key)),
  verify: (key, signBytes, signature) =>
    key.length === 33 &&
    signature.length === 64 &&
    secp256k1.verify(signature, signBytes, key, { prehash: true, lowS: true }),
};

/**
 * Ethereum-style secp256k1 keys (Injective): ECDSA over Keccak-256 of the
 * sign bytes, low S, an optional trailing recovery byte, address the last
 * 20 bytes of Keccak-256 of the uncompressed key.
 */
export const ethSecp256k1Verifier: CosmosPubKeyVerifier = {
  address: key =>
    keccak_256(secp256k1.Point.fromBytes(key).toBytes(false).subarray(1)).subarray(12),
  verify: (key, signBytes, signature) => {
    const rs = signature.length === 65 ? signature.subarray(0, 64) : signature;
    return (
      key.length === 33 &&
      rs.length === 64 &&
      secp256k1.verify(rs, keccak_256(signBytes), key, { prehash: false, lowS: true })
    );
  },
};

/**
 * Aether's ML-DSA-44 (FIPS 204) keys, with the ADR-028 address
 * SHA-256(SHA-256("aether.crypto.v1.PubKey") || key).
 */
export const aetherMlDsa44Verifier: CosmosPubKeyVerifier = {
  address: key => {
    const typeHash = sha256(new TextEncoder().encode(AETHER_MLDSA44_PUBKEY_TYPE_URL.slice(1)));
    const preimage = new Uint8Array(typeHash.length + key.length);
    preimage.set(typeHash);
    preimage.set(key, typeHash.length);
    return sha256(preimage);
  },
  verify: (key, signBytes, signature) =>
    key.length === MLDSA44_PUBKEY_BYTES &&
    signature.length === MLDSA44_SIGNATURE_BYTES &&
    ml_dsa44.verify(signature, signBytes, key),
};

/**
 * Account key types a facilitator accepts by default, by type URL. Each is a
 * protobuf message with the key bytes in field 1.
 */
export const DEFAULT_PUBKEY_VERIFIERS: Record<string, CosmosPubKeyVerifier> = {
  [SECP256K1_PUBKEY_TYPE_URL]: secp256k1Verifier,
  [INJECTIVE_ETH_SECP256K1_PUBKEY_TYPE_URL]: ethSecp256k1Verifier,
  [AETHER_MLDSA44_PUBKEY_TYPE_URL]: aetherMlDsa44Verifier,
};
