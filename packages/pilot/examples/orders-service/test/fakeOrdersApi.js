// In-memory stand-in for the upstream Orders API, following docs/orders-api.md.
import http from "node:http";

export async function startFakeOrdersApi({ createDelayMs = 0, fail503 = 0, failGet503 = 0 } = {}) {
  const orders = new Map();
  const byKey = new Map();
  const requests = []; // every POST /orders: { key }
  let seq = 0;
  let post503 = fail503;
  let get503 = failGet503;
  const json = (res, status, body, headers = {}) => {
    if (res.destroyed) return;
    res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (req.method === "POST" && req.url === "/orders") {
      requests.push({ key: req.headers["idempotency-key"] ?? null });
      if (post503 > 0) {
        post503--;
        return json(res, 503, { error: "unavailable" }); // nothing created
      }
      const key = req.headers["idempotency-key"];
      if (key && byKey.has(key)) return json(res, 200, orders.get(byKey.get(key)), { "idempotent-replayed": "true" });
      const order = { id: `ord_${++seq}`, status: "paid", ...JSON.parse(raw || "{}") };
      orders.set(order.id, order); // committed (and charged) before a slow response
      if (key) byKey.set(key, order.id);
      if (createDelayMs) await new Promise((r) => setTimeout(r, createDelayMs));
      return json(res, 201, order);
    }
    const m = req.url.match(/^\/orders\/([^/]+)$/);
    if (req.method === "GET" && m) {
      if (get503 > 0) {
        get503--;
        return json(res, 503, { error: "unavailable" });
      }
      const order = orders.get(decodeURIComponent(m[1]));
      return order ? json(res, 200, order) : json(res, 404, { error: "not found" });
    }
    json(res, 404, { error: "no route" });
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    orders,
    requests,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
  };
}
