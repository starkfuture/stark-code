// Thin client for the upstream Orders API (see docs/orders-api.md).
import { withRetry } from "./retry.js";

const DEFAULT_TIMEOUT_MS = 5000;

export class OrdersApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "OrdersApiError";
    this.status = status;
  }
}

async function request(baseUrl, path, { method = "GET", body, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(new URL(path, baseUrl), {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new OrdersApiError(`Orders API ${method} ${path} failed: ${res.status}`, res.status);
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(timer);
  }
}

export function createOrdersClient({ baseUrl, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return {
    createOrder(cart) {
      // Retry transient failures (timeouts, 5xx) so checkout survives a flaky Orders API.
      return withRetry(() =>
        request(baseUrl, "/orders", {
          method: "POST",
          body: { customerId: cart.customerId, items: cart.items },
          timeoutMs,
        }),
      );
    },
    getOrder(id) {
      // Reads are safe to retry (docs/orders-api.md).
      return withRetry(() => request(baseUrl, `/orders/${encodeURIComponent(id)}`, { timeoutMs }));
    },
  };
}
