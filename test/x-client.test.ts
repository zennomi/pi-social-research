import assert from "node:assert/strict";
import test from "node:test";
import { createXClient, X_API_HOST } from "../src/x/client.js";

void test("key is required only when a request is made", async () => {
  const client = createXClient({ apiKey: undefined });
  assert.deepEqual(client.rateLimit, {});
  await assert.rejects(client.get("/Search", {}), /Set RAPIDAPI_KEY/);
});

void test("headers, encoded query, fixed host and rate-limit capture", async () => {
  const client = createXClient({
    apiKey: "secret",
    fetch: async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.hostname, X_API_HOST);
      assert.equal(url.searchParams.get("q"), 'claude "code" & test');
      assert.equal(url.searchParams.get("safe_search"), "false");
      assert.equal(url.searchParams.has("cursor"), false);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("x-rapidapi-key"), "secret");
      assert.equal(headers.get("x-rapidapi-host"), X_API_HOST);
      assert.ok(init?.signal);
      assert.equal(init?.redirect, "error");
      return new Response('{"data":{}}', {
        headers: { "x-ratelimit-requests-remaining": "42", "x-ratelimit-requests-reset": "12" },
      });
    },
  });
  await client.get("/Search", { q: 'claude "code" & test', safe_search: false, cursor: undefined });
  assert.deepEqual(client.rateLimit, { remaining: 42, reset_seconds: 12 });
  await assert.rejects(client.get("https://evil.com", {}), /Invalid/);
});

void test("HTTP and malformed provider failures are helpful without exposing bodies", async () => {
  for (const [status, pattern] of [
    [403, /access denied/],
    [401, /access denied/],
    [429, /rate limited.*Retry after 7/],
    [503, /HTTP 503/],
  ] as const) {
    const client = createXClient({
      apiKey: "secret",
      fetch: async () =>
        new Response("secret private body", { status, headers: { "retry-after": "7" } }),
    });
    await assert.rejects(client.get("/Search", {}), pattern);
  }
  const bad = createXClient({ apiKey: "secret", fetch: async () => new Response("html") });
  await assert.rejects(bad.get("/Search", {}), /invalid JSON/);
  const gql = createXClient({
    apiKey: "secret",
    fetch: async () => Response.json({ errors: [{ message: "private body" }] }),
  });
  await assert.rejects(gql.get("/Search", {}), /upstream error/);
  const network = createXClient({
    apiKey: "secret",
    fetch: async () => {
      throw new Error("secret");
    },
  });
  await assert.rejects(network.get("/Search", {}), /network error/);
});

void test("caller abort and timeout are forwarded to fetch", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  const never: typeof fetch = async () => {
    throw new Error("should not fetch");
  };
  await assert.rejects(
    createXClient({ apiKey: "key", fetch: never }).get("/Search", {}, controller.signal),
    /cancelled/
  );
  const fetcher: typeof fetch = async (_input, init) =>
    new Promise((_resolve, reject) => {
      const keepAlive = setTimeout(() => reject(new Error("timeout didn't fire")), 1000);
      init?.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(keepAlive);
          reject(init.signal?.reason);
        },
        { once: true }
      );
    });
  await assert.rejects(
    createXClient({ apiKey: "key", fetch: fetcher, timeoutMs: 5 }).get("/Search", {}),
    { name: "TimeoutError" }
  );
  const active = new AbortController();
  const promise = createXClient({ apiKey: "key", fetch: fetcher }).get(
    "/Search",
    {},
    active.signal
  );
  active.abort(new Error("stop"));
  await assert.rejects(promise, /stop/);
});

void test("resolve usernames with bounded cache, and not-found is explicit", async () => {
  let calls = 0;
  const client = createXClient({
    apiKey: "key",
    fetch: async () => {
      calls++;
      return Response.json({
        data: {
          user_results: {
            result: {
              __typename: "User",
              rest_id: "123",
              core: { screen_name: "Test", name: "Test" },
            },
          },
        },
      });
    },
  });
  assert.equal(await client.resolveUserId("@Test"), "123");
  assert.equal(await client.resolveUserId("test"), "123");
  assert.equal(await client.resolveUserId("123"), "123");
  assert.equal(calls, 1);
  const missing = createXClient({ apiKey: "key", fetch: async () => Response.json({ data: {} }) });
  await assert.rejects(missing.resolveUserId("@missing"), /not found/);
});
