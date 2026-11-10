import { setTimeout as delay } from "node:timers/promises";
import { array, at, capText, compact, iso, num, object, type SlimTweet, str } from "./normalize.js";

export const TWEETAPI_SEARCH_URL = "https://api.tweetapi.com/tw-v2/search";
export interface TweetApiPage {
  items: SlimTweet[];
  next_cursor?: string | undefined;
}
export interface TweetApiClient {
  search(
    query: string,
    type: "Top" | "Latest",
    cursor?: string,
    signal?: AbortSignal
  ): Promise<TweetApiPage>;
}

export class TweetApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TweetApiError";
  }
}

const ERROR_HINTS: Record<string, string> = {
  RATE_LIMITED: "Wait before retrying.",
  QUOTA_EXHAUSTED: "Top up your TweetAPI allowance; retrying will not help.",
  SUBSCRIPTION_INACTIVE: "Activate your TweetAPI subscription; retrying will not help.",
  PROXY_ERROR: "Retry later.",
  PROXY_TIMEOUT: "Retry later.",
  ACCOUNT_LOCKED: "Contact the provider.",
  ACCOUNT_SUSPENDED: "Contact the provider.",
};

export function createTweetApiClient(options: {
  apiKey: string | undefined;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): TweetApiClient {
  const apiKey = options.apiKey?.trim();
  const fetcher = options.fetch ?? globalThis.fetch;
  return {
    async search(query, type, cursor, signal) {
      signal?.throwIfAborted();
      if (!apiKey)
        throw new TweetApiError("Set TWEETAPI_KEY to enable the TweetAPI search fallback.");
      if (!query.trim() || Array.from(query).length > 512)
        throw new TweetApiError(
          "TweetAPI search query must be 1–512 characters; shorten the query."
        );
      if (type !== "Top" && type !== "Latest")
        throw new TweetApiError("TweetAPI fallback supports only top/latest.");
      const url = new URL(TWEETAPI_SEARCH_URL);
      url.searchParams.set("query", query);
      url.searchParams.set("type", type);
      if (cursor) url.searchParams.set("cursor", cursor);
      const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      for (let attempt = 0; ; attempt++) {
        combined.throwIfAborted();
        let response: Response;
        try {
          response = await fetcher(url, {
            redirect: "error",
            headers: { "X-API-Key": apiKey },
            signal: combined,
          });
        } catch {
          if (combined.aborted) throw combined.reason;
          throw new TweetApiError(
            "TweetAPI search network error. Check connectivity and retry later."
          );
        }
        const retryHeader = response.headers.get("retry-after");
        const retry =
          retryHeader !== null && /^\d+$/.test(retryHeader) ? Number(retryHeader) : undefined;
        if (response.status === 503 && attempt === 0 && retry !== undefined && retry <= 5) {
          await response.body?.cancel();
          try {
            await delay(retry * 1000, undefined, { signal: combined });
          } catch {
            throw combined.reason;
          }
          continue;
        }
        let raw: unknown;
        try {
          raw = await response.json();
        } catch {
          if (combined.aborted) throw combined.reason;
          if (response.ok) throw new TweetApiError("TweetAPI returned invalid JSON. Retry later.");
        }
        combined.throwIfAborted();
        if (!response.ok) {
          // Only documented, allowlisted codes can escape an untrusted error body.
          const code = str(at(raw, "code"));
          const safeCode =
            code && /^[A-Z_]{1,40}$/.test(code) && Object.hasOwn(ERROR_HINTS, code)
              ? code
              : undefined;
          const hint = safeCode
            ? ERROR_HINTS[safeCode]
            : response.status === 401 || response.status === 403
              ? "Check TWEETAPI_KEY and your TweetAPI account."
              : response.status >= 500
                ? "Provider-side failure; retry later."
                : "Check your request and account limits.";
          throw new TweetApiError(
            `TweetAPI search HTTP ${response.status}${safeCode ? ` (${safeCode})` : ""}. ${hint}${retry === undefined ? "" : ` Retry after ${retry} seconds.`}`
          );
        }
        return normalizeTweetApiPage(raw, type);
      }
    },
  };
}

/** Map TweetAPI's camelCase response into the same bounded public shape as twitter283. */
export function normalizeTweetApiTweet(raw: unknown, depth = 0): SlimTweet | undefined {
  const r = object(raw);
  if (r.isPromoted || r.promotedMetadata) return undefined;
  const id = str(r.id);
  if (!id || typeof r.text !== "string") return undefined;
  const user = object(r.author);
  const username = str(user.username);
  const userId = str(user.id);
  const metrics: Record<string, number> = {};
  for (const [name, key] of Object.entries({
    likes: "likeCount",
    retweets: "retweetCount",
    replies: "replyCount",
    quotes: "quoteCount",
    bookmarks: "bookmarkCount",
    views: "viewCount",
  })) {
    const value = num(r[key]);
    if (value !== undefined) metrics[name] = value;
  }
  const media = array(r.media).flatMap((value) => {
    const m = object(value);
    const mp4 = array(at(m, "videoInfo", "variants"))
      .map(object)
      .filter((v) => (v.content_type ?? v.contentType) === "video/mp4")
      .sort((a, b) => (num(b.bitrate) ?? 0) - (num(a.bitrate) ?? 0))[0];
    const url = str(mp4?.url ?? m.url);
    return url
      ? [
          compact({
            type: m.type === "animated_gif" ? "gif" : (str(m.type) ?? "photo"),
            url,
            duration_s: num(m.duration),
          }),
        ]
      : [];
  });
  const reply = compact({
    tweet_id: str(at(r, "replyTo", "tweetId")),
    username: str(at(r, "replyTo", "username")),
  });
  const article = object(r.article);
  return compact({
    id,
    url: `https://x.com/${username ?? "i/web"}/status/${id}`,
    text: capText(r.text, depth > 0 ? 1500 : 4000),
    created_at: iso(r.createdAt),
    author:
      userId && username
        ? compact({
            id: userId,
            username,
            name: str(user.name) ?? username,
            verified: Boolean(user.isBlueVerified || user.verified) || undefined,
            followers: num(user.followerCount),
          })
        : undefined,
    lang: str(r.lang),
    metrics,
    conversation_id: str(r.conversationId),
    reply_to: Object.keys(reply).length ? reply : undefined,
    media,
    links: [
      ...new Set(
        array(r.urls)
          .map(str)
          .filter((v): v is string => Boolean(v))
      ),
    ],
    article: article.title
      ? compact({
          id: str(article.id),
          title: str(article.title),
          preview: capText(str(article.previewText) ?? "", 1000),
        })
      : undefined,
    quoted: depth === 0 ? normalizeTweetApiTweet(r.quotedTweet, depth + 1) : undefined,
    retweet_of: depth === 0 ? normalizeTweetApiTweet(r.retweetedTweet, depth + 1) : undefined,
  });
}

export function normalizeTweetApiPage(raw: unknown, type: "Top" | "Latest"): TweetApiPage {
  const data = at(raw, "data");
  const next = at(raw, "pagination", "nextCursor");
  if (!Array.isArray(data) || (next !== null && typeof next !== "string"))
    throw new TweetApiError(
      "TweetAPI search returned an unrecognized response schema; no empty result can be inferred."
    );
  const items = new Map<string, SlimTweet>();
  for (const value of data) {
    const entry = object(value);
    if (entry.isPromoted || entry.promotedMetadata) continue;
    const candidate = type === "Top" && "content" in entry ? object(entry.content) : entry;
    if (candidate.isPromoted || candidate.promotedMetadata) continue;
    // Top is a mixed feed; user recommendations are not posts.
    if (
      type === "Top" &&
      str(candidate.id) &&
      str(candidate.username) &&
      candidate.text === undefined
    )
      continue;
    const tweet = normalizeTweetApiTweet(candidate);
    if (!tweet)
      throw new TweetApiError(
        "TweetAPI search returned an unrecognized post schema; no empty result can be inferred."
      );
    items.set(tweet.id, tweet);
  }
  return { items: [...items.values()], ...compact({ next_cursor: str(next) }) };
}
