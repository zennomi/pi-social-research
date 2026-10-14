# X response fixtures

Captured from `twitter283.p.rapidapi.com` during endpoint exploration (2026-10-13).
These preserve provider schemas, not normalized output. Lists retain 2–3 sample
entries and pagination cursors; large embedded facepiles/media entity maps are
omitted to keep each fixture below 40 KB. No API keys or request headers are stored.
`empty-*` represent HTTP 200 not-found responses.

Synthetic edge cases (retweets, pinned/promoted entries, wrappers, duplicate items)
are constructed in tests rather than presented as live provider responses.
