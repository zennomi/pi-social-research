import assert from "node:assert/strict";
import test from "node:test";
import { parseCommunityId, parseListId, parseTweetId, parseUserRef } from "../src/x/parse.js";

void test("IDs remain strings, including snowflakes larger than Number.MAX_SAFE_INTEGER", () => {
  const id = "2100632677904744716";
  assert.equal(parseTweetId(id), id);
  assert.deepEqual(parseUserRef(id), { id });
  assert.equal(parseListId(id), id);
  assert.equal(parseCommunityId(id), id);
});

void test("tweet URLs accept X, Twitter, mobile and i/web paths", () => {
  for (const url of [
    "https://x.com/claudeai/status/123?s=20",
    "https://mobile.twitter.com/test/status/123/video/1",
    "x.com/i/web/status/123",
    "https://www.twitter.com/test/status/123/",
  ])
    assert.equal(parseTweetId(url), "123");
});

void test("user references and list/community URLs", () => {
  assert.deepEqual(parseUserRef(" @AnthropicAI "), { username: "AnthropicAI" });
  assert.deepEqual(parseUserRef("https://x.com/AnthropicAI/?s=20"), { username: "AnthropicAI" });
  assert.deepEqual(parseUserRef("foo_bar"), { username: "foo_bar" });
  assert.equal(parseListId("https://x.com/i/lists/123"), "123");
  assert.equal(parseCommunityId("https://x.com/i/communities/456/about"), "456");
});

void test("reject malformed, lookalike and wrong-kind references", () => {
  for (const input of [
    "",
    "123.5",
    "-1",
    "https://evil.com/a/status/123",
    "https://x.com.evil.com/a/status/123",
    "https://x.com/a/status/no",
    "https://x.com:8080/a/status/123",
    "https://a@x.com/a/status/123",
  ]) {
    assert.throws(() => parseTweetId(input));
  }
  for (const input of [
    "",
    "@long_username_over_15",
    "foo bar",
    "https://x.com/home",
    "https://x.com/foo/status/1",
    "https://evil.com/foo",
  ]) {
    assert.throws(() => parseUserRef(input));
  }
  assert.throws(() => parseListId("https://x.com/i/communities/123"));
});
