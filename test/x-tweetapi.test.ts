import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createTweetApiClient,
  normalizeTweetApiPage,
  normalizeTweetApiTweet,
  TWEETAPI_SEARCH_URL,
} from "../src/x/tweetapi.js";

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/x/tweetapi-search-${name}.json`, import.meta.url), "utf8")
  );
}

void test("TweetAPI Latest and mixed Top normalize to bounded SlimTweet pages", () => {
  const latest = normalizeTweetApiPage(fixture("latest"), "Latest");
  const top = normalizeTweetApiPage(fixture("top"), "Top");
  assert.deepEqual(top.items, latest.items);
  assert.equal(top.items.length, 1);
  assert.equal(top.next_cursor, undefined);
  assert.equal(latest.next_cursor, "opaque+/=cursor");
  const t = latest.items[0];
  assert.ok(t);
  assert.equal(t.url, "https://x.com/sample/status/101");
  assert.equal(t.created_at, "2026-01-01T00:00:00.000Z");
  assert.deepEqual(t.author, {
    id: "10",
    username: "sample",
    name: "Sample",
    verified: true,
    followers: 0,
  });
  assert.deepEqual(t.metrics, {
    likes: 0,
    retweets: 2,
    replies: 3,
    quotes: 4,
    bookmarks: 5,
    views: 6,
  });
  assert.deepEqual(t.reply_to, { tweet_id: "100", username: "parent" });
  assert.equal(t.conversation_id, "100");
  assert.deepEqual(t.links, ["https://example.com"]);
  assert.deepEqual(t.media, [
    { type: "photo", url: "https://example.com/photo.jpg" },
    { type: "video", url: "https://example.com/high.mp4", duration_s: 2.5 },
    { type: "gif", url: "https://example.com/gif.mp4" },
  ]);
  assert.deepEqual(t.article, { id: "90", title: "Article", preview: "Preview" });
  assert.equal(t.quoted?.id, "102");
  assert.equal(t.quoted?.quoted, undefined);
  assert.equal(t.retweet_of?.id, "103");
  assert.equal(normalizeTweetApiTweet({ id: "1", text: "", isPromoted: true }), undefined);
  const long = normalizeTweetApiTweet({
    id: "1",
    text: "😀".repeat(5000),
    quotedTweet: { id: "2", text: "a".repeat(3000) },
  });
  assert.equal(Array.from(long?.text ?? "").length, 4000);
  assert.equal(long?.quoted?.text.length, 1500);
});

void test("invalid responses never silently turn into empty results", () => {
  for (const raw of [
    {},
    { data: [], pagination: {} },
    { data: [{}], pagination: { nextCursor: null } },
    { data: [], pagination: { nextCursor: 1 } },
  ]) {
    assert.throws(() => normalizeTweetApiPage(raw, "Latest"), /unrecognized/);
  }
  assert.deepEqual(
    normalizeTweetApiPage({ data: [], pagination: { nextCursor: null } }, "Latest"),
    { items: [] }
  );
});

void test("fixed URL, key header, opaque cursor, no count, and bounded query", async () => {
  let calls = 0;
  const client = createTweetApiClient({
    apiKey: "secret",
    fetch: async (input, init) => {
      calls++;
      const url = new URL(String(input));
      assert.equal(url.origin + url.pathname, TWEETAPI_SEARCH_URL);
      assert.equal(url.searchParams.get("query"), "甜甜 & from:sample");
      assert.equal(url.searchParams.get("type"), "Latest");
      assert.equal(url.searchParams.get("cursor"), "opaque+/=cursor");
      assert.equal(url.searchParams.has("count"), false);
      assert.equal(new Headers(init?.headers).get("X-API-Key"), "secret");
      assert.equal(new Headers(init?.headers).has("x-rapidapi-key"), false);
      assert.equal(init?.redirect, "error");
      assert.ok(init?.signal);
      return Response.json(fixture("latest"));
    },
  });
  assert.equal(
    (await client.search("甜甜 & from:sample", "Latest", "opaque+/=cursor")).items.length,
    1
  );
  for (const query of [" ", "a".repeat(513)])
    await assert.rejects(client.search(query, "Latest"), /1–512/);
  assert.equal(calls, 1);
  await assert.rejects(
    createTweetApiClient({ apiKey: undefined }).search("ai", "Top"),
    /TWEETAPI_KEY/
  );
});

void test("503 retries once only with a bounded numeric Retry-After", async () => {
  for (const retry of ["0", "6", "-1", "garbage", null]) {
    let calls = 0;
    const client = createTweetApiClient({
      apiKey: "key",
      fetch: async () => {
        if (++calls > 1) return Response.json(fixture("latest"));
        return new Response("private body", {
          status: 503,
          headers: retry === null ? {} : { "retry-after": retry },
        });
      },
    });
    if (retry === "0") assert.equal((await client.search("ai", "Latest")).items.length, 1);
    else await assert.rejects(client.search("ai", "Latest"), /HTTP 503/);
    assert.equal(calls, retry === "0" ? 2 : 1);
  }
  let calls = 0;
  const persistent = createTweetApiClient({
    apiKey: "key",
    fetch: async () => {
      calls++;
      return new Response("", { status: 503, headers: { "retry-after": "0" } });
    },
  });
  await assert.rejects(persistent.search("ai", "Top"), /HTTP 503/);
  assert.equal(calls, 2);
});

void test("safe codes and actionable errors; no bodies or credentials, no 429 retry", async () => {
  for (const code of [
    "RATE_LIMITED",
    "QUOTA_EXHAUSTED",
    "SUBSCRIPTION_INACTIVE",
    "SECRET",
    "secret body\n",
  ]) {
    let calls = 0;
    const client = createTweetApiClient({
      apiKey: "secret",
      fetch: async () => {
        calls++;
        return Response.json({ code, message: "secret body" }, { status: 429 });
      },
    });
    await assert.rejects(client.search("ai", "Top"), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /secret|SECRET|body/);
      if (code.endsWith("EXHAUSTED") || code.endsWith("INACTIVE"))
        assert.match(error.message, /retrying will not help/);
      return true;
    });
    assert.equal(calls, 1);
  }
  for (const status of [400, 401, 403, 500]) {
    const client = createTweetApiClient({
      apiKey: "secret",
      fetch: async () => new Response("secret", { status }),
    });
    await assert.rejects(
      client.search("ai", "Latest"),
      (error) =>
        error instanceof Error &&
        error.message.includes(`HTTP ${status}`) &&
        !error.message.includes("secret")
    );
  }
  await assert.rejects(
    createTweetApiClient({ apiKey: "key", fetch: async () => new Response("html") }).search(
      "ai",
      "Top"
    ),
    /invalid JSON/
  );
  await assert.rejects(
    createTweetApiClient({
      apiKey: "key",
      fetch: async () => {
        throw new Error("secret");
      },
    }).search("ai", "Top"),
    /network error/
  );
});

void test("abort during retry wait and deadline preserve cancellation", async () => {
  const controller = new AbortController();
  const reason = new Error("stop");
  let calls = 0;
  const client = createTweetApiClient({
    apiKey: "key",
    fetch: async () => {
      calls++;
      setTimeout(() => controller.abort(reason), 20);
      return new Response("", { status: 503, headers: { "retry-after": "5" } });
    },
  });
  await assert.rejects(
    client.search("ai", "Top", undefined, controller.signal),
    (error) => error === reason
  );
  assert.equal(calls, 1);
  await assert.rejects(
    client.search("ai", "Top", undefined, controller.signal),
    (error) => error === reason
  );
  assert.equal(calls, 1);
  const timeout = createTweetApiClient({
    apiKey: "key",
    timeoutMs: 5,
    fetch: async () => new Response("", { status: 503, headers: { "retry-after": "1" } }),
  });
  await assert.rejects(timeout.search("ai", "Top"), { name: "TimeoutError" });
});
