# X response fixtures

Captured from `twitter283.p.rapidapi.com` during endpoint exploration (2026-10-13).
These preserve provider schemas, not normalized output. Lists retain 2–3 sample
entries and pagination cursors; large embedded facepiles/media entity maps are
omitted to keep each fixture below 40 KB. No API keys or request headers are stored.
`empty-*` represent HTTP 200 not-found responses.

Synthetic edge cases (retweets, pinned/promoted entries, wrappers, duplicate items)
are constructed in tests rather than presented as live provider responses.

- `detailv3-sensitive.json` is synthetic: it reproduces the observed visibility
  wrapper whose inner tweet lacks `__typename`, without copying session content.
- `tweetapi-search-latest.json` and `tweetapi-search-top.json` are synthetic, based
  on https://tweetapi.com/docs/explore/search and https://tweetapi.com/openapi-v2.json.
  The guide documents Top `{type, content}` wrappers; the OpenAPI search schema
  also allows flat tweets. Tests cover both, plus filtered user/promoted entries.
