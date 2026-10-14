import { findObjects, normalizeUser, object } from "./normalize.js";
import { parseUserRef } from "./parse.js";

export const X_API_HOST = "twitter283.p.rapidapi.com";
export type Query = Record<string, string | number | boolean | undefined>;
export interface RateLimit {
  remaining?: number | undefined;
  reset_seconds?: number | undefined;
}
export interface XClient {
  readonly rateLimit: RateLimit;
  get(endpoint: string, query: Query, signal?: AbortSignal): Promise<unknown>;
  resolveUserId(user: string, signal?: AbortSignal): Promise<string>;
}

export function createXClient(options: {
  apiKey: string | undefined;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): XClient {
  const apiKey = options.apiKey?.trim();
  const fetcher = options.fetch ?? globalThis.fetch;
  const rateLimit: RateLimit = {};
  const usernames = new Map<string, string>();

  async function get(endpoint: string, query: Query, signal?: AbortSignal): Promise<unknown> {
    if (!apiKey) throw new Error("Set RAPIDAPI_KEY in the environment before using X tools.");
    if (!/^\/[A-Za-z0-9]+$/.test(endpoint)) throw new Error("Invalid X API endpoint.");
    const url = new URL(endpoint, `https://${X_API_HOST}`);
    for (const [name, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") url.searchParams.set(name, String(value));
    }
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    combined.throwIfAborted();
    let response: Response;
    try {
      response = await fetcher(url, {
        // Never forward a custom credential header to an unexpected redirect target.
        redirect: "error",
        headers: { "x-rapidapi-host": X_API_HOST, "x-rapidapi-key": apiKey },
        signal: combined,
      });
    } catch {
      if (combined.aborted) throw combined.reason;
      throw new Error(`X API network error for ${endpoint}. Check connectivity and try again.`);
    }
    for (const [header, key] of [
      ["remaining", "remaining"],
      ["reset", "reset_seconds"],
    ] as const) {
      const value = response.headers.get(`x-ratelimit-requests-${header}`);
      if (value !== null && Number.isFinite(Number(value))) rateLimit[key] = Number(value);
    }
    if (!response.ok) {
      // Never echo provider error bodies: they may contain credentials or huge HTML pages.
      if (response.status === 401 || response.status === 403) {
        throw new Error(
          "X API access denied (401/403). Check RAPIDAPI_KEY and your twitter283 subscription."
        );
      }
      if (response.status === 429) {
        const retry = response.headers.get("retry-after") ?? rateLimit.reset_seconds;
        throw new Error(
          `X API rate limited (429).${retry === undefined ? "" : ` Retry after ${retry} seconds.`}`
        );
      }
      throw new Error(`X API HTTP ${response.status} for ${endpoint}.`);
    }
    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      if (combined.aborted) throw combined.reason;
      throw new Error(`X API returned invalid JSON for ${endpoint}.`);
    }
    combined.throwIfAborted();
    const r = object(raw);
    if (Array.isArray(r.errors) && r.errors.length > 0) {
      // Some GraphQL endpoints return failures at HTTP 200. Don't turn them into empty search results.
      throw new Error(
        `X API reported an upstream error for ${endpoint}. The data may be unavailable.`
      );
    }
    if (r.error || (r.message && !r.data))
      throw new Error(`X API reported an error for ${endpoint}.`);
    return raw;
  }

  async function resolveUserId(user: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const ref = parseUserRef(user);
    if ("id" in ref) return ref.id;
    const key = ref.username.toLowerCase();
    const cached = usernames.get(key);
    if (cached) return cached;
    const raw = await get("/UserResultByScreenName", { username: ref.username }, signal);
    const profile = findObjects(raw, "User").map(normalizeUser).find(Boolean);
    if (!profile) throw new Error(`X user @${ref.username} not found or unavailable.`);
    if (usernames.size >= 100) {
      const oldest = usernames.keys().next().value;
      if (oldest) usernames.delete(oldest);
    }
    usernames.set(key, profile.id);
    return profile.id;
  }

  return { get, resolveUserId, rateLimit };
}
