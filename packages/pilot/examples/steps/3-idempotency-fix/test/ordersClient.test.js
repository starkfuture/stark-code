import test from "node:test";
import assert from "node:assert/strict";
import { startFakeOrdersApi } from "./fakeOrdersApi.js";
import { createOrdersClient } from "../src/ordersClient.js";
import { placeOrder } from "../src/checkout.js";

const cart = { customerId: "c_1", items: [{ sku: "bike-varg", qty: 1 }] };

test("getOrder retries a transient 503", async () => {
  const api = await startFakeOrdersApi({ failGet503: 2 });
  try {
    const { orderId } = await placeOrder(cart, { baseUrl: api.baseUrl });
    const order = await createOrdersClient({ baseUrl: api.baseUrl }).getOrder(orderId);
    assert.equal(order.id, orderId);
  } finally {
    await api.close();
  }
});

test("createOrder retries a transient 503", async () => {
  const api = await startFakeOrdersApi({ fail503: 2 });
  try {
    const result = await placeOrder(cart, { baseUrl: api.baseUrl });
    assert.equal(result.status, "paid");
    assert.equal(api.orders.size, 1);
  } finally {
    await api.close();
  }
});

test("a timed-out create that was committed is replayed, not duplicated", async () => {
  const api = await startFakeOrdersApi({ createDelayMs: 300 });
  try {
    const result = await placeOrder(cart, { baseUrl: api.baseUrl, timeoutMs: 100 });
    assert.equal(api.orders.size, 1, "exactly one order may exist after retries");
    assert.equal(result.orderId, [...api.orders.keys()][0], "the retry must replay the committed order");
    assert.ok(api.requests.length >= 2, "the first attempt timed out, so there was at least one retry");
    assert.equal(new Set(api.requests.map((r) => r.key)).size, 1, "every attempt carries the same idempotency key");
    assert.ok(api.requests[0].key, "the key is present");
  } finally {
    await api.close();
  }
});
