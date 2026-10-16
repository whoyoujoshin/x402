import { base64 } from "@scure/base";
import type {
  PaymentPayloadResult,
  PaymentRequirements,
  SchemeNetworkClient,
} from "@x402/core/types";
import { MsgSend } from "cosmjs-types/cosmos/bank/v1beta1/tx";
import { SignMode } from "cosmjs-types/cosmos/tx/signing/v1beta1/signing";
import { AuthInfo, TxBody, TxRaw } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { DEFAULT_GAS_ADJUSTMENT, MSG_SEND_TYPE_URL } from "../../constants";
import type { ClientCosmosSigner, CosmosClientOptions, ExactCosmosPayload } from "../../types";
import {
  addressBytes,
  chainIdOf,
  feeForGas,
  isCosmosNetwork,
  isDenom,
  isPositiveIntegerString,
} from "../../utils";

/**
 * Cosmos SDK client implementation for the exact payment scheme: it pays by
 * signing one bank send of exactly the required amount to payTo, and pays
 * the transaction's fee itself. Each payment uses the account's next
 * sequence, so payments from one account go one at a time.
 */
export class ExactCosmosScheme implements SchemeNetworkClient {
  readonly scheme = "exact";

  /**
   * Creates a Cosmos exact client scheme.
   *
   * @param signer - Signer for the paying account
   * @param options - Node access and fee settings
   */
  constructor(
    private readonly signer: ClientCosmosSigner,
    private readonly options: CosmosClientOptions,
  ) {}

  /**
   * Creates a payment payload: a signed `TxRaw`.
   *
   * @param x402Version - Protocol version
   * @param requirements - Payment requirements
   * @returns Payment payload
   */
  async createPaymentPayload(
    x402Version: number,
    requirements: PaymentRequirements,
  ): Promise<PaymentPayloadResult> {
    if (x402Version !== 2) {
      throw new Error(`Unsupported x402 version ${x402Version}`);
    }
    if (!isCosmosNetwork(requirements.network)) {
      throw new Error(`Not a Cosmos network: ${requirements.network}`);
    }
    if (!isPositiveIntegerString(requirements.amount) || !isDenom(requirements.asset)) {
      throw new Error("Cosmos exact payments need an integer amount of a bank denom");
    }
    if (!addressBytes(requirements.payTo)) {
      throw new Error(`payTo is not a bech32 address: ${requirements.payTo}`);
    }

    const { chainClient } = this.options;
    const account = await chainClient.getAccount(this.signer.address);
    if (!account) {
      throw new Error(`Account ${this.signer.address} does not exist on chain`);
    }

    const bodyBytes = TxBody.encode(
      TxBody.fromPartial({
        messages: [
          {
            typeUrl: MSG_SEND_TYPE_URL,
            value: MsgSend.encode({
              fromAddress: this.signer.address,
              toAddress: requirements.payTo,
              amount: [{ denom: requirements.asset, amount: requirements.amount }],
            }).finish(),
          },
        ],
      }),
    ).finish();
    const authInfo = (gasLimit: bigint) =>
      AuthInfo.encode(
        AuthInfo.fromPartial({
          signerInfos: [
            {
              publicKey: this.signer.pubKey,
              modeInfo: { single: { mode: SignMode.SIGN_MODE_DIRECT } },
              sequence: account.sequence,
            },
          ],
          fee: {
            amount: this.options.gasPrice ? [feeForGas(gasLimit, this.options.gasPrice)] : [],
            gasLimit,
          },
        }),
      ).finish();

    let gasLimit = this.options.gasLimit;
    if (gasLimit === undefined) {
      // The node doesn't check signatures when it simulates.
      const { gasUsed } = await chainClient.simulate(
        TxRaw.encode({
          bodyBytes,
          authInfoBytes: authInfo(0n),
          signatures: [new Uint8Array()],
        }).finish(),
      );
      const adjustment = this.options.gasAdjustment ?? DEFAULT_GAS_ADJUSTMENT;
      gasLimit = BigInt(Math.ceil(Number(gasUsed) * adjustment));
    }

    const authInfoBytes = authInfo(gasLimit);
    const signature = await this.signer.signDirect({
      bodyBytes,
      authInfoBytes,
      chainId: chainIdOf(requirements.network),
      accountNumber: account.accountNumber,
    });
    const payload: ExactCosmosPayload = {
      transaction: base64.encode(
        TxRaw.encode({ bodyBytes, authInfoBytes, signatures: [signature] }).finish(),
      ),
    };
    return { x402Version, payload };
  }
}
