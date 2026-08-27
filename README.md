# FJU Course Recommender System

This repository contains a data pipeline for collecting Fu Jen Catholic University
course outlines for recommendation-system research.

The repository now also contains a local-first course recommendation MVP:

- FastAPI catalog and query-embedding API.
- React 19 / TypeScript course discovery, recommendation, and timetable UI,
  built with Vite 8, Tailwind v4 and HeroUI v3, with light and dark themes.
  API reads go through TanStack Query; local data stays in IndexedDB.
- IndexedDB-only profiles, completed courses, favorites, and schedules.
- Conservative eligibility rules with source evidence.
- Versioned catalog and float32 embedding artifacts.
- An optional deterministic compound-query layer (no Chat Completion or other
  generative model) for coverage, intersection, negation, and catalog-backed
  hard constraints. It is controlled by `FJU_COMPOUND_QUERY_ENABLED=0` and
  falls back to the original whole-query dense + BM25/RRF ranking on every
  analysis error or unsupported relation.

Eligibility is represented as evidence-backed `eligibility_rules`. Graduate
course labels are normalized into `study_level`, `audience_grade`, and
`audience_department`; `study_level_only` and `audience_grade_only` rules block
confirmed mismatches before recommendation ranking, while unknown student
attributes remain marked for confirmation.

The first target dataset is:

- Academic year: `115`
- Semester: `1`
- Course type: `100` (general semester)
- Language: `1028` (Traditional Chinese)

The crawler uses the public JSON APIs called by the course-outline SPA instead
of browser-click automation. Scrapling is the primary HTTP transport; a urllib
fallback is available for environments where Scrapling is not installed yet.

## Commands

```bash
python3 -m fju_outline.cli discover --hy 115 --ht 1
python3 -m fju_outline.cli departments --hy 115 --lcid 1028
python3 -m fju_outline.cli crawl --hy 115 --ht 1 --page-size 100 --concurrency 3
python3 -m fju_outline.cli normalize --hy 115 --ht 1
python3 -m fju_outline.cli export --hy 115 --ht 1
python3 -m fju_outline.cli validate --hy 115 --ht 1
python3 -m fju_outline.cli artifacts --hy 115 --ht 1
```

Outputs are written under `data/`:

- `data/raw/`: complete API responses, one JSON object per line.
- `data/canonical/`: normalized nested course-outline records.
- `data/reference/departments_115.json`: official division and department
  dropdown options, including the code-to-full-name mapping used during
  normalization. Each official code is an independent identity: a department,
  degree program, and credit program are never merged merely because their
  names overlap. Run `departments` again when the university changes the
  official list.
- `data/derived/`: analysis-friendly Parquet tables.
- `logs/`: fetch logs and validation summaries.

## Development

```bash
pip install -e ".[pipeline,test]"
pytest -q

cd frontend
pnpm install
pnpm dev        # dev server, proxies /api to the backend
pnpm test       # vitest
pnpm build      # tsc -b && vite build -> frontend/dist
```

Run the API in another terminal after generating artifacts:

```bash
fju-outline-web --artifacts-dir /var/lib/crs/artifact-bundles/<immutable-bundle-id>/vector --port 8080
```

The backend serves `frontend/dist` for every non-API route. If that directory is
missing it returns **503 with the build command**, rather than silently serving a
stale or older UI — so run `pnpm build` before using the API server as the
frontend host. `/health/ready` keeps answering regardless, so container health
checks are unaffected.

The v3 artifact build also creates `query-route-index.json` and
`query-route-embeddings.f32`. Routes describe only reviewed role/context
phrases (for example, capstone or internship); they never replace the raw
query vector or act as a subject-domain classifier. The batch endpoint accepts
at most eight query texts and does one embedding-model call:

```http
POST /api/v1/query-embeddings
{"texts":["資料庫＋後端","資料庫","後端"]}
```

The UI requests `/api/v1/features` before enabling the compound layer. With
the flag off it uses the original `/api/v1/query-embedding` request exactly.

## Analytics

A privacy-first product analytics layer records *what people did*, never *who
they are*. It is self-hosted — SQLite next to the AI usage ledger — and no
third-party analytics service is involved.

- **No identity.** No `user_id`, device id or persistent UUID exists in the
  schema. The only correlation keys are a `sessionStorage` session id and a
  per-operation `interaction_id`, and both are nulled out of raw rows after
  `FJU_ANALYTICS_ID_RETENTION_DAYS` (7). A row older than that is a bare
  `(day, event, course, …)` tuple.
- **No personal data.** Department, grade, minor, double major, completed
  courses, favourites and the timetable stay in IndexedDB and are never sent.
  There is no field in the schema that could carry them.
- **No raw search text.** Only `query_length`, `result_count`, `search_mode` and
  `latency_ms`. There is no query sanitizer because there is no query column.
- **No IP, no fingerprint.** The payload has no address field. `User-Agent` is
  reduced server-side to (browser family, major, OS family, form factor) and the
  raw header is discarded.
- **Validated, not trusted.** `src/fju_outline/analytics.py` holds a per-event
  allowlist; unknown events, unknown properties, out-of-range numbers and
  `course_id`s that are not in the served catalog are all rejected, and a
  denylist (`email`, `student_id`, `token`, `schedule`, `ip`, …) fails the whole
  request. Events land in typed columns — there is no JSON blob.

```http
POST /api/v1/analytics/events        # batched, ≤40 events, fire-and-forget (202)
GET  /api/v1/analytics/report        # aggregates; X-Analytics-Token required
GET  /api/v1/analytics/dashboard     # the internal dashboard page
```

Set `FJU_ANALYTICS_ADMIN_TOKEN` to read the report, `FJU_ANALYTICS_ENABLED=0` to
switch collection off. The student-facing disclosure and opt-out live at
`/privacy`; the browser's Do Not Track signal is honoured without one.
Student profiles, completed courses, favorites, and schedules remain in the
browser; request bodies are not logged.

Evaluate the relevance set after changing the embedding model or retrieval strategy.
The report compares the dense baseline with the query-only hybrid RRF ranking:

```bash
python -m fju_outline.evaluation --artifacts-dir /var/lib/crs/artifact-bundles/<immutable-bundle-id>/vector
```

The production build is a single container:

```bash
# Verify a staged immutable bundle, then build with the external named context.
export CRS_ARTIFACT_BUNDLE_DIR=/var/lib/crs/artifact-bundles/<immutable-bundle-id>
python3 scripts/verify_artifact_bundle.py --bundle "$CRS_ARTIFACT_BUNDLE_DIR"
docker compose -f compose.yaml -f compose.build.yaml build

# Runtime Compose contains only the immutable image; it does not rebuild or download data.
docker compose -f compose.yaml up -d --no-build
```

## AI course assistant

The `/assistant` page is a separate, keyword/BM25 RAG flow. It does not call the
existing query-embedding endpoints: the server retrieves at most five compact
course contexts, then asks `gpt-5.6-luna` for a structured Traditional Chinese
answer. The model can only recommend course IDs in those retrieved contexts;
course details, warnings, and official links are filled from the local catalog.

Copy `.env.example` to `.env`, add `OPENAI_API_KEY`, and start the already-built
immutable image with Compose (never commit `.env`):

```bash
cp .env.example .env
chmod 600 .env
docker compose up -d --no-build
```

The assistant limits questions to 500 characters, keeps only two recent turns
in browser memory, rate-limits each IP, and enforces a monthly provider-call
limit. Usage totals are stored without prompt or profile content under
`data/runtime/ai-usage.sqlite3`. Set an OpenAI Project budget/alert separately
as a second billing safeguard. With the default Luna price and the planned
4,000 input / 800 output token profile, 10,000 calls are roughly US$17.60
(about NT$616 at US$1 = NT$35); the 5,000 / 1,000-token ceiling is roughly
NT$770 before exchange-rate and retry headroom.

The existing vector recommendation flow remains local-first and only sends the
submitted query text to `/api/v1/query-embedding`; the opt-in `/assistant` flow
also sends the minimum profile, completed-course IDs, and schedule-course IDs
listed in its consent panel so the server can filter candidates. Favorites and
the full IndexedDB are never sent. Request bodies must not be logged by the
application or its reverse proxy.
