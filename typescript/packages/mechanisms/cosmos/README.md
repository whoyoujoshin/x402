# `@x402/cosmos`

Cosmos SDK implementation of the x402 payment protocol using the **Exact** payment scheme ([spec](../../../../specs/schemes/exact/scheme_exact_cosmos.md)).

## Installation

```bash
npm install @x402/cosmos
# or
pnpm add @x402/cosmos
```

## Overview

The payer signs a complete transaction with one `cosmos.bank.v1beta1.MsgSend` of exactly the required amount to `payTo` and pays its fee. The facilitator checks it, broadcasts it and waits for it to be in a block. It holds no key and can't change where the funds go.

- **Client** - Builds and signs the transaction (`SIGN_MODE_DIRECT`). It simulates for the gas limit unless one is given.
- **Server** - Builds payment requirements from bank denom amounts.
- **Facilitator** - Verifies the transaction (signature, sequence, simulation) and settles it.

Every chain call goes through a `CosmosChainClient`. `createCometRpcClient(url)` provides one over a node's CometBFT RPC.

## Package Exports

### Main Package (`@x402/cosmos`)

- `createCometRpcClient(rpcUrl)` - Chain client on a CometBFT RPC endpoint.
- `createDirectSigner(offlineDirectSigner, options?)` - Client signer from a cosmjs-style direct signer (Keplr, Leap, cosmjs wallets).
- `DEFAULT_PUBKEY_VERIFIERS`, `secp256k1Verifier`, `ethSecp256k1Verifier`, `aetherMlDsa44Verifier` - Account key types the facilitator accepts.

### Subpath Exports

- `@x402/cosmos/exact/client` - `ExactCosmosScheme` client implementation.
- `@x402/cosmos/exact/server` - `ExactCosmosScheme` server implementation.
- `@x402/cosmos/exact/facilitator` - `ExactCosmosScheme` facilitator implementation.

## Supported Networks

Any chain built on Cosmos SDK v0.47 or later, as `cosmos:<chain-id>` (e.g. `cosmos:cosmoshub-4`, `cosmos:aether-testnet-1`). Register one scheme instance per chain, each with that chain's `CosmosChainClient`.

## Asset Support

`asset` is a bank denom (`uatom`, or `ibc/<hash>` for a token that arrived over IBC) and `amount` is an integer in its base units. There is no default USD asset: price routes as `{ amount, asset }`, or register a money parser that maps `"$0.01"` to the chain's USDC denom.

## Account Keys

The facilitator accepts these key types by default, and others through `pubKeyVerifiers`:

- `/cosmos.crypto.secp256k1.PubKey` - most Cosmos chains.
- `/injective.crypto.v1beta1.ethsecp256k1.PubKey` - Injective.
- `/aether.crypto.v1.PubKey` - ML-DSA-44 accounts on Aether.

## Usage

```typescript
import { x402Client } from "@x402/core/client";
import { createCometRpcClient, createDirectSigner } from "@x402/cosmos";
import { ExactCosmosScheme } from "@x402/cosmos/exact/client";

const chainClient = createCometRpcClient("https://cosmos-rpc.example.com");
const signer = await createDirectSigner(wallet); // e.g. DirectSecp256k1HdWallet
const client = new x402Client().register(
  "cosmos:cosmoshub-4",
  new ExactCosmosScheme(signer, { chainClient, gasPrice: "0.025uatom" }),
);
```

```typescript
import { createCometRpcClient } from "@x402/cosmos";
import { ExactCosmosScheme } from "@x402/cosmos/exact/facilitator";

facilitator.register(
  "cosmos:cosmoshub-4",
  new ExactCosmosScheme({ chainClient: createCometRpcClient("https://cosmos-rpc.example.com") }),
);
```

## Notes

- **Fees:** the payer pays them, set by the client's `gasPrice`. Without one the fee is empty, which only chains with a zero minimum gas price accept.
- **One payment at a time per account:** each transaction uses the account's next sequence.
- **Unordered transactions are refused:** these are SDK v0.53 transactions with `unordered: true`. They skip the sequence check, which is what stops a payment from being settled twice.
- **Duplicates:** the facilitator's settlement cache is per process. A horizontally scaled facilitator needs a shared one.

## Development

```bash
pnpm build
pnpm test
pnpm test:integration # needs COSMOS_* env vars, see test/integrations/exact-cosmos.test.ts
```
