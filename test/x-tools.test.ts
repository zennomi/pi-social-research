import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import test from "node:test";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type TObject, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { X_TOOL_NAMES } from "../src/constants.js";
import { createXClient, type Query, XApiError, type XClient } from "../src/x/client.js";
import { formatXResult, registerXTools } from "../src/x/tools.js";
import { type TweetApiClient, TweetApiError } from "../src/x/tweetapi.js";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/x/${name}.json`, import.meta.url), "utf8"));
}
interface Tool {
  parameters: TSchema;
  outputSchema: TSchema;
  annotations: { readOnlyHint: boolean };
  execute(
    id: string,
    params: unknown,
    signal?: AbortSignal
  ): Promise<ReturnType<typeof JSON.parse>>;
}
const mapping: Record<string, string> = {
  "/Search": "search_top",
  "/ListSearch": "listsearch",
  "/CommunitiesSearchSlice": "commsearch",
  "/TweetDetailConversation": "conv",
  "/TweetDetailv3": "detailv3",
  "/TweetQuotes": "quotes",
  "/TweetArticle": "article",
  "/UserResultByScreenName": "user",
  "/UserResultsByRestIds": "usersbyids",
  "/UserTweets": "usertweets",
  "/UserTweetsReplies": "usertweets",
  "/UserVerifiedFollowers": "verifiedf",
  "/FollowersLight": "followerslight",
  "/FollowingLight": "followerslight",
  "/ListTweetsTimeline": "listtweets",
  "/ListMembersTimeline": "listmembers",
  "/CommunityResultsById": "comminfo",
  "/CommunityTimeline": "commtl",
  "/CommunityMembers": "commmembers",
  "/Trends": "trends",
};
function harness(
  overrides: Record<string, unknown> = {},
  fallback?: TweetApiClient,
  clientOverride?: XClient
) {
  const tools = new Map<string, Tool>();
  const calls: { endpoint: string; query: Query; signal: AbortSignal | undefined }[] = [];
  const client: XClient = {
    rateLimit: { remaining: 42 },
    async get(endpoint, query, signal) {
      calls.push({ endpoint, query, signal });
      if (overrides[endpoint] instanceof Error) throw overrides[endpoint];
      return Object.hasOwn(overrides, endpoint)
        ? overrides[endpoint]
        : fixture(mapping[endpoint] ?? "empty-tweet");
    },
    async resolveUserId() {
      return "1353836358901501952";
    },
  };
  registerXTools(
    {
      registerTool: (tool: { name: string }) => tools.set(tool.name, tool as unknown as Tool),
    } as unknown as ExtensionAPI,
    () => clientOverride ?? client,
    () => fallback
  );
  const execute = async (name: string, params: unknown, signal?: AbortSignal) => {
    const tool = tools.get(name);
    assert.ok(tool);
    assert.equal(Check(tool.parameters, params), true, `valid input to ${name}`);
    const result = await tool.execute("call", params, signal);
    assert.equal(Check(tool.outputSchema, result.structuredContent), true);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    return result;
  };
  const run = async (name: string, params: unknown, signal?: AbortSignal) => {
    const result = await execute(name, params, signal);
    assert.notEqual(result.isError, true, `${name} must succeed`);
    if (result.structuredContent.provider === "tweetapi") {
      assert.equal(result.details.provider, "tweetapi");
      assert.equal(result.details.rate_limit_remaining, undefined);
    } else if (!clientOverride) assert.equal(result.details.rate_limit_remaining, 42);
    return result.structuredContent;
  };
  const runError = async (name: string, params: unknown, code: string, field = "cursor") => {
    const result = await execute(name, params);
    assert.equal(result.isError, true, `${name} must report an error, not a successful page`);
    const data = result.structuredContent;
    assert.equal(data.outcome, "error");
    assert.equal(data.code, code);
    assert.equal(data.field, field);
    assert.equal(data.retryable, false);
    assert.equal(typeof data.message, "string");
    assert.ok(data.message.length > 0);
    assert.equal(typeof data.suggestedAction, "string");
    assert.ok(data.suggestedAction.length > 0);
    assert.deepEqual(result.details, data);
    assert.equal(data.next_call.tool, name);
    assert.equal(data.next_call.arguments.cursor, null);
    assert.equal(Check(tools.get(name)?.parameters as TSchema, data.next_call.arguments), true);
    assert.equal(Object.hasOwn(data, "items"), false, "errors must not masquerade as empty pages");
    return data;
  };
  return { tools, calls, run, runError };
}

void test("9 read-only tools register with input/output schemas and validate bounds", () => {
  const h = harness();
  assert.deepEqual([...h.tools.keys()], X_TOOL_NAMES);
  for (const t of h.tools.values()) {
    assert.ok(t.parameters);
    assert.ok(t.outputSchema);
    assert.equal(t.annotations.readOnlyHint, true);
  }
  assert.equal(
    Check(h.tools.get("x_search")?.parameters as TSchema, { query: "ai", count: 51 }),
    false
  );
  assert.equal(Check(h.tools.get("x_get_user")?.parameters as TSchema, { users: [] }), false);
  assert.equal(
    Check(h.tools.get("x_user_network")?.parameters as TSchema, { user: "ai", relation: "likes" }),
    false
  );
});

void test("tool schemas serialize without TypeBox internals for Gemini/proxy requests", () => {
  for (const [name, tool] of harness().tools) {
    for (const key of ["parameters", "outputSchema"] as const) {
      assert.doesNotMatch(JSON.stringify(tool[key]), /"~[^"]*"\s*:/, `${name}.${key}`);
    }
  }
});

void test("serialized search schema preserves optional fields, enum and bounds", () => {
  const search = harness().tools.get("x_search");
  assert.ok(search);
  const parameters = JSON.parse(JSON.stringify(search.parameters)) as TObject;
  assert.deepEqual(parameters.required, ["query"]);
  assert.equal(Check(parameters, { query: "ai" }), true);
  for (const type of ["top", "latest", "people", "photos", "videos", "lists", "communities"]) {
    assert.equal(Check(parameters, { query: "ai", type, count: 20, cursor: "opaque" }), true);
  }
  for (const cursor of [null, "", " ", "\t\n", "-1", "/", ".remove", "  opaque+/=  "]) {
    assert.equal(Check(parameters, { query: "ai", cursor }), true, JSON.stringify({ cursor }));
  }
  for (const input of [
    {},
    { query: "" },
    { query: "ai", type: "posts" },
    { query: "ai", type: null },
    { query: "ai", count: 0 },
    { query: "ai", count: 51 },
    { query: "ai", count: 1.5 },
    { query: "ai", cursor: {} },
    { query: "ai", cursor: 0 },
    { query: "ai", cursor: "x".repeat(16001) },
  ]) {
    assert.equal(Check(parameters, input), false, JSON.stringify(input));
  }
});

void test("search dispatches posts, people, lists and communities and propagates cursor/signal", async () => {
  const h = harness();
  const controller = new AbortController();
  const page = await h.run(
    "x_search",
    { query: "claude", type: "latest", cursor: "opaque" },
    controller.signal
  );
  assert.ok(page.items[0].text);
  assert.equal(h.calls[0]?.query.type, "Latest");
  assert.equal(h.calls[0]?.query.cursor, "opaque");
  assert.equal(h.calls[0]?.signal, controller.signal);
  assert.ok(page.next_cursor);
  const people = harness({ "/Search": fixture("search_people") });
  const profiles = await people.run("x_search", { query: "claude", type: "people" });
  assert.ok(profiles.items[0].username);
  assert.ok((await h.run("x_search", { query: "ai", type: "lists" })).items[0].id);
  assert.ok((await h.run("x_search", { query: "ai", type: "communities" })).next_cursor);
  for (const cursor of [null, "", " ", "\t\n"]) {
    await h.run("x_search", { query: "ai", cursor });
    assert.equal(h.calls.at(-1)?.query.cursor, undefined);
  }
  for (const cursor of ["-1", "/", ".remove", "  opaque+/=  "]) {
    await h.run("x_search", { query: "ai", cursor });
    assert.equal(h.calls.at(-1)?.query.cursor, cursor, "opaque cursors must not be remapped");
  }
  const before = h.calls.length;
  const invalid = await h.runError("x_search", { query: " " }, "INVALID_QUERY", "query");
  assert.match(invalid.message, /blank/);
  assert.deepEqual(invalid.next_call.arguments, {
    query: "<original query>",
    type: "top",
    cursor: null,
  });
  assert.equal(h.calls.length, before, "invalid queries must not call the provider");
});

void test("empty first search page warns without losing its opaque cursor", async () => {
  const h = harness({
    "/Search": {
      instructions: [{ entries: [{ content: { cursorType: "Bottom", value: "sparse-next" } }] }],
    },
  });
  const first = await h.run("x_search", { query: "old posts" });
  assert.deepEqual(first.items, []);
  assert.equal(first.next_cursor, "sparse-next");
  assert.match(first.notice, /does not prove no posts exist/);
  assert.match(first.notice, /x_user_tweets/);
  const next = await h.run("x_search", { query: "old posts", cursor: first.next_cursor });
  assert.equal(next.notice, undefined);
  assert.equal((await harness().run("x_search", { query: "ai" })).notice, undefined);
});

void test("search retries primary then falls back, and continuation stays on TweetAPI", async () => {
  let primaryCalls = 0;
  const fallbackCalls: unknown[][] = [];
  const primary = createXClient({
    apiKey: "key",
    fetch: async () => {
      primaryCalls++;
      return new Response("", { status: 500 });
    },
  });
  const controller = new AbortController();
  const fallback: TweetApiClient = {
    search: async (...args) => {
      fallbackCalls.push(args);
      return {
        items: [{ id: "1", url: "https://x.com/sample/status/1", text: "test", metrics: {} }],
        next_cursor: "opaque+/=",
      };
    },
  };
  const h = harness({}, fallback, primary);
  const first = await h.run(
    "x_search",
    { query: "ai", type: "latest", count: 1 },
    controller.signal
  );
  assert.equal(primaryCalls, 2);
  assert.equal(first.provider, "tweetapi");
  assert.match(first.notice, /twitter283 search failed.*count is ignored/);
  assert.equal(first.next_cursor, "tweetapi:opaque+/=");
  assert.deepEqual(fallbackCalls[0], ["ai", "Latest", undefined, controller.signal]);
  const second = await h.run("x_search", {
    query: "ai",
    type: "latest",
    cursor: first.next_cursor,
  });
  assert.equal(primaryCalls, 2);
  assert.match(second.notice, /Continuing/);
  assert.deepEqual(fallbackCalls[1], ["ai", "Latest", "opaque+/=", undefined]);
  const raw = await h.tools
    .get("x_search")
    ?.execute("c", { query: "ai", cursor: "tweetapi:opaque" });
  assert.equal(raw.details.provider, "tweetapi");
  assert.equal(raw.details.endpoint, "TweetAPI /tw-v2/search");
});

void test("fallback failures are actionable; all eligibility and cursor boundaries are enforced", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const outage = new XApiError("X API HTTP 500 for /Search.", true, 500);
  await assert.rejects(
    harness({ "/Search": outage }).run("x_search", { query: "ai" }),
    /HTTP 500.*Set TWEETAPI_KEY/
  );
  const failing: TweetApiClient = {
    search: async () => {
      throw new TweetApiError("HTTP 429 QUOTA_EXHAUSTED");
    },
  };
  await assert.rejects(
    harness({ "/Search": outage }, failing).run("x_search", { query: "ai" }),
    /twitter283:.*HTTP 500.*TweetAPI:.*QUOTA_EXHAUSTED/
  );
  let calls = 0;
  const fallback: TweetApiClient = {
    search: async () => {
      calls++;
      return { items: [] };
    },
  };
  for (const type of ["people", "photos", "videos", "lists", "communities"]) {
    const h = harness(
      { "/Search": outage, "/ListSearch": outage, "/CommunitiesSearchSlice": outage },
      fallback
    );
    await assert.rejects(h.run("x_search", { query: "ai", type }), (error) => error === outage);
    const before = h.calls.length;
    const invalid = await h.runError(
      "x_search",
      { query: "private-query", type, cursor: "tweetapi:private-cursor", extra: "private-extra" },
      "INVALID_CURSOR"
    );
    assert.match(invalid.message, /same top/);
    assert.deepEqual(invalid.next_call.arguments, {
      query: "<original query>",
      type,
      cursor: null,
    });
    assert.doesNotMatch(JSON.stringify(invalid), /private-query|private-cursor|private-extra/);
    assert.equal(h.calls.length, before, "invalid fallback cursors must not reach primary");
  }
  for (const error of [
    new Error("bug"),
    new XApiError("HTTP 400", false, 400),
    new DOMException("aborted", "AbortError"),
  ]) {
    await assert.rejects(
      harness({ "/Search": error }, fallback).run("x_search", { query: "ai" }),
      (e) => e === error
    );
  }
  const h = harness({ "/Search": outage }, fallback);
  for (const cursor of ["twitter283-cursor", "-1", "/", ".remove", "  opaque+/=  "]) {
    const invalid = await h.runError(
      "x_search",
      { query: "private-query", cursor },
      "CURSOR_PROVIDER_MISMATCH"
    );
    assert.match(invalid.message, /Cannot switch providers/);
    assert.match(invalid.suggestedAction, /placeholder.*cursor:null/);
    assert.deepEqual(invalid.next_call.arguments, {
      query: "<original query>",
      type: "top",
      cursor: null,
    });
    assert.doesNotMatch(JSON.stringify(invalid), /private-query/);
    assert.equal(h.calls.at(-1)?.query.cursor, cursor);
    assert.equal(calls, 0, "primary cursors must never cross to the fallback provider");
  }
  const beforeInvalid = h.calls.length;
  for (const cursor of ["tweetapi:", "tweetapi: \t"]) {
    const invalid = await h.runError("x_search", { query: "ai", cursor }, "INVALID_CURSOR");
    assert.match(invalid.message, /non-empty cursor/);
  }
  const controller = new AbortController();
  const cancelled = new Error("cancelled");
  controller.abort(cancelled);
  await assert.rejects(
    h.run("x_search", { query: "ai" }, controller.signal),
    (error) => error === cancelled
  );
  assert.equal(h.calls.length, beforeInvalid, "invalid/aborted calls must not reach primary");
  assert.equal(calls, 0);
  for (const status of [401, 403, 429, 200]) {
    const data = await harness(
      { "/Search": new XApiError("failure", status === 200, status) },
      fallback
    ).run("x_search", { query: "ai" });
    assert.equal(data.provider, "tweetapi");
    assert.equal(data.next_cursor, undefined);
    assert.match(data.notice, /No results/);
  }
  const before = calls;
  await harness({ "/Search": { instructions: [] } }, fallback).run("x_search", { query: "ai" });
  await harness({}, fallback).run("x_search", { query: "ai" });
  assert.equal(calls, before, "empty/successful primary must not fall back");

  const cooldown = harness({ "/Search": outage }, fallback);
  await cooldown.run("x_search", { query: "one", cursor: null });
  await cooldown.run("x_search", { query: "two", cursor: " \t" });
  assert.equal(cooldown.calls.length, 1, "first-page calls reuse fallback during cooldown");
  assert.equal(calls, before + 2, "fallback responses, including empty pages, are not cached");
  t.mock.timers.tick(29_999);
  await cooldown.run("x_search", { query: "three" });
  assert.equal(cooldown.calls.length, 1);
  t.mock.timers.tick(1);
  await cooldown.run("x_search", { query: "four" });
  assert.equal(cooldown.calls.length, 2, "primary is probed when the 30-second cooldown expires");
  assert.equal(calls, before + 4);

  const standalone = harness();
  const tweet = "1768778186186195177";
  for (const cursor of [null, "", " \t"]) {
    const data = await standalone.run("x_get_tweet", { tweet, include: "none", cursor });
    assert.equal(data.tweet.id, tweet);
    assert.equal(Object.hasOwn(data, "replies"), false);
    assert.equal(standalone.calls.at(-1)?.endpoint, "/TweetDetailv3");
  }
  const beforeStandalone = standalone.calls.length;
  const invalid = await standalone.runError(
    "x_get_tweet",
    {
      tweet: `https://x.com/sample/status/${tweet}?token=private-token`,
      include: "none",
      cursor: ".remove",
      extra: "private-extra",
    },
    "INVALID_CURSOR"
  );
  assert.deepEqual(invalid.next_call.arguments, { tweet, include: "none", cursor: null });
  assert.doesNotMatch(JSON.stringify(invalid), /private-token|private-extra/);
  assert.equal(standalone.calls.length, beforeStandalone);
});

void test("tweet includes replies, quotes or standalone detail, with not-found errors", async () => {
  const h = harness();
  const tweet = "1768778186186195177";
  const replies = await h.run("x_get_tweet", { tweet });
  assert.equal(replies.tweet.id, tweet);
  assert.ok(replies.replies.length);
  const quotes = await h.run("x_get_tweet", { tweet, include: "quotes" });
  assert.ok(quotes.quotes.length);
  assert.ok(quotes.next_cursor);
  const alone = await h.run("x_get_tweet", { tweet, include: "none" });
  assert.equal(alone.tweet.id, tweet);
  assert.equal(Object.hasOwn(alone, "replies"), false);
  const missing = harness({
    "/TweetDetailConversation": { instructions: [] },
    "/TweetDetailv3": fixture("empty-tweet"),
  });
  await assert.rejects(missing.run("x_get_tweet", { tweet: "1" }), /not found/);
  const secondPage = harness({ "/TweetDetailConversation": { instructions: [] } });
  assert.equal((await secondPage.run("x_get_tweet", { tweet, cursor: "next" })).tweet.id, tweet);
});

void test("wrapped detail without inner typename works for none and quotes", async () => {
  const h = harness({ "/TweetDetailv3": fixture("detailv3-sensitive") });
  for (const include of ["none", "quotes"]) {
    const result = await h.run("x_get_tweet", { tweet: "123", include });
    assert.equal(result.tweet.id, "123");
    assert.equal(result.tweet.text, "Synthetic wrapped tweet");
    assert.equal(result.tweet.author.username, "sample");
  }
  await assert.rejects(h.run("x_get_tweet", { tweet: "999", include: "none" }), /not found/);
});

void test("search description explains post types; article mistakes get targeted hints", async () => {
  const h = harness({
    "/TweetArticle": fixture("empty-tweet"),
    "/TweetDetailv3": fixture("empty-tweet"),
  });
  const parameters = h.tools.get("x_search")?.parameters as unknown as {
    properties: { type: { description: string } };
  };
  assert.match(parameters.properties.type.description, /top.*latest = posts/);
  assert.equal(
    Check(h.tools.get("x_search")?.parameters as TSchema, { query: "ai", type: "posts" }),
    false
  );
  await assert.rejects(h.run("x_get_article", { tweet: "123" }), /containing tweet's ID/);
  await assert.rejects(
    h.run("x_get_tweet", { tweet: "123", include: "none" }),
    /containing tweet's ID/
  );
  const before = h.calls.length;
  await assert.rejects(
    h.run("x_get_article", { tweet: "https://x.com/i/article/123" }),
    /X article URL/
  );
  assert.equal(h.calls.length, before);
});

void test("article, profiles, timeline and all network modes", async () => {
  const h = harness();
  assert.match(
    (await h.run("x_get_article", { tweet: "1905545699552375179" })).markdown,
    /When Tokens Burn/
  );
  const profiles = await h.run("x_get_user", { users: ["@AnthropicAI", "44196397"] });
  assert.ok(profiles.items.length);
  assert.ok(
    (await h.run("x_user_tweets", { user: "@AnthropicAI", include_replies: true })).items.length
  );
  assert.equal(h.calls.at(-1)?.endpoint, "/UserTweetsReplies");
  for (const relation of ["followers", "following", "verified_followers"]) {
    assert.ok(
      (await h.run("x_user_network", { user: "@AnthropicAI", relation, count: 20 })).items.length
    );
  }
  const missing = harness({ "/UserResultByScreenName": fixture("empty-user") });
  await assert.rejects(missing.run("x_get_user", { users: ["missing"] }), /not found/);
  const partial = await missing.run("x_get_user", { users: ["missing", "44196397"] });
  assert.deepEqual(partial.not_found, ["missing"]);
});

void test("lists, community views and trends", async () => {
  const h = harness();
  for (const view of ["tweets", "members"])
    assert.ok((await h.run("x_list", { list_id: "1585430245762441216", view })).items.length);
  assert.ok((await h.run("x_community", { community_id: "1502929685792976898" })).community.name);
  assert.ok(
    (
      await h.run("x_community", {
        community_id: "1502929685792976898",
        view: "tweets",
        sort: "likes",
        time_filter: "week",
      })
    ).items.length
  );
  assert.equal(h.calls.at(-1)?.query.type, "Likes");
  assert.equal(h.calls.at(-1)?.query.time_filter, "Week");
  const members = await h.run("x_community", {
    community_id: "1502929685792976898",
    view: "members",
  });
  assert.equal(members.items[0].username, "CryptoCrunchApp");
  assert.ok(members.next_cursor);
  await assert.rejects(
    h.run("x_community", { community_id: "1", view: "tweets", time_filter: "day" }),
    /requires/
  );
  assert.equal((await h.run("x_trends", { count: 2 })).items.length, 2);
});

void test("ancestor replies are separate and nested quoted tweets aren't top-level replies", async () => {
  const item = (id: string, parent?: string) => ({
    entry_id: `tweet-${id}`,
    content: {
      content: {
        __typename: "TimelineTweet",
        tweet_results: {
          result: {
            __typename: "Tweet",
            rest_id: id,
            legacy: { full_text: id, in_reply_to_status_id_str: parent },
          },
        },
      },
    },
  });
  const h = harness({
    "/TweetDetailConversation": {
      instructions: [{ entries: [item("1"), item("2", "1"), item("3", "2"), item("4", "3")] }],
    },
  });
  const result = await h.run("x_get_tweet", { tweet: "3" });
  assert.deepEqual(
    result.ancestors.map((t: { id: string }) => t.id),
    ["1", "2"]
  );
  assert.deepEqual(
    result.replies.map((t: { id: string }) => t.id),
    ["4"]
  );
});

void test("unrecognized payloads fail instead of returning false empty pages", async () => {
  const cases: [string, object, string][] = [
    ["x_search", { query: "ai" }, "/Search"],
    ["x_search", { query: "ai", type: "lists" }, "/ListSearch"],
    ["x_search", { query: "ai", type: "communities" }, "/CommunitiesSearchSlice"],
    ["x_user_tweets", { user: "123" }, "/UserTweets"],
    ["x_user_network", { user: "123", relation: "verified_followers" }, "/UserVerifiedFollowers"],
    ["x_user_network", { user: "123", relation: "followers" }, "/FollowersLight"],
    ["x_list", { list_id: "123" }, "/ListTweetsTimeline"],
    ["x_community", { community_id: "123", view: "tweets" }, "/CommunityTimeline"],
    ["x_trends", {}, "/Trends"],
  ];
  for (const [name, params, endpoint] of cases) {
    const h = harness({ [endpoint]: fixture("empty-user") });
    await assert.rejects(h.run(name, params), /unavailable|unrecognized/);
  }
  const empty = harness({ "/Search": { data: { timeline: { instructions: [] } } } });
  assert.deepEqual((await empty.run("x_search", { query: "ai" })).items, []);
});

void test("oversized content is truncated with full normalized output accessible", async () => {
  const data = { text: "😀".repeat(30_000) };
  const result = await formatXResult(data, {});
  const file = result.details.full_output_path;
  assert.ok(file);
  try {
    assert.match(result.content[0]?.text ?? "", /Output truncated/);
    assert.ok(Buffer.byteLength(result.content[0]?.text ?? "") < 52000);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), data);
    assert.deepEqual(result.structuredContent, data);
  } finally {
    await rm(dirname(file), { recursive: true, force: true });
  }
});
