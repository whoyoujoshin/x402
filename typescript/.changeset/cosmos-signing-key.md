---
"@x402/cosmos": patch
---

Fixed Cosmos facilitator verification of rotated account keys. The key that signs for an account is the one stored on chain. `pubKey: null` means no key is stored yet and the address hash is checked; omitting `pubKey` is a failed lookup and the payment is refused. A retired key is refused and the new key is accepted.
