import { createServer } from "node:http";
import { test } from "node:test";
import assert from "node:assert/strict";

test("serviceRequest normalizes AbortError timeouts without mutating native error.name", async () => {
  const server = createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    }, 100);
  });
  await listen(server);
  const { port } = server.address();
  process.env.WALLET_SERVICE_URL = `http://127.0.0.1:${port}`;
  const { serviceRequest } = await import(`../../packages/shared/service-client.mjs?timeout-test=${Date.now()}`);

  await assert.rejects(
    () => serviceRequest("wallet", "/slow", { method: "GET", timeoutMs: 5 }),
    (error) => {
      assert.equal(error.name, "AbortError");
      assert.equal(error.status, 504);
      assert.equal(error.body?.error, "upstream_timeout");
      return true;
    }
  );

  await close(server);
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
