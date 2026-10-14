export type UserRef = { username: string } | { id: string };

const ID = /^[1-9]\d{0,29}$/;
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const HOSTS = new Set([
  "x.com",
  "www.x.com",
  "mobile.x.com",
  "twitter.com",
  "www.twitter.com",
  "mobile.twitter.com",
  "m.twitter.com",
]);

function path(input: string): string | undefined {
  const value = input.trim();
  if (!value.includes("/") && !value.includes(":")) return undefined;
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    if (!HOSTS.has(url.hostname) || !["https:", "http:"].includes(url.protocol)) {
      throw new Error("unsupported host");
    }
    if (url.username || url.password || url.port) throw new Error("invalid URL");
    return url.pathname;
  } catch {
    throw new Error("Use a valid x.com or twitter.com URL (or a bare ID/handle).");
  }
}

function parseId(input: string, pattern: RegExp, kind: string): string {
  const value = input.trim();
  if (ID.test(value)) return value;
  const id = pattern.exec(path(value) ?? "")?.[1];
  if (id && ID.test(id)) return id;
  throw new Error(`Invalid ${kind}: expected a numeric ID or its X URL.`);
}

export function parseTweetId(input: string): string {
  return parseId(input, /^\/(?:[A-Za-z0-9_]+|i\/web)\/status\/(\d+)(?:\/.*)?$/, "tweet");
}

export function parseListId(input: string): string {
  return parseId(input, /^\/i\/lists\/(\d+)\/?$/, "list");
}

export function parseCommunityId(input: string): string {
  return parseId(input, /^\/i\/communities\/(\d+)(?:\/.*)?$/, "community");
}

export function parseUserRef(input: string): UserRef {
  const value = input.trim();
  if (ID.test(value)) return { id: value };
  const urlPath = path(value);
  const username =
    urlPath === undefined ? value.replace(/^@/, "") : /^\/([^/]+)\/?$/.exec(urlPath)?.[1];
  if (
    username &&
    HANDLE.test(username) &&
    !["home", "explore", "search", "i", "settings", "notifications", "messages"].includes(
      username.toLowerCase()
    )
  ) {
    return { username };
  }
  throw new Error("Invalid user: expected a username, @handle, numeric ID or X profile URL.");
}
