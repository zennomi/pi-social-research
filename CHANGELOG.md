# Changelog

## [0.1.1]

- Accept omitted, null and blank first-page cursors consistently across X tools; preserve
  nonempty opaque cursors without interpreting invented sentinels.
- Return structured cursor recovery errors with `isError: true` and `next_call`, without
  echoing arbitrary arguments or search queries.
- Reuse search fallback during a bounded 30-second primary-provider cooldown, preserving
  provider-specific pagination and distinguishing provider timeouts from caller cancellation.

## [0.1.0]

- Fix standalone/quotes tweet lookups and article extraction for visibility-wrapped responses.
- Retry twitter283 transient failures once with cancellable backoff and actionable errors.
- Add optional `TWEETAPI_KEY` fallback for failed top/latest searches, with provider-specific
  pagination, bounded retries, normalized results and safe quota errors.
- Warn on empty first search pages without dropping cursors; clarify post search types and
  article-vs-tweet IDs. Status now reports both credential-presence flags.

- Add nine read-only X research tools using RapidAPI `twitter283`, including search,
  conversations/quotes, profiles, timelines, articles, lists, communities, networks and trends.
- Normalize three provider schema dialects, preserve research-relevant data and guard output size.
- Use `RAPIDAPI_KEY` environment authentication, cancellable requests and actionable quota errors.
- Replace template echo/label state with `/social-research help` and credential/quota status.
- Keep the existing Reddit skill discovery; add offline fixtures, tests and optional live verification.
