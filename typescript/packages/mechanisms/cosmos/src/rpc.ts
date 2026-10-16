import { base64, hex } from "@scure/base";
import {
  QueryAccountInfoRequest,
  QueryAccountInfoResponse,
} from "cosmjs-types/cosmos/auth/v1beta1/query";
import { SimulateRequest, SimulateResponse } from "cosmjs-types/cosmos/tx/v1beta1/service";
import type { CosmosChainClient } from "./types";

type RpcResponse<T> = { result?: T; error?: { code: number; message: string; data?: string } };

type AbciQueryResult = { response: { code: number; log: string; value: string | null } };

/**
 * Error from a node: an RPC error or a non-zero ABCI code, with the node's log.
 */
export class CosmosRpcError extends Error {
  /**
   * Creates an RPC error.
   *
   * @param message - The node's log or error text
   * @param code - ABCI or JSON-RPC code
   */
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = "CosmosRpcError";
  }
}

/**
 * A {@link CosmosChainClient} on a CometBFT node's JSON-RPC endpoint (port
 * 26657 by default). Queries go through `abci_query`, so it needs no gRPC
 * endpoint.
 *
 * @param rpcUrl - The node's RPC URL, e.g. `https://rpc.cosmos.directory/cosmoshub`
 * @param fetchFn - Fetch implementation; the global fetch by default
 * @returns A chain client for that node
 */
export function createCometRpcClient(
  rpcUrl: string,
  fetchFn: typeof fetch = fetch,
): CosmosChainClient {
  let id = 0;
  const call = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    const res = await fetchFn(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    if (!res.ok) {
      throw new CosmosRpcError(`${method}: HTTP ${res.status}`, res.status);
    }
    const body = (await res.json()) as RpcResponse<T>;
    if (body.error) {
      throw new CosmosRpcError(
        `${method}: ${body.error.data ?? body.error.message}`,
        body.error.code,
      );
    }
    if (body.result === undefined) {
      throw new CosmosRpcError(`${method}: empty response`, -1);
    }
    return body.result;
  };
  const query = async (path: string, data: Uint8Array): Promise<Uint8Array> => {
    const { response } = await call<AbciQueryResult>("abci_query", {
      path,
      data: hex.encode(data),
      prove: false,
    });
    if (response.code !== 0) {
      throw new CosmosRpcError(response.log, response.code);
    }
    return base64.decode(response.value ?? "");
  };

  return {
    async getAccount(address) {
      let value: Uint8Array;
      try {
        value = await query(
          "/cosmos.auth.v1beta1.Query/AccountInfo",
          QueryAccountInfoRequest.encode({ address }).finish(),
        );
      } catch (error) {
        if (error instanceof CosmosRpcError && /not found/i.test(error.message)) {
          return undefined;
        }
        throw error;
      }
      const info = QueryAccountInfoResponse.decode(value).info;
      return info ? { accountNumber: info.accountNumber, sequence: info.sequence } : undefined;
    },

    async getLatestHeight() {
      const status = await call<{ sync_info: { latest_block_height: string } }>("status", {});
      return BigInt(status.sync_info.latest_block_height);
    },

    async simulate(txBytes) {
      const value = await query(
        "/cosmos.tx.v1beta1.Service/Simulate",
        SimulateRequest.encode(SimulateRequest.fromPartial({ txBytes })).finish(),
      );
      return { gasUsed: SimulateResponse.decode(value).gasInfo?.gasUsed ?? 0n };
    },

    async broadcastTxSync(txBytes) {
      const r = await call<{ code: number; log: string; hash: string }>("broadcast_tx_sync", {
        tx: base64.encode(txBytes),
      });
      return { hash: r.hash, code: r.code, log: r.log };
    },

    async getTx(hash) {
      try {
        const r = await call<{ height: string; tx_result: { code: number; log: string } }>("tx", {
          hash: base64.encode(hex.decode(hash.toLowerCase())),
          prove: false,
        });
        return { height: BigInt(r.height), code: r.tx_result.code, log: r.tx_result.log };
      } catch (error) {
        if (error instanceof CosmosRpcError && /not found/i.test(error.message)) {
          return undefined;
        }
        throw error;
      }
    },
  };
}
