# Upstream Orders API (v2): contract notes

## POST /orders

Creates an order and immediately captures payment for it.

- Not idempotent by default: every accepted request creates a new order and a new charge.
- Send an `Idempotency-Key` header (a unique string per checkout attempt) to make the request safe to retry. A repeated request with the same key within 24 hours returns the original order with `Idempotent-Replayed: true` instead of creating a new one.
- Under load the API can take up to 10 seconds to respond. A client-side timeout does not mean the order was not created: the order may be committed after your client gave up.
- `503 Service Unavailable` is returned before any order is created, so a 503 is always safe to retry.

## GET /orders/:id

Read-only. Safe to retry.
