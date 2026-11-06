import test from "node:test";
import assert from "node:assert/strict";
import { startFakeOrdersApi } from "./fakeOrdersApi.js";
import { placeOrder } from "../src/checkout.js";

const cart = { customerId: "c_1", items: [{ sku: "bike-varg", qty: 1 }] };

test("places one order", async () => {
  const api = await startFakeOrdersApi();
  try {
    const result = await placeOrder(cart, { baseUrl: api.baseUrl });
    assert.equal(result.status, "paid");
    assert.equal(api.orders.size, 1);
  } finally {
    await api.close();
  }
});

test("rejects an empty cart", async () => {
  await assert.rejects(placeOrder({ customerId: "c_1", items: [] }, { baseUrl: "http://127.0.0.1:9" }), /Cart is empty/);
});
