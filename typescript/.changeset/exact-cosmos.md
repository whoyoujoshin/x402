---
"@x402/cosmos": minor
---

Add `@x402/cosmos`, the exact scheme on Cosmos SDK chains (`cosmos:<chain-id>`): the payer signs one bank `MsgSend` and pays its fee, and the facilitator verifies and broadcasts it, holding no key. Accepts secp256k1, Injective eth_secp256k1 and Aether ML-DSA-44 account keys, and native or IBC denoms.
