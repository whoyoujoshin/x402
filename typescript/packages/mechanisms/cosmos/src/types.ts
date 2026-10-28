import type { SignDoc } from "cosmjs-types/cosmos/tx/v1beta1/tx";

/**
 * Cosmos CAIP-2 network identifier: `cosmos:<chain-id>`.
 */
export type CosmosNetwork = `cosmos:${string}`;

/**
 * Cosmos exact scheme payload.
 */
export type ExactCosmosPayload = {
  /**
   * The signed transaction, a protobuf `cosmos.tx.v1beta1.TxRaw`, base64 encoded.
   */
  transaction: string;
};

/**
 * Public key stored on an account (`AccountInfo.pub_key`).
 */
export type CosmosAccountPubKey = {
  /**
   * Protobuf type URL, for example `/aether.crypto.v1.PubKey`.
   */
  typeUrl: string;
  /**
   * Raw key bytes (the key message's field 1).
   */
  key: Uint8Array;
};

/**
 * An account's number, next sequence, and stored public key.
 */
export type CosmosAccount = {
  accountNumber: bigint;
  sequence: bigint;
  /**
   * Key stored on the account. Absent when the account has not signed yet:
   * the facilitator then accepts the key the address hashes from. Set this
   * from `AccountInfo.pub_key`; a chain that rotates keys keeps the address
   * and replaces this key.
   */
  pubKey?: CosmosAccountPubKey;
};

/**
 * Result of a transaction in a block.
 */
export type CosmosTxResult = {
  height: bigint;
  code: number;
  log: string;
};

/**
 * Result of a sync broadcast: the node's CheckTx answer.
 */
export type CosmosBroadcastResult = {
  hash: string;
  code: number;
  log: string;
};

/**
 * What the scheme needs from a node of one chain.
 */
export interface CosmosChainClient {
  /**
   * Account number, next sequence, and stored public key, or undefined if
   * the account doesn't exist. `pubKey` comes from the same
   * `cosmos.auth.v1beta1.Query/AccountInfo` answer.
   */
  getAccount(address: string): Promise<CosmosAccount | undefined>;
  /**
   * Height of the latest block.
   */
  getLatestHeight(): Promise<bigint>;
  /**
   * Runs the transaction against the node's check state. Throws with the node's
   * log if it fails.
   */
  simulate(txBytes: Uint8Array): Promise<{ gasUsed: bigint }>;
  /**
   * Submits the transaction and returns the CheckTx result.
   */
  broadcastTxSync(txBytes: Uint8Array): Promise<CosmosBroadcastResult>;
  /**
   * The transaction's result, or undefined until it is in a block.
   */
  getTx(hash: string): Promise<CosmosTxResult | undefined>;
}

/**
 * Verifies signatures of one account key type.
 */
export type CosmosPubKeyVerifier = {
  /**
   * The account address bytes of a key.
   */
  address(key: Uint8Array): Uint8Array;
  /**
   * Whether signature is the key's signature over signBytes (the encoded SignDoc).
   */
  verify(key: Uint8Array, signBytes: Uint8Array, signature: Uint8Array): boolean;
};

/**
 * Client signer abstraction for Cosmos transactions in `SIGN_MODE_DIRECT`.
 */
export type ClientCosmosSigner = {
  /**
   * Bech32 address of the account that pays.
   */
  address: string;
  /**
   * The account's public key as it goes in `SignerInfo.public_key`.
   */
  pubKey: { typeUrl: string; value: Uint8Array };
  /**
   * Signs the SignDoc and returns the signature bytes.
   */
  signDirect(signDoc: SignDoc): Promise<Uint8Array> | Uint8Array;
};

/**
 * Options for the Cosmos exact client.
 */
export type CosmosClientOptions = {
  /**
   * Node access for the account lookup and gas simulation.
   */
  chainClient: CosmosChainClient;
  /**
   * Fixed gas limit. Without it, the client simulates and multiplies by gasAdjustment.
   */
  gasLimit?: bigint;
  /**
   * Multiplier for simulated gas. Defaults to {@link DEFAULT_GAS_ADJUSTMENT}.
   */
  gasAdjustment?: number;
  /**
   * Gas price for the fee, e.g. `"0.025uatom"`. Without it the fee is empty,
   * which only chains with a zero minimum gas price accept.
   */
  gasPrice?: string;
};

/**
 * Options for Cosmos facilitator verification and settlement.
 */
export type CosmosFacilitatorOptions = {
  /**
   * Node access for the chain this facilitator serves.
   */
  chainClient: CosmosChainClient;
  /**
   * Account key types accepted, by type URL. Defaults to secp256k1,
   * Injective's eth_secp256k1 and Aether's ML-DSA-44.
   */
  pubKeyVerifiers?: Record<string, CosmosPubKeyVerifier>;
  /**
   * Fee denom advertised in the supported kind's extra.
   */
  feeDenom?: string;
  /**
   * How often settlement polls for inclusion, in milliseconds.
   */
  pollIntervalMs?: number;
  /**
   * Minimum time settlement waits for inclusion, in milliseconds.
   */
  settleTimeoutMs?: number;
};
