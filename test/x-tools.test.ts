import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import test from "node:test";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type TSchema } from "typebox";
import { Check } from "typebox/value";
import { X_TOOL_NAMES } from "../src/constants.js";
import { type Query, type XClient } from "../src/x/client.js";
import { formatXResult, registerXTools } from "../src/x/tools.js";

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
function harness(overrides: Record<string, unknown> = {}) {
  const tools = new Map<string, Tool>();
  const calls: { endpoint: string; query: Query; signal: AbortSignal | undefined }[] = [];
  const client: XClient = {
    rateLimit: { remaining: 42 },
    async get(endpoint, query, signal) {
      calls.push({ endpoint, query, signal });
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
    () => client
  );
  const run = async (name: string, params: unknown, signal?: AbortSignal) => {
    const tool = tools.get(name);
    assert.ok(tool);
    assert.equal(Check(tool.parameters, params), true, `valid input to ${name}`);
    const result = await tool.execute("call", params, signal);
    assert.equal(Check(tool.outputSchema, result.structuredContent), true);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    assert.equal(result.details.rate_limit_remaining, 42);
    return result.structuredContent;
  };
  return { tools, calls, run };
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
  await assert.rejects(
    h.tools.get("x_search")?.execute("c", { query: " " }) as Promise<unknown>,
    /blank/
  );
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
