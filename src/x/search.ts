import { type Static, Type } from "typebox";
import { type Query, XApiError } from "./client.js";
import {
  at,
  capText,
  compact,
  extractTimeline,
  normalizeCommunity,
  normalizeListSearch,
  requireArray,
} from "./normalize.js";
import { cursor, reference, XToolError } from "./tool-input.js";
import { TWEETAPI_SETUP_HINT, type TweetApiClient, TweetApiError } from "./tweetapi.js";

export const searchParameters = Type.Object({
  query: reference(
    "X search query (supports operators for posts), or keywords for people/lists/communities."
  ),
  // Pass options to the constructor: spreading a schema drops TypeBox's hidden metadata
  // and makes Type.Optional emit an enumerable ~optional that Gemini rejects.
  type: Type.Optional(
    Type.Enum(["top", "latest", "people", "photos", "videos", "lists", "communities"], {
      description:
        "top (default) / latest = posts ranked / newest; people; photos; videos; lists; communities. There is no posts type.",
    })
  ),
  count: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 50,
      description:
        "Requested Search page size, default 20. Lists/communities and TweetAPI fallback use the provider's page size (count ignored).",
    })
  ),
  cursor,
});

type SearchParams = Static<typeof searchParameters> & { cursor?: string };
type Get = (endpoint: string, query: Query) => Promise<unknown>;
type FallbackType = "top" | "latest";
const FALLBACK_CURSOR_PREFIX = "tweetapi:";
const SEARCH_COOLDOWN_MS = 30_000;
const EMPTY_SEARCH_NOTICE =
  "No results on this first page. This may be a real empty result, limited visibility of sensitive accounts or old posts, or provider degradation; it does not prove no posts exist. Broaden the query or use x_user_tweets for a known account.";

// Queries, cursors and arbitrary extra parameters may contain secrets. Do not echo them.
function searchError(
  type: NonNullable<SearchParams["type"]>,
  code: string,
  field: string,
  message: string
) {
  return new XToolError({
    code,
    field,
    message,
    suggestedAction:
      "To explicitly restart page one, replace the next_call query placeholder with your original non-sensitive query and use cursor:null. This is a new search, not continuation of the failed page.",
    next_call: { tool: "x_search", arguments: { query: "<original query>", type, cursor: null } },
  });
}

export function createSearch(getFallback?: () => TweetApiClient | undefined) {
  // At most two deadlines per tool instance; no query/result/error cache or background timer.
  const retryAt = new Map<FallbackType, number>();

  async function fallbackSearch(
    query: string,
    type: FallbackType,
    signal: AbortSignal | undefined,
    cause: { cursor: string } | { failure: XApiError }
  ) {
    signal?.throwIfAborted();
    const client = getFallback?.();
    const failure = "failure" in cause ? cause.failure : undefined;
    if (!client) {
      if (failure)
        throw new XApiError(
          `${failure.message} ${TWEETAPI_SETUP_HINT}`,
          failure.retryable,
          failure.status
        );
      throw new Error(TWEETAPI_SETUP_HINT);
    }
    const primaryMessage = failure ? capText(failure.message, 240) : undefined;
    try {
      const page = await client.search(
        query,
        type === "top" ? "Top" : "Latest",
        "cursor" in cause ? cause.cursor : undefined,
        signal
      );
      signal?.throwIfAborted();
      return {
        items: page.items,
        ...compact({
          next_cursor: page.next_cursor
            ? `${FALLBACK_CURSOR_PREFIX}${page.next_cursor}`
            : undefined,
        }),
        provider: "tweetapi",
        notice: `${failure ? `twitter283 search failed (${primaryMessage}); results from TweetAPI fallback.` : "Continuing TweetAPI fallback search."} count is ignored (provider page ≈20).`,
      };
    } catch (error) {
      signal?.throwIfAborted();
      if (!failure) throw error;
      const reason =
        error instanceof TweetApiError ? error.message : "TweetAPI request failed or timed out.";
      throw new Error(`twitter283: ${primaryMessage} TweetAPI: ${reason}`);
    }
  }

  async function getPage(p: SearchParams, get: Get, signal?: AbortSignal) {
    const query = p.query.trim();
    const type = p.type ?? "top";
    const fallbackType = type === "top" || type === "latest" ? type : undefined;
    if (!query)
      throw searchError(type, "INVALID_QUERY", "query", "Search query must not be blank.");
    if (p.cursor?.startsWith(FALLBACK_CURSOR_PREFIX)) {
      const token = p.cursor.slice(FALLBACK_CURSOR_PREFIX.length);
      if (!fallbackType || !token.trim())
        throw searchError(
          type,
          "INVALID_CURSOR",
          "cursor",
          "TweetAPI cursors require the same top/latest search and a non-empty cursor."
        );
      return fallbackSearch(query, fallbackType, signal, { cursor: token });
    }
    if (type === "lists") {
      const raw = await get("/ListSearch", { q: query, cursor: p.cursor });
      requireArray(at(raw, "lists"), "list search");
      return { items: normalizeListSearch(raw) };
    }
    if (type === "communities") {
      const raw = await get("/CommunitiesSearchSlice", { q: query, cursor: p.cursor });
      const slice = at(raw, "data", "communities_search_slice");
      return {
        items: requireArray(at(slice, "items_results"), "community search")
          .map(normalizeCommunity)
          .filter(Boolean),
        ...compact({ next_cursor: at(slice, "slice_info", "next_cursor") }),
      };
    }
    if (fallbackType && !p.cursor) {
      const deadline = retryAt.get(fallbackType) ?? 0;
      if (deadline > Date.now()) {
        const failure = new XApiError(
          `twitter283 search is cooling down after an upstream failure; retry primary in ${Math.ceil((deadline - Date.now()) / 1000)} seconds.`,
          true
        );
        return fallbackSearch(query, fallbackType, signal, { failure });
      }
      retryAt.delete(fallbackType);
    }
    let raw: unknown;
    try {
      raw = await get("/Search", {
        q: query,
        type: type[0]?.toUpperCase() + type.slice(1),
        count: p.count ?? 20,
        cursor: p.cursor,
      });
      signal?.throwIfAborted();
      if (fallbackType) retryAt.delete(fallbackType);
    } catch (error) {
      signal?.throwIfAborted();
      if (
        !(error instanceof XApiError) ||
        !fallbackType ||
        (!error.retryable && error.status !== 401 && error.status !== 403 && error.status !== 429)
      )
        throw error;
      if (error.retryable || error.status === 429)
        retryAt.set(fallbackType, Date.now() + SEARCH_COOLDOWN_MS);
      // A primary-provider cursor has no meaning to TweetAPI. Never silently restart page 1.
      if (p.cursor)
        throw searchError(
          type,
          "CURSOR_PROVIDER_MISMATCH",
          "cursor",
          "twitter283 search failed. Cannot switch providers with a twitter283 cursor."
        );
      return fallbackSearch(query, fallbackType, signal, { failure: error });
    }
    const page = extractTimeline(raw, true);
    return {
      items: type === "people" ? page.users : page.tweets,
      ...compact({ next_cursor: page.next_cursor }),
    };
  }

  return async (params: SearchParams, get: Get, signal?: AbortSignal) => {
    const page = await getPage(params, get, signal);
    if (params.cursor || page.items.length) return page;
    return { ...page, notice: [at(page, "notice"), EMPTY_SEARCH_NOTICE].filter(Boolean).join(" ") };
  };
}
