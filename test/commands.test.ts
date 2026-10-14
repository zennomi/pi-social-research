import assert from "node:assert/strict";
import test from "node:test";
import { buildHelpText, parseSubcommand } from "../src/commands.js";
import { EXTENSION_COMMAND } from "../src/constants.js";

void test("parseSubcommand handles case, whitespace and remaining text", () => {
  assert.deepEqual(parseSubcommand("STATUS"), { name: "status", rest: "" });
  assert.deepEqual(parseSubcommand(""), { name: "", rest: "" });
  assert.deepEqual(parseSubcommand("   "), { name: "", rest: "" });
  assert.deepEqual(parseSubcommand("Help\t  multi\nline  "), { name: "help", rest: "multi\nline" });
  assert.deepEqual(parseSubcommand("status   a  b"), { name: "status", rest: "a  b" });
});

void test("help documents credentials and current commands, without template leftovers", () => {
  const help = buildHelpText();
  assert.ok(help.includes(`/${EXTENSION_COMMAND} status`));
  assert.ok(help.includes(`/${EXTENSION_COMMAND} help`));
  assert.match(help, /RAPIDAPI_KEY/);
  assert.doesNotMatch(help, /set-label|echo/);
});
