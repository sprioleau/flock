# Scraping performance evaluation

This opt-in test measures guarded HTML acquisition, Chromium screenshots, deterministic brand evidence and image downloads. It does not time model inference or storage uploads. A successful scrape must retain its screenshot, semantic evidence and identity fields; timing alone is not the acceptance criterion.

From `apps/web`, with installed dependencies and a local Chrome executable:

```sh
FLOCK_RUN_PERFORMANCE_BENCHMARK=1 \
FLOCK_BENCHMARK_REPETITIONS=6 \
FLOCK_BENCHMARK_LABEL=candidate \
FLOCK_BENCHMARK_GIT_SHA=<tested-source-revision> \
FLOCK_BENCHMARK_OUTPUT=<absolute-new-output-directory> \
CHROME_EXECUTABLE_PATH=<absolute-chrome-executable> \
./node_modules/.bin/vitest run src/lib/brand-kit-extraction/__tests__/public-performance.integration.test.ts
```

The eight URLs are fixed in the harness. `FLOCK_BENCHMARK_SITES` optionally selects comma-separated site IDs for diagnostics. Each site's first repetition launches a fresh browser process; subsequent repetitions reuse that process with a fresh isolated context. This is a local Chrome benchmark, not a measurement of Vercel's Linux/Sparticuz runtime or an OS/network cold start. Use a new output directory on every run to preserve prior evidence.

Artifacts include incremental JSONL, per-run extraction JSON, JPG screenshots, stage timings, source revision, Chrome version and aggregate cold/warm summaries. Third-party failures remain recorded outcomes; instrumentation exceptions fail the test. Six samples are too few to infer reliable population p95 performance. Compare medians and ranges, inspect screenshots, distinguish variable site content from stable identity, and run an unchanged-source control before attributing improvements.

The 2026-10-29 evaluation used baseline commit `2a77b49ec51f1c7f85d5d2a76f9b7344776bb889`: 48 baseline captures, 48 final candidate captures and 24 unchanged-source control captures. A separate 48-run early-scroll experiment was rejected by the real Chromium delayed-hydration regression test. Final capture ordering is unchanged.

Full evidence and the original sequential benchmark harness are retained in the owner's git-ignored `docs/verification/scraping-performance-2026-10-29/` directory. This branch includes the reproducible final harness and regression tests, not the scraped third-party artifacts or local secrets.
