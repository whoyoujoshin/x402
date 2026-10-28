import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { hex } from "@scure/base";
import type { PaymentPayload } from "@x402/core/types";
import { PubKey } from "cosmjs-types/cosmos/crypto/secp256k1/keys";
import { AuthInfo, SignDoc } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_KEY_TTL_MS,
  AETHER_MLDSA44_PUBKEY_TYPE_URL,
  addressBytes,
  aetherMlDsa44Verifier,
  type ClientCosmosSigner,
} from "../../src";
import { ExactCosmosScheme as Client } from "../../src/exact/client";
import { ExactCosmosScheme as Facilitator } from "../../src/exact/facilitator";
import { signsFor } from "../../src/signs-for";
import { fakeChain, mutateTx, paymentPayload, requirementsFor } from "./helpers";
import rotation from "./rotation-signs-for.json";
import vectors from "./vectors.json";

const TYPE_URL = AETHER_MLDSA44_PUBKEY_TYPE_URL;
const requirements = requirementsFor(
  "cosmos:aether-rc-vectors",
  "uaeth",
  "250000",
  rotation.keys.next.address,
);

/** `null` is the explicit no-key signal. Empty vector `stored` is that case. */
const storedKey = (raw: string) =>
  raw === "" ? null : { typeUrl: TYPE_URL, key: hex.decode(raw) };

const chainStoring = (raw: string) =>
  fakeChain({
    getAccount: async () => ({
      accountNumber: 7n,
      sequence: 3n,
      pubKey: storedKey(raw),
    }),
  });

describe("signsFor (aether clients/testdata/rotation.json)", () => {
  it.each(rotation.signsFor)("$name", vector => {
    const account = addressBytes(vector.account);
    expect(account).toBeDefined();
    expect(
      signsFor(
        account!,
        TYPE_URL,
        hex.decode(vector.pubKey),
        storedKey(vector.stored) ?? undefined,
        aetherMlDsa44Verifier,
      ),
    ).toBe(vector.signsFor);
  });

  it("reproduces the vector keys from their seeds", () => {
    for (const key of [rotation.keys.owner, rotation.keys.next]) {
      const { publicKey } = ml_dsa44.keygen(hex.decode(key.seed));
      expect(hex.encode(publicKey)).toBe(key.pubKey);
      expect(aetherMlDsa44Verifier.address(publicKey)).toEqual(addressBytes(key.address));
    }
  });

  it("refuses a stored key of another type, and a key with no address", () => {
    const key = hex.decode(rotation.keys.owner.pubKey);
    const account = addressBytes(rotation.keys.owner.address)!;
    expect(
      signsFor(account, TYPE_URL, key, { typeUrl: "/other.PubKey", key }, aetherMlDsa44Verifier),
    ).toBe(false);
    expect(
      signsFor(account, TYPE_URL, key, undefined, {
        address: () => {
          throw new Error("bad point");
        },
        verify: () => false,
      }),
    ).toBe(false);
  });
});

describe("a rotated payer", () => {
  let ownerPayment: PaymentPayload;
  let nextPayment: PaymentPayload;

  beforeAll(async () => {
    const signedBy = async (seed: string) => {
      const { publicKey, secretKey } = ml_dsa44.keygen(hex.decode(seed));
      const signer: ClientCosmosSigner = {
        address: rotation.keys.owner.address,
        pubKey: { typeUrl: TYPE_URL, value: PubKey.encode({ key: publicKey }).finish() },
        signDirect: doc => ml_dsa44.sign(SignDoc.encode(doc).finish(), secretKey),
      };
      const { payload } = await new Client(signer, {
        chainClient: fakeChain(),
        gasLimit: 200_000n,
      }).createPaymentPayload(2, requirements);
      return paymentPayload(requirements, (payload as { transaction: string }).transaction);
    };
    ownerPayment = await signedBy(rotation.keys.owner.seed);
    nextPayment = await signedBy(rotation.keys.next.seed);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const presented = (vector: (typeof rotation.signsFor)[number]): PaymentPayload => {
    if (vector.pubKey === rotation.keys.owner.pubKey) return ownerPayment;
    if (vector.pubKey === rotation.keys.next.pubKey) return nextPayment;
    const transaction = mutateTx(
      (ownerPayment.payload as { transaction: string }).transaction,
      raw => {
        const auth = AuthInfo.decode(raw.authInfoBytes);
        auth.signerInfos[0].publicKey = {
          typeUrl: TYPE_URL,
          value: PubKey.encode({ key: hex.decode(vector.pubKey) }).finish(),
        };
        raw.authInfoBytes = AuthInfo.encode(auth).finish();
      },
    );
    return paymentPayload(requirements, transaction);
  };

  it.each(rotation.signsFor)("$name", async vector => {
    const result = await new Facilitator({ chainClient: chainStoring(vector.stored) }).verify(
      presented(vector),
      requirements,
    );
    expect(result).toEqual(
      vector.signsFor
        ? { isValid: true, payer: vector.account }
        : {
            isValid: false,
            invalidReason: "invalid_exact_cosmos_payload_signer",
            payer: vector.account,
          },
    );
  });

  it("keeps a stored key for the cache window, then reads it again", async () => {
    let stored = rotation.keys.next.pubKey;
    const getAccount = vi.fn(async () => ({
      accountNumber: 7n,
      sequence: 3n,
      pubKey: storedKey(stored),
    }));
    const facilitator = new Facilitator({ chainClient: fakeChain({ getAccount }) });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);

    expect(await facilitator.verify(nextPayment, requirements)).toEqual({
      isValid: true,
      payer: rotation.keys.owner.address,
    });
    expect(getAccount).toHaveBeenCalledTimes(2);

    stored = rotation.keys.owner.pubKey;
    expect(await facilitator.verify(ownerPayment, requirements)).toMatchObject({
      isValid: false,
      invalidReason: "invalid_exact_cosmos_payload_signer",
    });
    expect(getAccount).toHaveBeenCalledTimes(2);

    vi.setSystemTime(1_000_000 + ACCOUNT_KEY_TTL_MS);
    expect(await facilitator.verify(ownerPayment, requirements)).toEqual({
      isValid: true,
      payer: rotation.keys.owner.address,
    });
    expect(getAccount).toHaveBeenCalledTimes(4);
  });

  it("refuses when the account-key lookup fails, and does not cache the failure", async () => {
    const vector = vectors.find(v => v.name === "secp256k1")!;
    const req = requirementsFor(
      `cosmos:${vector.chainId}`,
      vector.asset,
      vector.amount,
      vector.payTo,
    );
    const payload = paymentPayload(req, vector.transaction);
    let down = true;
    const facilitator = new Facilitator({
      chainClient: fakeChain({
        getAccount: async () => {
          if (down) {
            down = false;
            throw new Error("unavailable");
          }
          return { accountNumber: 7n, sequence: 3n, pubKey: null };
        },
      }),
    });
    expect(await facilitator.verify(payload, req)).toMatchObject({
      isValid: false,
      invalidReason: "unexpected_verify_error",
      invalidMessage: "unavailable",
    });
    expect(await facilitator.verify(payload, req)).toEqual({ isValid: true, payer: vector.payer });
  });

  it("refuses an omitted pubKey and does not cache that refusal", async () => {
    const vector = vectors.find(v => v.name === "secp256k1")!;
    const req = requirementsFor(
      `cosmos:${vector.chainId}`,
      vector.asset,
      vector.amount,
      vector.payTo,
    );
    const payload = paymentPayload(req, vector.transaction);
    let reported = false;
    const facilitator = new Facilitator({
      chainClient: fakeChain({
        getAccount: async () =>
          reported
            ? { accountNumber: 7n, sequence: 3n, pubKey: null }
            : { accountNumber: 7n, sequence: 3n },
      }),
    });
    expect(await facilitator.verify(payload, req)).toMatchObject({
      isValid: false,
      invalidReason: "unexpected_verify_error",
      invalidMessage: "account key lookup omitted pubKey",
    });
    reported = true;
    expect(await facilitator.verify(payload, req)).toEqual({ isValid: true, payer: vector.payer });
  });
});
