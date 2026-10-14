import { EXTENSION_COMMAND } from "./constants.js";

export function buildHelpText(): string {
  return [
    `/${EXTENSION_COMMAND} status`,
    `/${EXTENSION_COMMAND} help`,
    "Set RAPIDAPI_KEY in your environment to enable X research tools (twitter283 subscription required).",
    "Use x_search to discover posts, people, lists or communities; x_get_tweet to read discussions.",
    "The bundled reddit-unofficial-api skill uses the browser separately, without an API key.",
  ].join("\n");
}

/** Split `<name> <rest>` on the first run of any whitespace (tabs and pasted newlines too). */
export function parseSubcommand(raw: string): { name: string; rest: string } {
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(raw.trim());
  if (!match) return { name: "", rest: "" };
  return {
    name: (match[1] ?? "").toLowerCase(),
    rest: (match[2] ?? "").trim(),
  };
}
