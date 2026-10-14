import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  articleToMarkdown,
  capText,
  extractTimeline,
  findObjects,
  normalizeCommunity,
  normalizeListSearch,
  normalizeTrends,
  normalizeTweet,
  normalizeUser,
} from "../src/x/normalize.js";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/x/${name}.json`, import.meta.url), "utf8"));
}

void test("extract real tweet timelines without leaking provider fields", () => {
  for (const name of [
    "search_top",
    "latest",
    "conv",
    "conv2",
    "usertweets",
    "quotes",
    "listtweets",
    "commtl",
  ]) {
    const page = extractTimeline(fixture(name));
    assert.ok(page.tweets.length > 0, name);
    assert.ok(page.next_cursor, name);
    for (const t of page.tweets) {
      assert.match(t.id, /^\d+$/);
      assert.match(t.url, /^https:\/\/x.com\//);
      assert.ok(t.author?.username);
      assert.equal(Array.from(t.text).length <= 4000, true);
      assert.ok(!("legacy" in t));
      assert.ok(!("core" in t));
      assert.ok(!("bio" in (t.author ?? {})));
    }
  }
});

void test("normalize three user dialects and timeline users", () => {
  const modern = normalizeUser(findObjects(fixture("user"), "User")[0]);
  assert.equal(modern?.username, "AnthropicAI");
  assert.ok(modern?.followers);
  assert.ok(modern?.website?.startsWith("http"));
  const old = normalizeUser(findObjects(fixture("conv2"), "User")[0]);
  assert.equal(old?.username, "elonmusk");
  const flat = fixture("followerslight") as { users: unknown[] };
  assert.ok(normalizeUser(flat.users[0])?.username);
  for (const name of ["search_people", "listmembers", "verifiedf"]) {
    assert.ok(extractTimeline(fixture(name)).users.length > 0, name);
  }
  assert.equal(normalizeUser({}), undefined);
});

void test("long tweets replace truncated text and one-level quote nesting is bounded", () => {
  const tweets = extractTimeline(fixture("latest")).tweets;
  assert.ok(tweets.some((t) => t.text.length > 280));
  const raw = {
    rest_id: "1",
    legacy: { full_text: "short", favorite_count: 0 },
    note_tweet: {
      note_tweet_results: {
        result: {
          text: "long https://t.co/link",
          entity_set: { urls: [{ url: "https://t.co/link", expanded_url: "https://example.com" }] },
        },
      },
    },
    quoted_tweet_results: {
      result: {
        rest_id: "2",
        legacy: { full_text: "quoted" },
        quoted_status_result: { result: { rest_id: "3", legacy: { full_text: "deep" } } },
      },
    },
    core: {
      user_results: {
        result: {
          rest_id: "4",
          core: { screen_name: "test", name: "Test" },
          relationship_counts: { followers: 0 },
        },
      },
    },
  };
  const t = normalizeTweet(raw);
  assert.equal(t?.text, "long https://example.com");
  assert.equal(t?.metrics.likes, 0);
  assert.equal(t?.author?.followers, 0);
  assert.equal(t?.quoted?.text, "quoted");
  assert.equal(t?.quoted?.quoted, undefined);
  assert.deepEqual(t?.links, ["https://example.com"]);
});

void test("media uses best mp4 and strips trailing media token, wrapper and retweet support", () => {
  const original = { rest_id: "2", legacy: { full_text: "original" } };
  const t = normalizeTweet({
    __typename: "TweetWithVisibilityResults",
    tweet: {
      rest_id: "1",
      legacy: {
        full_text: "RT text https://t.co/media",
        retweeted_status_result: { result: original },
        extended_entities: {
          media: [
            {
              type: "video",
              url: "https://t.co/media",
              media_url_https: "thumb",
              video_info: {
                duration_millis: 2500,
                variants: [
                  { content_type: "application/x-mpegURL", url: "hls" },
                  { content_type: "video/mp4", bitrate: 10, url: "low" },
                  { content_type: "video/mp4", bitrate: 20, url: "high" },
                ],
              },
            },
          ],
        },
      },
    },
  });
  assert.equal(t?.text, "RT text");
  assert.deepEqual(t?.media, [{ type: "video", url: "high", duration_s: 2.5 }]);
  assert.equal(t?.retweet_of?.id, "2");
});

void test("timeline modules, pinned/dedupe, promoted and suggestion skipping", () => {
  const content = {
    __typename: "TimelineTweet",
    tweet_results: { result: { rest_id: "1", legacy: { full_text: "hello" } } },
  };
  const entry = { entry_id: "tweet-1", content: { __typename: "TimelineTimelineItem", content } };
  const raw = {
    data: {
      instructions: [
        { __typename: "TimelinePinEntry", entry },
        {
          __typename: "TimelineAddEntries",
          entries: [
            entry,
            { entry_id: "promoted-2", content: entry.content },
            { entry_id: "who-to-follow-2", content: { items: [{ item: content }] } },
            {
              entry_id: "thread-1",
              content: { __typename: "TimelineTimelineModule", items: [{ item: { content } }] },
            },
            { entryId: "cursor-1", content: { cursorType: "Bottom", value: "next" } },
          ],
        },
      ],
    },
  };
  const result = extractTimeline(raw);
  assert.equal(result.tweets.length, 1);
  assert.equal(result.tweets[0]?.pinned, true);
  assert.equal(result.next_cursor, "next");
  const onlyAds = extractTimeline({
    instructions: [{ entries: [{ entry_id: "promoted-1", content: entry.content }] }],
  });
  assert.deepEqual(onlyAds.tweets, []);
});

void test("article markdown, community/list/trend shapes and empty results", () => {
  const a = articleToMarkdown(fixture("article"));
  assert.equal(a?.title, "When Tokens Burn");
  assert.match(a?.markdown ?? "", /^# When Tokens Burn/);
  assert.ok(a?.markdown.includes("https://www.decentralised.co/p/when-tokens-burn"));
  assert.ok((a?.markdown.length ?? 0) > 1000);
  assert.ok(a?.author);
  assert.ok(normalizeCommunity(findObjects(fixture("comminfo"), "Community")[0]));
  assert.ok(normalizeListSearch(fixture("listsearch")).length > 0);
  assert.ok(normalizeTrends(fixture("trends")).length > 0);
  assert.deepEqual(extractTimeline(fixture("empty-user")), { tweets: [], users: [] });
  assert.equal(articleToMarkdown(fixture("empty-tweet")), undefined);
  assert.equal(normalizeTweet({ rest_id: "1", __typename: "TweetUnavailable" }), undefined);
});

void test("provider plural retweet fields preserve original attribution and community topics", () => {
  const tweet = extractTimeline(fixture("listtweets")).tweets.find(
    (t) => t.id === "2109923877979922547"
  );
  assert.equal(tweet?.retweet_of?.id, "2109903501861990485");
  assert.ok(tweet?.retweet_of?.author?.username);
  const community = normalizeCommunity(findObjects(fixture("comminfo"), "Community")[0]) as {
    topic: string;
  };
  assert.equal(community.topic, "Cryptocurrency");
  assert.throws(() => extractTimeline({ data: {} }, true), /unrecognized/);
  assert.deepEqual(extractTimeline({ instructions: [] }, true), { tweets: [], users: [] });
});

void test("text truncation is code-point-safe with explicit ellipsis", () => {
  assert.equal(Array.from(capText("😀".repeat(5000))).length, 4000);
  assert.ok(capText("😀".repeat(5000)).endsWith("…"));
});
