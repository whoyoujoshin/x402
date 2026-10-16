import { sha256 } from "@noble/hashes/sha2.js";
import { base64, hex } from "@scure/base";
import { AuthInfo, TxBody } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { describe, expect, it, vi } from "vitest";
import { ExactCosmosScheme as Client } from "../../src/exact/client";
import { ExactCosmosScheme as Facilitator } from "../../src/exact/facilitator";
import { MAX_TRANSACTION_BYTES } from "../../src";
import {
  addressOf,
  fakeChain,
  mutateTx,
  paymentPayload,
  requirementsFor,
  secp256k1Signer,
} from "./helpers";
import vectors from "./vectors.json";

// Signed by Go: Aether's ML-DSA-44 and eth_secp256k1 keys and the SDK's secp256k1.
describe.each(vectors)("a payment signed in Go ($name)", vector => {
  const requirements = requirementsFor(
    `cosmos:${vector.chainId}`,
    vector.asset,
    vector.amount,
    vector.payTo,
  );
  const payload = paymentPayload(requirements, vector.transaction);

  it("verifies", async () => {
    const facilitator = new Facilitator({ chainClient: fakeChain() });
    expect(await facilitator.verify(payload, requirements)).toEqual({
      isValid: true,
      payer: vector.payer,
    });
  });

  it("is refused for another account number (the signature covers it)", async () => {
    const chainClient = fakeChain({
      getAccount: async () => ({ accountNumber: 8n, sequence: 3n }),
    });
    const result = await new Facilitator({ chainClient }).verify(payload, requirements);
    expect(result.invalidReason).toBe("invalid_exact_cosmos_payload_signature");
  });
});

describe("verification", () => {
  const vector = vectors.find(v => v.name === "secp256k1")!;
  const network = `cosmos:${vector.chainId}`;
  const requirements = requirementsFor(network, vector.asset, vector.amount, vector.payTo);
  const valid = paymentPayload(requirements, vector.transaction);
  const reason = async (
    payload = valid,
    req = requirements,
    chain = fakeChain(),
    pubKeyVerifiers?: Record<string, never>,
  ) =>
    (await new Facilitator({ chainClient: chain, pubKeyVerifiers }).verify(payload, req))
      .invalidReason;

  it("checks the envelope", async () => {
    expect(await reason({ ...valid, x402Version: 1 })).toBe("invalid_x402_version");
    expect(await reason(valid, { ...requirements, scheme: "upto" })).toBe("unsupported_scheme");
    expect(await reason(valid, { ...requirements, network: "cosmos:osmosis-1" })).toBe(
      "invalid_network",
    );
    expect(await reason(valid, { ...requirements, network: "eip155:1" })).toBe("invalid_network");
    expect(await reason(valid, { ...requirements, amount: "1" })).toBe(
      "invalid_exact_cosmos_payload_accepted_mismatch",
    );
    expect(await reason(valid, { ...requirements, asset: "not a denom" })).toBe(
      "invalid_payment_requirements",
    );
  });

  it("checks the payload decodes", async () => {
    expect(await reason({ ...valid, payload: {} })).toBe("invalid_payload");
    expect(await reason({ ...valid, payload: { transaction: "%%%" } })).toBe("invalid_payload");
    const tooBig = base64.encode(new Uint8Array(MAX_TRANSACTION_BYTES + 1));
    expect(await reason({ ...valid, payload: { transaction: tooBig } })).toBe("invalid_payload");
    expect(
      await reason({ ...valid, payload: { transaction: base64.encode(Uint8Array.of(0xff)) } }),
    ).toBe("invalid_exact_cosmos_payload_transaction");
  });

  it("refuses unknown fields", async () => {
    const bytes = base64.decode(vector.transaction);
    const extra = new Uint8Array([...bytes, 0x20, 0x01]); // field 4, varint 1
    expect(await reason({ ...valid, payload: { transaction: base64.encode(extra) } })).toBe(
      "invalid_exact_cosmos_payload_transaction",
    );
  });

  it("checks the transfer", async () => {
    const other = addressOf("cosmos", 9);
    const toOther = requirementsFor(network, vector.asset, vector.amount, other);
    expect(await reason(paymentPayload(toOther, vector.transaction), toOther)).toBe(
      "invalid_exact_cosmos_payload_recipient_mismatch",
    );
    const more = requirementsFor(network, vector.asset, "250001", vector.payTo);
    expect(await reason(paymentPayload(more, vector.transaction), more)).toBe(
      "invalid_exact_cosmos_payload_amount_mismatch",
    );
    const otherDenom = requirementsFor(network, "ibc/ABCD", vector.amount, vector.payTo);
    expect(await reason(paymentPayload(otherDenom, vector.transaction), otherDenom)).toBe(
      "invalid_exact_cosmos_payload_amount_mismatch",
    );
  });

  it("checks the body", async () => {
    const withBody = (change: (body: TxBody) => void) =>
      paymentPayload(
        requirements,
        mutateTx(vector.transaction, raw => {
          const body = TxBody.decode(raw.bodyBytes);
          change(body);
          raw.bodyBytes = TxBody.encode(body).finish();
        }),
      );
    expect(await reason(withBody(b => b.messages.push(b.messages[0])))).toBe(
      "invalid_exact_cosmos_payload_message",
    );
    expect(
      await reason(withBody(b => (b.messages[0].typeUrl = "/cosmos.bank.v1beta1.MsgMultiSend"))),
    ).toBe("invalid_exact_cosmos_payload_message");
    expect(await reason(withBody(b => (b.unordered = true)))).toBe(
      "invalid_exact_cosmos_payload_transaction",
    );
    expect(await reason(withBody(b => (b.timeoutHeight = 100n)))).toBe(
      "invalid_exact_cosmos_payload_expired",
    );
  });

  it("checks the signer and fee", async () => {
    const withAuth = (change: (auth: AuthInfo) => void) =>
      paymentPayload(
        requirements,
        mutateTx(vector.transaction, raw => {
          const auth = AuthInfo.decode(raw.authInfoBytes);
          change(auth);
          raw.authInfoBytes = AuthInfo.encode(auth).finish();
        }),
      );
    expect(await reason(valid, requirements, fakeChain(), {})).toBe(
      "invalid_exact_cosmos_payload_signer",
    );
    expect(
      await reason(withAuth(a => (a.signerInfos[0].modeInfo = { single: { mode: 127 } }))),
    ).toBe("invalid_exact_cosmos_payload_signer");
    expect(await reason(withAuth(a => a.signerInfos.push(a.signerInfos[0])))).toBe(
      "invalid_exact_cosmos_payload_signer",
    );
    expect(await reason(withAuth(a => (a.fee!.granter = addressOf("cosmos", 5))))).toBe(
      "invalid_exact_cosmos_payload_fee",
    );
    expect(await reason(withAuth(a => (a.fee!.payer = addressOf("cosmos", 5))))).toBe(
      "invalid_exact_cosmos_payload_fee",
    );
    const signer = secp256k1Signer();
    expect(await reason(withAuth(a => (a.signerInfos[0].publicKey = signer.pubKey)))).toBe(
      "invalid_exact_cosmos_payload_signer",
    );
    expect(
      await reason(
        paymentPayload(
          requirements,
          mutateTx(vector.transaction, raw => raw.signatures[0][0]++),
        ),
      ),
    ).toBe("invalid_exact_cosmos_payload_signature");
  });

  it("checks the account against the chain", async () => {
    const at = (sequence: bigint) =>
      fakeChain({ getAccount: async () => ({ accountNumber: 7n, sequence }) });
    expect(await reason(valid, requirements, at(4n))).toBe("invalid_exact_cosmos_payload_sequence");
    expect(await reason(valid, requirements, at(2n))).toBeUndefined();
    expect(
      await reason(valid, requirements, fakeChain({ getAccount: async () => undefined })),
    ).toBe("insufficient_funds");
  });

  it("checks the simulation", async () => {
    const simulating = (simulate: () => Promise<{ gasUsed: bigint }>) => fakeChain({ simulate });
    expect(
      await reason(
        valid,
        requirements,
        simulating(async () => ({ gasUsed: 200_001n })),
      ),
    ).toBe("invalid_exact_cosmos_payload_gas");
    expect(
      await reason(
        valid,
        requirements,
        simulating(async () => {
          throw new Error("0uatom is smaller than 250000uatom: insufficient funds");
        }),
      ),
    ).toBe("insufficient_funds");
  });
});

describe("settlement", () => {
  const vector = vectors.find(v => v.name === "ml-dsa-44")!;
  const requirements = requirementsFor(
    `cosmos:${vector.chainId}`,
    vector.asset,
    vector.amount,
    vector.payTo,
  );
  const payload = paymentPayload(requirements, vector.transaction);
  // The hash the chain indexes it by: uppercase hex SHA-256 of the TxRaw bytes.
  const hash = hex.encode(sha256(base64.decode(vector.transaction))).toUpperCase();

  it("broadcasts once and reports the hash", async () => {
    const broadcastTxSync = vi.fn().mockResolvedValue({ hash, code: 0, log: "" });
    const facilitator = new Facilitator({ chainClient: fakeChain({ broadcastTxSync }) });
    const [first, second] = await Promise.all([
      facilitator.settle(payload, requirements),
      facilitator.settle(payload, requirements),
    ]);
    expect(first).toEqual({
      success: true,
      payer: vector.payer,
      transaction: hash,
      network: requirements.network,
      amount: vector.amount,
    });
    expect(second).toMatchObject({ success: false, errorReason: "duplicate_settlement" });
    expect(broadcastTxSync).toHaveBeenCalledOnce();
  });

  it("forgets a transaction the node refused", async () => {
    const broadcastTxSync = vi.fn().mockResolvedValue({ hash, code: 5, log: "insufficient funds" });
    const facilitator = new Facilitator({ chainClient: fakeChain({ broadcastTxSync }) });
    expect(await facilitator.settle(payload, requirements)).toMatchObject({
      success: false,
      errorReason: "insufficient_funds",
      transaction: hash,
    });
    await facilitator.settle(payload, requirements);
    expect(broadcastTxSync).toHaveBeenCalledTimes(2);
  });

  it("reports a transaction that failed in its block", async () => {
    const chainClient = fakeChain({
      getTx: async () => ({ height: 101n, code: 11, log: "out of gas" }),
    });
    expect(await new Facilitator({ chainClient }).settle(payload, requirements)).toMatchObject({
      success: false,
      errorReason: "invalid_exact_cosmos_payload_gas",
    });
  });

  it("gives up when the transaction doesn't land in time", async () => {
    const chainClient = fakeChain({ getTx: async () => undefined });
    const facilitator = new Facilitator({ chainClient, settleTimeoutMs: 0, pollIntervalMs: 1 });
    expect(
      await facilitator.settle(payload, { ...requirements, maxTimeoutSeconds: 0 }),
    ).toMatchObject({
      success: false,
      errorReason: "invalid_transaction_state",
      transaction: hash,
    });
  });

  it("doesn't broadcast a payment that fails verification", async () => {
    const broadcastTxSync = vi.fn();
    const chainClient = fakeChain({ broadcastTxSync, getAccount: async () => undefined });
    expect(await new Facilitator({ chainClient }).settle(payload, requirements)).toMatchObject({
      success: false,
      errorReason: "insufficient_funds",
      payer: vector.payer,
    });
    expect(broadcastTxSync).not.toHaveBeenCalled();
  });

  it("advertises that the payer pays the fee", () => {
    expect(
      new Facilitator({ chainClient: fakeChain(), feeDenom: "uaeth" }).getExtra("cosmos:x"),
    ).toEqual({
      feePayer: "payer",
      feeDenom: "uaeth",
    });
  });
});

describe("a payment built by the client", () => {
  it("verifies with the facilitator", async () => {
    const signer = secp256k1Signer();
    const requirements = requirementsFor(
      "cosmos:cosmoshub-4",
      "uatom",
      "1000",
      addressOf("cosmos", 3),
    );
    const chainClient = fakeChain();
    const client = new Client(signer, { chainClient, gasLimit: 200_000n, gasPrice: "0.025uatom" });
    const { payload } = await client.createPaymentPayload(2, requirements);
    const result = await new Facilitator({ chainClient }).verify(
      { x402Version: 2, accepted: requirements, payload },
      requirements,
    );
    expect(result).toEqual({ isValid: true, payer: signer.address });
  });
});
