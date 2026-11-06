# orders-service

Checkout backend. `placeOrder(cart)` places a customer's order through the upstream Orders API.

## Goal

Customers can complete checkout reliably, and each checkout results in exactly one order and one charge.

The upstream contract is in [docs/orders-api.md](docs/orders-api.md). Run tests with `npm test` (Node >= 20, no dependencies).
