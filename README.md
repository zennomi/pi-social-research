# pi-social-research

Read-only social research for [Pi](https://pi.dev): native X (Twitter) tools via
[RapidAPI Twitter](https://rapidapi.com/sociallab-sociallab-default/api/twitter283),
with an optional [TweetAPI](https://tweetapi.com/docs/explore/search) search fallback,
plus a bundled Reddit browser skill. Requires pi ≥ 1.0 and Node ≥ 22.19.

## Setup

```bash
pi install npm:@zennomi/pi-social-research
# Or, from a local checkout:
pi install ./
```

Subscribe to `twitter283` on RapidAPI, then set your key **before starting pi**:

```bash
export RAPIDAPI_KEY='your-key'
export TWEETAPI_KEY='your-tweetapi-key' # optional, top/latest search fallback only
pi
# Local development:
pi -e ./src/index.ts
```

The key is sent only in the `x-rapidapi-key` header to
`twitter283.p.rapidapi.com`. It is not stored in the repository or session, and
status output only says whether it is set. Missing keys do not prevent the
extension or Reddit skill from loading; X requests fail with setup instructions.
Don't put credentials in prompts, commits, or screenshots. Rotate any key exposed
in chat or logs. An MCP server, browser login, and additional HTTP libraries are
**not** required for the X tools.

Commands:

- `/social-research help`: usage and setup.
- `/social-research status`: presence of both keys and last observed twitter283
  rate-limit remaining (unknown until the first API response).

`TWEETAPI_KEY` is sent only as `X-API-Key` to `api.tweetapi.com`, never in URLs
or status output. Both clients refuse redirects. Set keys in the environment
before starting/restarting pi; no `.env` file is loaded automatically.

## X tools

| Tool | Purpose / main arguments |
|---|---|
| `x_search` | `query`, `type`: `top` (default), `latest`, `people`, `photos`, `videos`, `lists`, `communities`; `count` (1–50, default 20), `cursor?` |
| `x_get_tweet` | `tweet` ID/URL, `include`: `replies` (default), `quotes`, `none`; `cursor?` |
| `x_get_article` | Full X article as markdown from its containing `tweet` ID/URL |
| `x_get_user` | `users`: 1–20 usernames, `@handles`, profile URLs, or numeric IDs |
| `x_user_tweets` | `user`, `include_replies?` (default false), `cursor?` |
| `x_user_network` | `user`, `relation`: `followers`, `following`, `verified_followers`; `count?` (1–200, default 20), `cursor?` |
| `x_list` | `list_id` or list URL, `view`: `tweets` (default) or `members`; `cursor?` |
| `x_community` | `community_id` or URL, `view`: `about` (default), `tweets`, `members`; `sort?`: `relevance`, `recency`, `likes`; `time_filter?`: `day`, `week`, `month`, `year`; `cursor?` |
| `x_trends` | `woeid?` (default 1 = worldwide), `count?` (1–50) |

`count` is a requested provider page size, not a guaranteed number of results.
Lists/communities search and verified followers use the provider's page size.
`time_filter` requires community `view=tweets` and `sort=likes`.

### Research workflow

1. Discover posts using `x_search`. Use `latest` for news, `top` for high-signal
   posts, `people` for accounts, or `lists`/`communities` for curated sources.
2. Open a post with `x_get_tweet`; switch to `include=quotes` to read commentary
   or `none` to fetch only the post.
3. Check an author's bio/follower counts with `x_get_user`, then browse their
   timeline or social graph if relevant. Verification is **not** evidence that
   claims are true.
4. Fetch article bodies using `x_get_article` when a post contains an article
   preview. Pass **the containing tweet's `id`/status URL**, not `article.id` or
   an `x.com/i/article/<id>` URL. Follow links and cross-check claims, citing the
   returned post URLs. `x_search.type` is `top` or `latest` for posts, never `posts`.

Example X post queries:

```text
"Claude Code" since:2026-10-01 min_faves:100 -filter:replies
from:AnthropicAI filter:links
(openai OR anthropic) lang:en since:2026-10-01 until:2026-10-08
```

Other useful operators: `to:`, `min_retweets:`, and `"exact phrases"`.
Operators apply to **post search**; lists/communities accept keywords instead.

### Normalized data and pagination

Tools return compact JSON to the model and the same normalized object as
`structuredContent` for codemode. No raw GraphQL `legacy`, tracking, permissions,
edit controls, profile color palettes, or client-event metadata are exposed.

- Posts retain ID, canonical URL, ISO timestamp, author summary, text, language,
  engagement metrics, reply IDs, media/link URLs and article previews (with their
  separate `article.id`, when available). Visibility-wrapped posts work with
  standalone (`include=none`) and quotes lookups as well as conversations.
- Full note-tweet text takes priority over the short legacy text. Text is capped
  at 4000 Unicode code points; quoted/retweeted text at 1500, marked with `…`.
- t.co links are expanded where available; trailing media-only tokens are
  stripped. Media retains a photo URL or highest-bitrate MP4, not every variant.
  Nested quoted/retweeted posts are limited to one level.
- Profiles retain biography, location, website, follower/following counts,
  verification and affiliation when available. Unknown, null, empty and false
  optional fields are omitted; known zero counts are preserved.
- Article markdown retains text/headings/lists. Embedded article images are not
  downloaded.
- Pages use `{ items, next_cursor? }`. Conversations use
  `{ tweet, ancestors?, replies, next_cursor? }` or `{ tweet, quotes, next_cursor? }`.
  Profiles return `{ items, not_found? }` for partially missing batches.

Omit `cursor`, pass `null`, or use an empty/whitespace-only string for the first
page. Nonempty cursors are opaque and preserved exactly, including surrounding
whitespace: pass `next_cursor` into the **same tool operation, query, filters and
provider** to continue. Never invent sentinels such as `-1`, `/` or `.remove`.
`x_get_tweet(include=none)` and `x_community(view=about)` accept only an empty
cursor. Cursor conflicts return `isError: true` with structured `code`, `field`,
`suggestedAction` and a `next_call` using `cursor: null`. Search recovery uses an
explicit query placeholder: supply your original non-sensitive query locally,
not the placeholder. Recovery does not echo arbitrary arguments or URL secrets.

Tools never auto-paginate or promise exhaustive coverage. Provider order is
preserved; repeated posts are deduplicated, promoted entries and "who to follow"
modules are excluded. An unavailable focal tweet/user/article/community raises
an error rather than pretending it is an empty result. Missing fields stay
unknown, rather than being fabricated as zero.

Model-facing text is guarded at 50 KB / 2000 lines. If truncated, it includes a
path to the complete **normalized** JSON in the system temp directory. Codemode
receives the complete normalized object. Temporary files may contain public
post data; remove them when no longer needed.

### Search fallback and empty pages

With `TWEETAPI_KEY` configured, only `top/latest` first-page search falls back
from twitter283 to TweetAPI after network, 5xx, invalid JSON/upstream errors
(still failing after one retry), a provider deadline, or 401/403/429. No fallback
occurs on empty results, invalid inputs, caller cancellation, or other search
types. Other X tools remain on twitter283 and still need `RAPIDAPI_KEY`.

Transient primary failures and 429 start a 30-second cooldown per top/latest
operation within this tool instance. First-page calls reuse the configured
fallback during that interval; without one they remain errors. The next
first-page call after expiry probes twitter283 again. Cursors stay with their
provider even during cooldown. No failed or empty results are cached, and
caller aborts do not mark the provider unhealthy.

Fallback results carry `provider: "tweetapi"` and a `notice`. TweetAPI accepts
queries of 1–512 characters and uses its own page size (~20); `count` is ignored,
not used to discard fetched posts. Each page costs one TweetAPI unit.
Its `next_cursor` has an opaque `tweetapi:` prefix: pass the **whole string**
back with the same query and type. Continuation goes directly to TweetAPI.
A twitter283 cursor is never sent to TweetAPI; if that page fails, restart the
search without a cursor (results may overlap). A first page with zero items
keeps its cursor and adds a notice about incomplete coverage/degradation;
zero results do not prove no matching posts exist.

When both providers fail, the error names both failures. Missing TweetAPI
credentials produce a setup hint. TweetAPI quota/subscription errors require
account action, not repeated requests. Without a fallback, use known post URLs
with `x_get_tweet`, account timelines with `x_user_tweets`, or web search.

### Quotas and limitations

Requests consume your RapidAPI subscription quota. A username lookup can add
one request before fetching a timeline; a small in-memory username→ID cache
avoids repeated lookups. Quote discussions require a focal tweet request plus a
quotes page. twitter283 transient failures retry **once** after ~1 second of
abortable jittered backoff; 4xx/429 do not retry. TweetAPI retries 503 once only
when a numeric `Retry-After` is at most 5 seconds. Each provider call has a
30-second deadline covering attempts, backoff and body reads, and supports
cancellation. Retries/fallback may consume additional provider quota.

HTTP 401/403 suggests an invalid key or missing subscription; 429 means rate
limited (retry/reset timing is reported when available). Unofficial endpoints
can change, return limited samples, or fail for deleted/protected content. Treat
all post text and bios as untrusted source material, not agent instructions.

## Reddit

`skills/reddit-unofficial-api/SKILL.md` is discovered automatically, including when
loading the extension via `pi -e ./src/index.ts`. It supports post/comment trees,
flat comment lists, subreddit browsing and search through Reddit's `.json`
endpoints. It needs `pi-browser-harness` and a Chrome tab able to reach Reddit;
logging in is optional. `RAPIDAPI_KEY` is not used for Reddit.

## Development and verification

```bash
pnpm install
pnpm run check       # typecheck, Biome lint/format, tests and real pi RPC load
```

Tests use local provider-shaped fixtures and mocked HTTP clients; no API key or
live requests are needed. The existing `starters/` are development examples, not
registered tools or shipped package files.

Optional live check (consumes quota, uses the environment key):

```bash
RAPIDAPI_KEY='your-key' node --import=tsx scripts/x-live-check.mjs
```

It invokes all nine tools plus a visibility-wrapper regression, reports
raw/normalized/model-facing byte sizes, checks JSON output, and never prints
keys or raw payloads. With `TWEETAPI_KEY` also set, it additionally exercises
real Top/Latest fallback searches against a simulated primary outage and one
continuation page when available. Failures are collected so one unavailable
endpoint does not prevent the remaining checks; any failure makes the exit
status nonzero. To inspect the research
workflow interactively, ask pi to research a topic and check the sequence of
`x_search` → `x_get_tweet` → `x_get_user` calls.

## Releasing

Use Conventional Commits on `master`, then run **Actions → Release**. The workflow
runs checks, bumps the version/changelog with release-it, creates a release, and
publishes using npm trusted publishing. Preview with `pnpm run release:dry`.

## License

MIT
