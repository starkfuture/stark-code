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
