// Explicit, opt-in quota-consuming check. Never print credentials or provider payloads.
import assert from "node:assert/strict";
import { createXClient, XApiError } from "../src/x/client.ts";
import { registerXTools } from "../src/x/tools.ts";
import { createTweetApiClient } from "../src/x/tweetapi.ts";

if (!process.env.RAPIDAPI_KEY?.trim()) throw new Error("Set RAPIDAPI_KEY to run this live check.");
const client = createXClient({ apiKey: process.env.RAPIDAPI_KEY });
let rawBytes = 0;
const tracked = {
  rateLimit: client.rateLimit,
  resolveUserId: client.resolveUserId,
  async get(endpoint, query, signal) {
    const raw = await client.get(endpoint, query, signal);
    rawBytes += Buffer.byteLength(JSON.stringify(raw));
    return raw;
  },
};
const fallback = process.env.TWEETAPI_KEY?.trim()
  ? createTweetApiClient({
      apiKey: process.env.TWEETAPI_KEY,
      async fetch(input, init) {
        const response = await fetch(input, init);
        if (response.ok) rawBytes += (await response.clone().arrayBuffer()).byteLength;
        return response;
      },
    })
  : undefined;
function toolsFor(primary) {
  const tools = new Map();
  registerXTools(
    { registerTool: (tool) => tools.set(tool.name, tool) },
    () => primary,
    () => fallback
  );
  return tools;
}
const tools = toolsFor(tracked);
const cases = [
  ["x_search", { query: '"Claude Code" min_faves:100', type: "latest", count: 10 }],
  ["x_get_tweet", { tweet: "1768778186186195177" }],
  ["x_get_tweet", { tweet: "1435259982786740233", include: "none" }],
  ["x_get_article", { tweet: "1905545699552375179" }],
  ["x_get_user", { users: ["@AnthropicAI"] }],
  ["x_user_tweets", { user: "@AnthropicAI" }],
  ["x_user_network", { user: "@AnthropicAI", relation: "following", count: 20 }],
  ["x_list", { list_id: "1585430245762441216" }],
  [
    "x_community",
    { community_id: "1502929685792976898", view: "tweets", sort: "likes", time_filter: "week" },
  ],
  ["x_trends", { woeid: 1, count: 10 }],
];
let failures = 0;
let checks = 0;
async function check(name, params, registry = tools, expectedProvider) {
  checks++;
  rawBytes = 0;
  try {
    const result = await registry.get(name).execute("live-check", params);
    const data = result.structuredContent;
    const normalizedBytes = Buffer.byteLength(JSON.stringify(data));
    const modelBytes = Buffer.byteLength(result.content[0].text);
    assert.ok(data && typeof data === "object", name);
    assert.ok(modelBytes < 52_000, `${name} model-facing output is oversized`);
    // Empty fallback pages include diagnostic notices and can exceed the raw empty envelope.
    if (!Array.isArray(data.items) || data.items.length > 0)
      assert.ok(normalizedBytes < rawBytes, `${name} didn't slim the provider response`);
    if (Array.isArray(data.items) && !params.cursor)
      assert.ok(data.items.length > 0, `${name} empty first listing`);
    if (name === "x_get_tweet") {
      assert.equal(data.tweet.id, params.tweet);
      if (params.include !== "none") assert.ok(data.replies.length > 0);
    }
    if (name === "x_get_article") assert.ok(data.markdown.length > 1000);
    if (expectedProvider) {
      assert.equal(data.provider, expectedProvider);
      assert.equal(result.details.provider, expectedProvider);
      if (data.next_cursor) assert.ok(data.next_cursor.startsWith("tweetapi:"));
    }
    if (!result.details.full_output_path)
      assert.deepEqual(JSON.parse(result.content[0].text), data);
    console.log(
      `${name} (${params.type ?? params.include ?? "default"}, ${data.provider ?? "twitter283"}): raw=${rawBytes} normalized=${normalizedBytes} model=${modelBytes} bytes`
    );
    return data;
  } catch (error) {
    failures++;
    // Clients redact provider errors; assertions above never contain payloads or keys.
    console.error(`${name}: ${error.message}`);
    return undefined;
  }
}
for (const [name, params] of cases) await check(name, params);
if (fallback) {
  console.log("TweetAPI live fallback checks (simulated primary outage):");
  const outage = toolsFor({
    ...tracked,
    async get() {
      throw new XApiError("Simulated twitter283 HTTP 503.", true, 503);
    },
  });
  for (const type of ["latest", "top"]) {
    const params = { query: "from:AnthropicAI", type };
    const first = await check("x_search", params, outage, "tweetapi");
    if (type === "latest" && first?.next_cursor)
      await check("x_search", { ...params, cursor: first.next_cursor }, outage, "tweetapi");
  }
} else {
  console.log("TweetAPI live fallback checks skipped: TWEETAPI_KEY not set.");
}
console.log(
  `${checks - failures}/${checks} live checks passed; twitter283 remaining=${client.rateLimit.remaining ?? "unknown"}`
);
if (failures) process.exitCode = 1;
