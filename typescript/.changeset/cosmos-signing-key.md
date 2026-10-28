---
"@x402/cosmos": patch
---

Fixed Cosmos facilitator verification of rotated account keys. The key that signs for an account is the one stored on chain, and only an account with no stored key yet is checked by address hash, so a retired key is refused and the new key is accepted. A failed account-key lookup is a refusal.
