import {
  array,
  articlePreview,
  at,
  boundedTweetText,
  compact,
  iso,
  num,
  object,
  type SlimTweet,
  str,
  tweetMedia,
  tweetMetrics,
  tweetUrl,
} from "./normalize.js";
import { requestDeadline, retryAfterSeconds, waitForRetry } from "./request.js";

export const TWEETAPI_SEARCH_URL = "https://api.tweetapi.com/tw-v2/search";
export const TWEETAPI_SETUP_HINT = "Set TWEETAPI_KEY to enable the TweetAPI search fallback.";
export const TWEETAPI_SEARCH_ENDPOINT = `TweetAPI ${new URL(TWEETAPI_SEARCH_URL).pathname}`;

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
      if (!apiKey) throw new TweetApiError(TWEETAPI_SETUP_HINT);
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
      const { combined } = requestDeadline(signal, options.timeoutMs);
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
        const retry = retryAfterSeconds(response);
        if (response.status === 503 && attempt === 0 && retry !== undefined && retry <= 5) {
          await response.body?.cancel();
          await waitForRetry(retry * 1000, combined);
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
  const metrics = tweetMetrics({
    likes: r.likeCount,
    retweets: r.retweetCount,
    replies: r.replyCount,
    quotes: r.quoteCount,
    bookmarks: r.bookmarkCount,
    views: r.viewCount,
  });
  const media = array(r.media).flatMap((value) => {
    const m = object(value);
    const mp4 = array(at(m, "videoInfo", "variants"))
      .map(object)
      .filter((v) => (v.content_type ?? v.contentType) === "video/mp4");
    return tweetMedia(m.type, m.url, mp4, num(m.duration));
  });
  const reply = compact({
    tweet_id: str(at(r, "replyTo", "tweetId")),
    username: str(at(r, "replyTo", "username")),
  });
  const article = object(r.article);
  return compact({
    id,
    url: tweetUrl(id, username),
    text: boundedTweetText(r.text, depth),
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
    article: articlePreview(article.id, article.title, article.previewText),
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
