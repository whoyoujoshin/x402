import { base64 } from "@scure/base";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { MsgSend } from "cosmjs-types/cosmos/bank/v1beta1/tx";
import { PubKey } from "cosmjs-types/cosmos/crypto/secp256k1/keys";
import { SignMode } from "cosmjs-types/cosmos/tx/signing/v1beta1/signing";
import { AuthInfo, SignDoc, TxBody, TxRaw } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import {
  COSMOS_CAIP_FAMILY,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_SETTLE_TIMEOUT_MS,
  MAX_TRANSACTION_BYTES,
  MSG_SEND_TYPE_URL,
  SETTLEMENT_TTL_MS,
} from "../../constants";
import { DEFAULT_PUBKEY_VERIFIERS } from "../../pubkeys";
import { SettlementCache } from "../../settlement-cache";
import type { CosmosFacilitatorOptions, CosmosPubKeyVerifier } from "../../types";
import {
  addressBytes,
  bytesEqual,
  chainIdOf,
  isCosmosNetwork,
  isDenom,
  isPositiveIntegerString,
  transactionHash,
} from "../../utils";

type Checked = { payer: string; txBytes: Uint8Array; hash: string };
type Refused = { payer: string; reason: string; message?: string };

/**
 * Cosmos SDK facilitator implementation for the exact payment scheme. It
 * holds no key: the payer signs the whole transaction and pays its fee, and
 * the facilitator checks it and broadcasts it.
 */
export class ExactCosmosScheme implements SchemeNetworkFacilitator {
  readonly scheme = "exact";
  readonly caipFamily = COSMOS_CAIP_FAMILY;
  private readonly verifiers: Record<string, CosmosPubKeyVerifier>;
  private readonly settlementCache: SettlementCache;

  /**
   * Creates a Cosmos exact facilitator scheme for one chain.
   *
   * @param options - Facilitator configuration
   * @param settlementCache - Optional shared settlement cache
   */
  constructor(
    private readonly options: CosmosFacilitatorOptions,
    settlementCache?: SettlementCache,
  ) {
    this.verifiers = options.pubKeyVerifiers ?? DEFAULT_PUBKEY_VERIFIERS;
    this.settlementCache = settlementCache ?? new SettlementCache();
  }

  /**
   * Gets mechanism-specific supported metadata: the payer pays the fee.
   *
   * @param _network - Network identifier
   * @returns Fee metadata
   */
  getExtra(_network: Network): Record<string, unknown> | undefined {
    return this.options.feeDenom
      ? { feePayer: "payer", feeDenom: this.options.feeDenom }
      : { feePayer: "payer" };
  }

  /**
   * Gets facilitator signer addresses.
   *
   * @param _network - Network identifier
   * @returns An empty list: the facilitator signs nothing
   */
  getSigners(_network: string): string[] {
    return [];
  }

  /**
   * Verifies a payment without broadcasting it.
   *
   * @param payload - x402 payment payload
   * @param requirements - Payment requirements
   * @returns Verification response
   */
  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const result = await this.check(payload, requirements);
    if ("reason" in result) {
      return {
        isValid: false,
        invalidReason: result.reason,
        invalidMessage: result.message,
        payer: result.payer,
      };
    }
    return { isValid: true, payer: result.payer };
  }

  /**
   * Verifies a payment again, broadcasts it and waits for it to be in a block.
   *
   * @param payload - x402 payment payload
   * @param requirements - Payment requirements
   * @returns Settlement response
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const network = requirements.network;
    const fail = (payer: string, errorReason: string, transaction = "", errorMessage?: string) =>
      ({
        success: false,
        errorReason,
        errorMessage,
        payer,
        transaction,
        network,
      }) as SettleResponse;

    const checked = await this.check(payload, requirements);
    if ("reason" in checked) {
      return fail(checked.payer, checked.reason, "", checked.message);
    }
    const { payer, txBytes, hash } = checked;
    const timeoutMs = Math.max(
      this.options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS,
      requirements.maxTimeoutSeconds * 1000,
    );
    if (this.settlementCache.isDuplicate(hash, timeoutMs + SETTLEMENT_TTL_MS)) {
      return fail(payer, "duplicate_settlement", hash);
    }

    const chain = this.options.chainClient;
    let broadcast;
    try {
      broadcast = await chain.broadcastTxSync(txBytes);
    } catch (error) {
      // Unknown whether it reached the mempool: keep it marked.
      return fail(payer, "unexpected_settle_error", hash, errorText(error));
    }
    if (broadcast.code !== 0) {
      this.settlementCache.release(hash);
      return fail(payer, rejectReason(broadcast.log), hash, broadcast.log);
    }

    const deadline = Date.now() + timeoutMs;
    const pollMs = this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    for (;;) {
      const result = await chain.getTx(hash).catch(() => undefined);
      if (result) {
        if (result.code !== 0) {
          return fail(payer, rejectReason(result.log), hash, result.log);
        }
        return { success: true, payer, transaction: hash, network, amount: requirements.amount };
      }
      if (Date.now() >= deadline) {
        return fail(payer, "invalid_transaction_state", hash);
      }
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
  }

  /**
   * Runs every check on a payment (the spec's verification steps 1 to 11).
   *
   * @param payload - x402 payment payload
   * @param requirements - Payment requirements
   * @returns The checked transaction, or why it was refused
   */
  private async check(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<Checked | Refused> {
    let payer = "";
    const refuse = (reason: string, message?: string): Refused => ({ payer, reason, message });
    try {
      if (payload.x402Version !== 2) return refuse("invalid_x402_version");
      if (requirements.scheme !== "exact" || payload.accepted.scheme !== "exact") {
        return refuse("unsupported_scheme");
      }
      if (
        !isCosmosNetwork(requirements.network) ||
        payload.accepted.network !== requirements.network
      ) {
        return refuse("invalid_network");
      }
      if (
        !isPositiveIntegerString(requirements.amount) ||
        !isDenom(requirements.asset) ||
        !addressBytes(requirements.payTo)
      ) {
        return refuse("invalid_payment_requirements");
      }
      if (
        payload.accepted.amount !== requirements.amount ||
        payload.accepted.asset !== requirements.asset ||
        payload.accepted.payTo !== requirements.payTo
      ) {
        return refuse("invalid_exact_cosmos_payload_accepted_mismatch");
      }

      const encoded = (payload.payload as { transaction?: unknown }).transaction;
      if (typeof encoded !== "string" || encoded === "") return refuse("invalid_payload");
      let txBytes: Uint8Array;
      try {
        txBytes = base64.decode(encoded);
      } catch {
        return refuse("invalid_payload");
      }
      if (txBytes.length === 0 || txBytes.length > MAX_TRANSACTION_BYTES) {
        return refuse("invalid_payload");
      }

      const decoded = decodeCanonical(txBytes);
      if (!decoded) return refuse("invalid_exact_cosmos_payload_transaction");
      const { raw, body, authInfo } = decoded;
      // An unordered transaction skips the sequence check, so nothing would
      // stop the same bytes from being settled twice.
      if (body.unordered) return refuse("invalid_exact_cosmos_payload_transaction");

      if (
        body.messages.length !== 1 ||
        body.extensionOptions.length !== 0 ||
        body.nonCriticalExtensionOptions.length !== 0 ||
        body.messages[0].typeUrl !== MSG_SEND_TYPE_URL
      ) {
        return refuse("invalid_exact_cosmos_payload_message");
      }
      const send = MsgSend.decode(body.messages[0].value);
      if (!bytesEqual(MsgSend.encode(send).finish(), body.messages[0].value)) {
        return refuse("invalid_exact_cosmos_payload_message");
      }
      payer = send.fromAddress;
      if (send.toAddress !== requirements.payTo) {
        return refuse("invalid_exact_cosmos_payload_recipient_mismatch");
      }
      if (
        send.amount.length !== 1 ||
        send.amount[0].denom !== requirements.asset ||
        send.amount[0].amount !== requirements.amount
      ) {
        return refuse("invalid_exact_cosmos_payload_amount_mismatch");
      }
      const payerBytes = addressBytes(send.fromAddress);
      if (!payerBytes) return refuse("invalid_exact_cosmos_payload_message");

      const signer = authInfo.signerInfos[0];
      if (
        authInfo.signerInfos.length !== 1 ||
        raw.signatures.length !== 1 ||
        !signer.publicKey ||
        signer.modeInfo?.single?.mode !== SignMode.SIGN_MODE_DIRECT
      ) {
        return refuse("invalid_exact_cosmos_payload_signer");
      }
      const verifier = this.verifiers[signer.publicKey.typeUrl];
      if (!verifier) return refuse("invalid_exact_cosmos_payload_signer");
      const key = PubKey.decode(signer.publicKey.value).key;
      let signerAddress: Uint8Array;
      try {
        signerAddress = verifier.address(key);
      } catch {
        return refuse("invalid_exact_cosmos_payload_signer");
      }
      if (!bytesEqual(signerAddress, payerBytes)) {
        return refuse("invalid_exact_cosmos_payload_signer");
      }

      const fee = authInfo.fee;
      if (!fee || fee.granter !== "" || (fee.payer !== "" && fee.payer !== send.fromAddress)) {
        return refuse("invalid_exact_cosmos_payload_fee");
      }

      const chain = this.options.chainClient;
      if (body.timeoutHeight !== 0n && body.timeoutHeight <= (await chain.getLatestHeight())) {
        return refuse("invalid_exact_cosmos_payload_expired");
      }

      const account = await chain.getAccount(send.fromAddress);
      if (!account) return refuse("insufficient_funds");
      if (signer.sequence < account.sequence) {
        return refuse("invalid_exact_cosmos_payload_sequence");
      }
      const signBytes = SignDoc.encode({
        bodyBytes: raw.bodyBytes,
        authInfoBytes: raw.authInfoBytes,
        chainId: chainIdOf(requirements.network),
        accountNumber: account.accountNumber,
      }).finish();
      if (!verifier.verify(key, signBytes, raw.signatures[0])) {
        return refuse("invalid_exact_cosmos_payload_signature");
      }

      // The node skips signature checks and the gas limit when it simulates,
      // so both are checked here.
      let gasUsed: bigint;
      try {
        ({ gasUsed } = await chain.simulate(txBytes));
      } catch (error) {
        return refuse(rejectReason(errorText(error)), errorText(error));
      }
      if (gasUsed > fee.gasLimit) return refuse("invalid_exact_cosmos_payload_gas");

      return { payer, txBytes, hash: transactionHash(txBytes) };
    } catch (error) {
      return refuse("unexpected_verify_error", errorText(error));
    }
  }
}

/**
 * Decodes a TxRaw and its body and auth info, refusing bytes that don't
 * re-encode identically: unknown fields (including ones from newer SDK
 * versions) or a non-canonical encoding.
 *
 * @param txBytes - Encoded TxRaw
 * @returns The decoded parts, or undefined
 */
function decodeCanonical(
  txBytes: Uint8Array,
): { raw: TxRaw; body: TxBody; authInfo: AuthInfo } | undefined {
  try {
    const raw = TxRaw.decode(txBytes);
    const body = TxBody.decode(raw.bodyBytes);
    const authInfo = AuthInfo.decode(raw.authInfoBytes);
    if (
      !bytesEqual(TxRaw.encode(raw).finish(), txBytes) ||
      !bytesEqual(TxBody.encode(body).finish(), raw.bodyBytes) ||
      !bytesEqual(AuthInfo.encode(authInfo).finish(), raw.authInfoBytes)
    ) {
      return undefined;
    }
    return { raw, body, authInfo };
  } catch {
    return undefined;
  }
}

/**
 * Maps a node's refusal log to a reason.
 *
 * @param log - The node's log
 * @returns Invalid reason
 */
function rejectReason(log: string): string {
  if (log.includes("insufficient funds")) return "insufficient_funds";
  if (log.includes("insufficient fee")) return "invalid_exact_cosmos_payload_fee";
  if (log.includes("out of gas")) return "invalid_exact_cosmos_payload_gas";
  if (log.includes("account sequence mismatch") || log.includes("incorrect account sequence")) {
    return "invalid_exact_cosmos_payload_sequence";
  }
  return "invalid_exact_cosmos_settlement_rejected";
}

/**
 * Text of an unknown error.
 *
 * @param error - Thrown value
 * @returns Message
 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
