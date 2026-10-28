import { base64 } from "@scure/base";
import { QueryAccountInfoResponse } from "cosmjs-types/cosmos/auth/v1beta1/query";
import { PubKey } from "cosmjs-types/cosmos/crypto/secp256k1/keys";
import { AuthInfo, TxRaw } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { describe, expect, it, vi } from "vitest";
import { createCometRpcClient, createDirectSigner, feeForGas } from "../../src";
import { ExactCosmosScheme as Client } from "../../src/exact/client";
import { ExactCosmosScheme as Facilitator } from "../../src/exact/facilitator";
import { ExactCosmosScheme as Server } from "../../src/exact/server";
import { addressOf, fakeChain, mlDsaSigner, requirementsFor, secp256k1Signer } from "./helpers";

describe("client", () => {
  const requirements = requirementsFor(
    "cosmos:aether-testnet-1",
    "uaeth",
    "250",
    addressOf("aether", 4, 32),
  );

  it("simulates the gas and signs with an ML-DSA-44 key", async () => {
    const simulate = vi.fn().mockResolvedValue({ gasUsed: 100_000n });
    const chainClient = fakeChain({ simulate });
    const signer = mlDsaSigner();
    const { payload } = await new Client(signer, { chainClient }).createPaymentPayload(
      2,
      requirements,
    );

    const tx = TxRaw.decode(base64.decode((payload as { transaction: string }).transaction));
    const fee = AuthInfo.decode(tx.authInfoBytes).fee!;
    expect(fee.gasLimit).toBe(140_000n);
    expect(fee.amount).toEqual([]);

    simulate.mockResolvedValue({ gasUsed: 100_000n });
    const result = await new Facilitator({ chainClient }).verify(
      { x402Version: 2, accepted: requirements, payload },
      requirements,
    );
    expect(result).toEqual({ isValid: true, payer: signer.address });
  });

  it("refuses what it can't pay", async () => {
    const client = new Client(secp256k1Signer(), { chainClient: fakeChain(), gasLimit: 1n });
    await expect(client.createPaymentPayload(1, requirements)).rejects.toThrow("version");
    await expect(
      client.createPaymentPayload(2, { ...requirements, network: "eip155:1" }),
    ).rejects.toThrow();
    await expect(
      client.createPaymentPayload(2, { ...requirements, amount: "0.5" }),
    ).rejects.toThrow();
    await expect(
      client.createPaymentPayload(2, { ...requirements, payTo: "nope" }),
    ).rejects.toThrow();
    const missing = new Client(secp256k1Signer(), {
      chainClient: fakeChain({ getAccount: async () => undefined }),
    });
    await expect(missing.createPaymentPayload(2, requirements)).rejects.toThrow("does not exist");
  });

  it("adapts a cosmjs direct signer", async () => {
    const inner = secp256k1Signer();
    const key = inner.pubKey.value.subarray(2); // PubKey { key } -> key bytes
    const signer = await createDirectSigner({
      getAccounts: async () => [{ address: inner.address, algo: "secp256k1", pubkey: key }],
      signDirect: async (_address, doc) => ({
        signature: { signature: base64.encode(await inner.signDirect(doc)) },
      }),
    });
    expect(signer.address).toBe(inner.address);
    expect(signer.pubKey).toEqual(inner.pubKey);
    await expect(
      createDirectSigner({
        getAccounts: async () => [{ address: "x", algo: "ethsecp256k1", pubkey: key }],
        signDirect: vi.fn(),
      }),
    ).rejects.toThrow("pubKeyTypeUrl");
  });
});

describe("feeForGas", () => {
  it("rounds up", () => {
    expect(feeForGas(200_000n, "0.025uatom")).toEqual({ denom: "uatom", amount: "5000" });
    expect(feeForGas(1n, "0.025uatom")).toEqual({ denom: "uatom", amount: "1" });
    expect(feeForGas(3n, "2uaeth")).toEqual({ denom: "uaeth", amount: "6" });
    expect(() => feeForGas(1n, "uatom")).toThrow();
  });
});

describe("server", () => {
  const network = "cosmos:aether-testnet-1";

  it("takes a denom amount", async () => {
    expect(await new Server().parsePrice({ amount: "1000", asset: "uaeth" }, network)).toEqual({
      amount: "1000",
      asset: "uaeth",
      extra: {},
    });
    await expect(
      new Server().parsePrice({ amount: "1.5", asset: "uaeth" }, network),
    ).rejects.toThrow();
    await expect(new Server().parsePrice({ amount: "1", asset: "" }, network)).rejects.toThrow();
  });

  it("needs a money parser for dollar prices", async () => {
    await expect(new Server().parsePrice("$0.01", network)).rejects.toThrow("money parser");
    const server = new Server().registerMoneyParser(async amount => ({
      amount: String(Math.round(Number(amount) * 1e6)),
      asset: "ibc/064D82A67318DD30F54A4E17B6E487C2864E8B075A5871D3ACAD7A7129F32C5C",
    }));
    expect((await server.parsePrice("$0.01", network)).amount).toBe("10000");
  });
});

describe("createCometRpcClient", () => {
  const rpc = (results: Record<string, unknown>) => {
    const fetchFn = vi.fn(async (_url: string, init: { body: string }) => {
      const { method } = JSON.parse(init.body) as { method: string };
      return new Response(JSON.stringify(results[method]));
    });
    return {
      client: createCometRpcClient("http://node", fetchFn as unknown as typeof fetch),
      fetchFn,
    };
  };

  it("reads the height and broadcasts", async () => {
    const { client, fetchFn } = rpc({
      status: { result: { sync_info: { latest_block_height: "268000" } } },
      broadcast_tx_sync: { result: { code: 0, log: "", hash: "AB" } },
    });
    expect(await client.getLatestHeight()).toBe(268_000n);
    expect(await client.broadcastTxSync(Uint8Array.of(1, 2))).toEqual({
      hash: "AB",
      code: 0,
      log: "",
    });
    expect(JSON.parse(fetchFn.mock.calls[1][1].body).params).toEqual({ tx: "AQI=" });
  });

  it("treats a missing account or transaction as undefined", async () => {
    const { client } = rpc({
      abci_query: {
        result: {
          response: { code: 22, log: "account aether1x not found: key not found", value: null },
        },
      },
      tx: { error: { code: -32603, message: "Internal error", data: "tx (AB) not found" } },
    });
    expect(await client.getAccount("aether1x")).toBeUndefined();
    expect(await client.getTx("AB")).toBeUndefined();
  });

  it("reads the public key stored on an account", async () => {
    const key = Uint8Array.of(2, 3, 4);
    const typeUrl = "/cosmos.crypto.secp256k1.PubKey";
    const encoded = (pubKey?: { typeUrl: string; value: Uint8Array }) =>
      base64.encode(
        QueryAccountInfoResponse.encode({
          info: {
            address: "cosmos1q",
            accountNumber: 7n,
            sequence: 3n,
            pubKey,
          },
        }).finish(),
      );
    const account = (value: string) =>
      rpc({
        abci_query: { result: { response: { code: 0, log: "", value } } },
      }).client;
    expect(
      await account(encoded({ typeUrl, value: PubKey.encode({ key }).finish() })).getAccount(
        "cosmos1q",
      ),
    ).toEqual({ accountNumber: 7n, sequence: 3n, pubKey: { typeUrl, key } });
    expect(await account(encoded()).getAccount("cosmos1q")).toEqual({
      accountNumber: 7n,
      sequence: 3n,
    });
    // A pubkey Any that doesn't carry key bytes is a failed lookup.
    await expect(
      account(encoded({ typeUrl, value: Uint8Array.of(0x10, 0x01) })).getAccount("cosmos1q"),
    ).rejects.toThrow("no key bytes");
    await expect(
      account(encoded({ typeUrl, value: Uint8Array.of(0xff) })).getAccount("cosmos1q"),
    ).rejects.toThrow("account pubkey");
  });

  it("reports a failed simulation with the node's log", async () => {
    const { client } = rpc({
      abci_query: { result: { response: { code: 5, log: "insufficient funds", value: null } } },
    });
    await expect(client.simulate(Uint8Array.of(1))).rejects.toThrow("insufficient funds");
  });
});
