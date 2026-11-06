import { randomUUID } from "node:crypto";
import { createOrdersClient } from "./ordersClient.js";

export async function placeOrder(cart, { baseUrl, timeoutMs } = {}) {
  if (!cart?.items?.length) throw new Error("Cart is empty");
  const client = createOrdersClient({ baseUrl, timeoutMs });
  const order = await client.createOrder(cart, { idempotencyKey: randomUUID() });
  return { orderId: order.id, status: order.status };
}
