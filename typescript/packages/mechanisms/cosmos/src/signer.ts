import { base64 } from "@scure/base";
import { PubKey } from "cosmjs-types/cosmos/crypto/secp256k1/keys";
import type { SignDoc } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { SECP256K1_PUBKEY_TYPE_URL } from "./constants";
import type { ClientCosmosSigner } from "./types";

/**
 * The parts of a cosmjs `OfflineDirectSigner` (Keplr, Leap, cosmjs wallets) the scheme uses.
 */
export type OfflineDirectSignerLike = {
  getAccounts(): Promise<readonly { address: string; algo: string; pubkey: Uint8Array }[]>;
  signDirect(
    signerAddress: string,
    signDoc: SignDoc,
  ): Promise<{ signature: { signature: string } }>;
};

/**
 * Creates a client signer from a cosmjs-style direct signer.
 *
 * @param signer - Direct signer
 * @param options - Account to use (the first by default), and the key's type
 *   URL for keys other than secp256k1 (e.g. Injective's eth_secp256k1)
 * @param options.address - Account address to sign with
 * @param options.pubKeyTypeUrl - Type URL of the account's key
 * @returns x402 Cosmos client signer
 */
export async function createDirectSigner(
  signer: OfflineDirectSignerLike,
  options: { address?: string; pubKeyTypeUrl?: string } = {},
): Promise<ClientCosmosSigner> {
  const accounts = await signer.getAccounts();
  const account = options.address ? accounts.find(a => a.address === options.address) : accounts[0];
  if (!account) {
    throw new Error(`Signer has no account ${options.address ?? ""}`.trim());
  }
  const typeUrl =
    options.pubKeyTypeUrl ?? (account.algo === "secp256k1" ? SECP256K1_PUBKEY_TYPE_URL : "");
  if (!typeUrl) {
    throw new Error(`Pass pubKeyTypeUrl for a ${account.algo} key`);
  }
  return {
    address: account.address,
    pubKey: { typeUrl, value: PubKey.encode({ key: account.pubkey }).finish() },
    signDirect: async (signDoc: SignDoc) =>
      base64.decode((await signer.signDirect(account.address, signDoc)).signature.signature),
  };
}
