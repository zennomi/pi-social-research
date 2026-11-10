import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { EXTENSION_COMMAND, X_TOOL_NAMES } from "../src/constants.js";
import socialResearch, { SKILLS_DIR } from "../src/index.js";

type Handler = (event: unknown, ctx: unknown) => unknown;
interface Command {
  handler: (args: string, ctx: unknown) => Promise<void>;
}

function createHarness() {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, Command>();
  const tools = new Set<string>();
  const definitions = new Map<
    string,
    { execute(id: string, params: unknown): Promise<{ structuredContent: { provider?: string } }> }
  >();
  const pi = {
    on: (name: string, handler: Handler) => {
      handlers.set(name, handler);
    },
    registerCommand: (name: string, command: Command) => {
      commands.set(name, command);
    },
    registerTool: (tool: { name: string }) => {
      tools.add(tool.name);
      definitions.set(
        tool.name,
        tool as unknown as NonNullable<ReturnType<typeof definitions.get>>
      );
    },
  } as unknown as ExtensionAPI;
  socialResearch(pi);
  return { handlers, commands, tools, definitions };
}

function createContext(hasUI = true) {
  const notifications: string[] = [];
  const statuses = new Map<string, string | undefined>();
  return {
    hasUI,
    notifications,
    statuses,
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
      setStatus(key: string, value: string | undefined) {
        statuses.set(key, value);
      },
    },
  };
}

void test("extension registers 9 X tools, no echo/label state, and help/status command", () => {
  const h = createHarness();
  assert.deepEqual([...h.tools], X_TOOL_NAMES);
  assert.ok(h.commands.has(EXTENSION_COMMAND));
  assert.equal(h.handlers.has("session_start"), false);
  assert.equal(h.handlers.has("session_tree"), false);
});

void test("loads with no credential; status never prints the key", async (t) => {
  const previous = process.env.RAPIDAPI_KEY;
  const previousFallback = process.env.TWEETAPI_KEY;
  process.env.RAPIDAPI_KEY = "";
  process.env.TWEETAPI_KEY = "";
  t.after(() => {
    if (previous === undefined) delete process.env.RAPIDAPI_KEY;
    else process.env.RAPIDAPI_KEY = previous;
    if (previousFallback === undefined) delete process.env.TWEETAPI_KEY;
    else process.env.TWEETAPI_KEY = previousFallback;
  });
  const h = createHarness();
  const ctx = createContext();
  await h.commands.get(EXTENSION_COMMAND)?.handler("status", ctx);
  assert.match(ctx.notifications.at(-1) ?? "", /RAPIDAPI_KEY: missing/);
  assert.match(ctx.notifications.at(-1) ?? "", /TWEETAPI_KEY: missing/);
  process.env.RAPIDAPI_KEY = "do-not-leak";
  process.env.TWEETAPI_KEY = "do-not-leak-fallback";
  await h.commands.get(EXTENSION_COMMAND)?.handler("status", ctx);
  assert.match(ctx.notifications.at(-1) ?? "", /RAPIDAPI_KEY: set/);
  assert.match(ctx.notifications.at(-1) ?? "", /TWEETAPI_KEY: set/);
  assert.ok(!ctx.notifications.join("\n").includes("do-not-leak"));
});

void test("fallback key is lazy, rotates, and can be removed without reload", async (t) => {
  for (const name of ["RAPIDAPI_KEY", "TWEETAPI_KEY"]) {
    const previous = process.env[name];
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
  process.env.RAPIDAPI_KEY = "primary";
  delete process.env.TWEETAPI_KEY;
  const keys: string[] = [];
  const fetcher = t.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    if (String(input).includes("rapidapi.com")) return new Response("", { status: 401 });
    keys.push(new Headers(init?.headers).get("X-API-Key") ?? "");
    return Response.json({ data: [], pagination: { nextCursor: null, prevCursor: null } });
  });
  const h = createHarness();
  assert.equal(fetcher.mock.callCount(), 0);
  const search = h.definitions.get("x_search");
  assert.ok(search);
  await assert.rejects(search.execute("c", { query: "ai" }), /Set TWEETAPI_KEY/);
  for (const key of ["first", "second"]) {
    process.env.TWEETAPI_KEY = key;
    const result = await search.execute("c", { query: "ai" });
    assert.equal(result.structuredContent.provider, "tweetapi");
  }
  delete process.env.TWEETAPI_KEY;
  await assert.rejects(
    search.execute("c", { query: "ai", cursor: "tweetapi:next" }),
    /Set TWEETAPI_KEY/
  );
  assert.deepEqual(keys, ["first", "second"]);
});

void test("commands without a UI use stderr, never stdout", async (t) => {
  const log = t.mock.method(console, "log", () => undefined);
  const err = t.mock.method(console, "error", () => undefined);
  const h = createHarness();
  const ctx = createContext(false);
  await h.commands.get(EXTENSION_COMMAND)?.handler("help", ctx);
  assert.equal(log.mock.callCount(), 0);
  assert.equal(err.mock.callCount(), 1);
  assert.deepEqual(ctx.notifications, []);
});

void test("resources_discover keeps the bundled Reddit skill", async () => {
  const h = createHarness();
  assert.deepEqual(await h.handlers.get("resources_discover")?.({}, {}), {
    skillPaths: [SKILLS_DIR],
  });
  const skill = join(SKILLS_DIR, "reddit-unofficial-api", "SKILL.md");
  assert.ok(existsSync(skill));
  assert.match(readFileSync(skill, "utf8"), /^---\nname: reddit-unofficial-api\n/);
  assert.ok(existsSync(join(SKILLS_DIR, "reddit-unofficial-api", "scripts", "reddit-helper.js")));
});
