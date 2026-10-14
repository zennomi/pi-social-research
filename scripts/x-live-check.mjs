// Explicit, opt-in quota-consuming check. Never print credentials or provider payloads.
import assert from "node:assert/strict";
import { createXClient } from "../src/x/client.ts";
import { registerXTools } from "../src/x/tools.ts";

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
const tools = new Map();
registerXTools(
  {
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
  },
  () => tracked
);
const cases = [
  ["x_search", { query: '"Claude Code" min_faves:100', type: "latest", count: 10 }],
  ["x_get_tweet", { tweet: "1768778186186195177" }],
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
for (const [name, params] of cases) {
  rawBytes = 0;
  const result = await tools.get(name).execute("live-check", params);
  const data = result.structuredContent;
  const normalizedBytes = Buffer.byteLength(JSON.stringify(data));
  const modelBytes = Buffer.byteLength(result.content[0].text);
  assert.ok(data && typeof data === "object", name);
  assert.ok(modelBytes < 52_000, `${name} model-facing output is oversized`);
  assert.ok(normalizedBytes < rawBytes, `${name} didn't slim the provider response`);
  if (Array.isArray(data.items)) assert.ok(data.items.length > 0, `${name} empty listing`);
  if (name === "x_get_tweet") {
    assert.equal(data.tweet.id, params.tweet);
    assert.ok(data.replies.length > 0);
  }
  if (name === "x_get_article") assert.ok(data.markdown.length > 1000);
  if (!result.details.full_output_path) assert.deepEqual(JSON.parse(result.content[0].text), data);
  console.log(
    `${name}: raw=${rawBytes} normalized=${normalizedBytes} model=${modelBytes} bytes${result.details.full_output_path ? " (truncated; full normalized data saved)" : ""}`
  );
}
console.log(
  `✓ ${cases.length} X tools verified; rate-limit remaining=${client.rateLimit.remaining ?? "unknown"}`
);
