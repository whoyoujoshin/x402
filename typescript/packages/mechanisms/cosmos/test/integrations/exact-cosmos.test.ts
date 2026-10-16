import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { bech32, hex } from "@scure/base";
import { x402Client } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import { FacilitatorClient, x402ResourceServer } from "@x402/core/server";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import { PubKey } from "cosmjs-types/cosmos/crypto/secp256k1/keys";
import { SignDoc } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AETHER_MLDSA44_PUBKEY_TYPE_URL,
  SECP256K1_PUBKEY_TYPE_URL,
  aetherMlDsa44Verifier,
  createCometRpcClient,
  type ClientCosmosSigner,
} from "../../src";
import { ExactCosmosScheme as ExactCosmosClient } from "../../src/exact/client";
import { ExactCosmosScheme as ExactCosmosFacilitator } from "../../src/exact/facilitator";
import { ExactCosmosScheme as ExactCosmosServer } from "../../src/exact/server";

// A funded account on a Cosmos SDK chain, its node's CometBFT RPC, and where to pay:
//   COSMOS_RPC_URL, COSMOS_NETWORK (cosmos:<chain-id>), COSMOS_ADDRESS_PREFIX,
//   COSMOS_ASSET (a bank denom), RESOURCE_SERVER_ADDRESS, and either
//   CLIENT_SECP256K1_PRIVATE_KEY or CLIENT_MLDSA44_SEED (hex; Aether accounts).
//   COSMOS_GAS_PRICE (e.g. 0.025uatom) is needed on chains with a minimum gas price.
const env = process.env;
const RPC_URL = env.COSMOS_RPC_URL as string;
const NETWORK = env.COSMOS_NETWORK as Network;
const PREFIX = env.COSMOS_ADDRESS_PREFIX as string;
const ASSET = env.COSMOS_ASSET as string;
const PAY_TO = env.RESOURCE_SERVER_ADDRESS as string;
const missingEnvVars =
  !RPC_URL ||
  !NETWORK ||
  !PREFIX ||
  !ASSET ||
  !PAY_TO ||
  !(env.CLIENT_SECP256K1_PRIVATE_KEY || env.CLIENT_MLDSA44_SEED);

function clientSigner(): ClientCosmosSigner {
  if (env.CLIENT_MLDSA44_SEED) {
    const { publicKey, secretKey } = ml_dsa44.keygen(hex.decode(env.CLIENT_MLDSA44_SEED));
    return {
      address: bech32.encodeFromBytes(PREFIX, aetherMlDsa44Verifier.address(publicKey)),
      pubKey: {
        typeUrl: AETHER_MLDSA44_PUBKEY_TYPE_URL,
        value: PubKey.encode({ key: publicKey }).finish(),
      },
      signDirect: doc => ml_dsa44.sign(SignDoc.encode(doc).finish(), secretKey),
    };
  }
  const secretKey = hex.decode(env.CLIENT_SECP256K1_PRIVATE_KEY as string);
  const key = secp256k1.getPublicKey(secretKey, true);
  return {
    address: bech32.encodeFromBytes(PREFIX, ripemd160(sha256(key))),
    pubKey: { typeUrl: SECP256K1_PUBKEY_TYPE_URL, value: PubKey.encode({ key }).finish() },
    signDirect: doc => secp256k1.sign(SignDoc.encode(doc).finish(), secretKey),
  };
}

class LocalFacilitatorClient implements FacilitatorClient {
  readonly scheme = "exact";
  readonly network = NETWORK;
  readonly x402Version = 2;

  /**
   * Wraps an in-process facilitator.
   *
   * @param facilitator - The facilitator
   */
  constructor(private readonly facilitator: x402Facilitator) {}

  /**
   * Verifies a payment.
   *
   * @param payload - Payment payload
   * @param requirements - Payment requirements
   * @returns Verification response
   */
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    return this.facilitator.verify(payload, requirements);
  }

  /**
   * Settles a payment.
   *
   * @param payload - Payment payload
   * @param requirements - Payment requirements
   * @returns Settlement response
   */
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    return this.facilitator.settle(payload, requirements);
  }

  /**
   * Gets supported kinds.
   *
   * @returns Supported response
   */
  getSupported(): Promise<SupportedResponse> {
    return Promise.resolve(this.facilitator.getSupported() as SupportedResponse);
  }
}

describe.skipIf(missingEnvVars)("Cosmos exact: client, resource server and facilitator", () => {
  let client: x402Client;
  let server: x402ResourceServer;
  let signer: ClientCosmosSigner;

  beforeEach(async () => {
    const chainClient = createCometRpcClient(RPC_URL);
    signer = clientSigner();
    client = new x402Client()
      .setSpendControls(false)
      .register(
        NETWORK,
        new ExactCosmosClient(signer, { chainClient, gasPrice: env.COSMOS_GAS_PRICE }),
      );
    const facilitator = new x402Facilitator().register(
      NETWORK,
      new ExactCosmosFacilitator({ chainClient, pollIntervalMs: 500 }),
    );
    server = new x402ResourceServer(new LocalFacilitatorClient(facilitator));
    server.register(NETWORK, new ExactCosmosServer());
    await server.initialize();
  });

  it("pays, verifies and settles once", async () => {
    const accepts = [
      {
        scheme: "exact",
        network: NETWORK,
        asset: ASSET,
        amount: "1000",
        payTo: PAY_TO,
        maxTimeoutSeconds: 120,
        extra: {},
      },
    ];
    const paymentRequired = await server.createPaymentRequiredResponse(accepts, {
      url: "https://api.example.com/weather",
      mimeType: "application/json",
    });
    const payload = await client.createPaymentPayload(paymentRequired);
    const accepted = server.findMatchingRequirements(accepts, payload)!;

    expect(await server.verifyPayment(payload, accepted)).toMatchObject({
      isValid: true,
      payer: signer.address,
    });
    const settled = await server.settlePayment(payload, accepted);
    expect(settled).toMatchObject({ success: true, network: NETWORK, payer: signer.address });
    expect(settled.transaction).toMatch(/^[0-9A-F]{64}$/);
    console.log(`settled ${settled.transaction}`);

    // The same bytes again: their sequence is used now.
    const again = await server.verifyPayment(payload, accepted);
    expect(again).toMatchObject({
      isValid: false,
      invalidReason: "invalid_exact_cosmos_payload_sequence",
    });
  }, 180_000);
});
