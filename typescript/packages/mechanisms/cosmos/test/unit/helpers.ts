import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { base64, bech32 } from "@scure/base";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { PubKey } from "cosmjs-types/cosmos/crypto/secp256k1/keys";
import { SignDoc, TxRaw } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import {
  AETHER_MLDSA44_PUBKEY_TYPE_URL,
  SECP256K1_PUBKEY_TYPE_URL,
  aetherMlDsa44Verifier,
} from "../../src";
import type { ClientCosmosSigner, CosmosChainClient } from "../../src";

export const fakeChain = (overrides: Partial<CosmosChainClient> = {}): CosmosChainClient => ({
  getAccount: async () => ({ accountNumber: 7n, sequence: 3n }),
  getLatestHeight: async () => 100n,
  simulate: async () => ({ gasUsed: 80_000n }),
  broadcastTxSync: async () => ({ hash: "", code: 0, log: "" }),
  getTx: async () => ({ height: 101n, code: 0, log: "" }),
  ...overrides,
});

export const requirementsFor = (
  network: string,
  asset: string,
  amount: string,
  payTo: string,
): PaymentRequirements => ({
  scheme: "exact",
  network: network as PaymentRequirements["network"],
  asset,
  amount,
  payTo,
  maxTimeoutSeconds: 60,
  extra: {},
});

export const paymentPayload = (
  requirements: PaymentRequirements,
  transaction: string,
): PaymentPayload => ({ x402Version: 2, accepted: requirements, payload: { transaction } });

/** Re-encodes a payload's TxRaw after changing it (its signature no longer matches). */
export const mutateTx = (transaction: string, change: (raw: TxRaw) => void): string => {
  const raw = TxRaw.decode(base64.decode(transaction));
  change(raw);
  return base64.encode(TxRaw.encode(raw).finish());
};

export const secp256k1Signer = (prefix = "cosmos"): ClientCosmosSigner => {
  const secretKey = new Uint8Array(32).fill(1);
  const key = secp256k1.getPublicKey(secretKey, true);
  return {
    address: bech32.encodeFromBytes(prefix, ripemd160(sha256(key))),
    pubKey: { typeUrl: SECP256K1_PUBKEY_TYPE_URL, value: PubKey.encode({ key }).finish() },
    signDirect: doc => secp256k1.sign(SignDoc.encode(doc).finish(), secretKey),
  };
};

export const mlDsaSigner = (prefix = "aether"): ClientCosmosSigner => {
  const { publicKey, secretKey } = ml_dsa44.keygen(new Uint8Array(32).fill(2));
  return {
    address: bech32.encodeFromBytes(prefix, aetherMlDsa44Verifier.address(publicKey)),
    pubKey: {
      typeUrl: AETHER_MLDSA44_PUBKEY_TYPE_URL,
      value: PubKey.encode({ key: publicKey }).finish(),
    },
    signDirect: doc => ml_dsa44.sign(SignDoc.encode(doc).finish(), secretKey),
  };
};

export const addressOf = (prefix: string, fill: number, length = 20): string =>
  bech32.encodeFromBytes(prefix, new Uint8Array(length).fill(fill));
