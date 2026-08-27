# FJU Course Recommender System

This repository contains a data pipeline for collecting Fu Jen Catholic University
course outlines for recommendation-system research.

The repository now also contains a local-first course recommendation MVP:

- FastAPI catalog and query-embedding API.
- React 19 / TypeScript course discovery, recommendation, and timetable UI,
  built with Vite 8, Tailwind v4 and HeroUI v3, with light and dark themes.
  TanStack Query manages interactive facet/course queries; large catalog/vector
  artifacts are content-addressed in IndexedDB.
- IndexedDB-only profiles, completed courses, favorites, and schedules.
- Conservative eligibility rules with source evidence.
- Versioned catalog and float32 embedding artifacts.
- An optional deterministic compound-query layer (no Chat Completion or other
  generative model) for coverage, intersection, negation, and catalog-backed
  hard constraints. It is controlled by `FJU_COMPOUND_QUERY_ENABLED` (default
  `0`) and falls back to the original whole-query dense + BM25/RRF ranking on
  every analysis error or unsupported relation.

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
of browser-click automation. In `auto` mode the HTTP transport chain is
Scrapling, then httpx, then urllib; `--transport` can force one of these
choices.

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

`fju_outline.cli artifacts` is the generic/legacy artifact command. It uses
`SentenceTransformerEncoder`, defaults to `intfloat/multilingual-e5-small`,
and writes to `data/artifacts/1151`; it is not the current production
EmbeddingGemma bundle.

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

## Production artifact bundle

The production bundle is a separate immutable artifact. The checked-in lock
reference at `artifact-locks/1151-embeddinggemma-768.json` specifies
`google/embeddinggemma-300m`, revision
`57c266a740f537b4dc058e1b0cda161fd15afa75`, 768 dimensions, float32 vectors,
and the `fju_catalog_v4` catalog schema. Do not use the generic `artifacts`
command above to claim that you rebuilt this bundle.

For a production-compatible rebuild, use the pinned builder with a canonical
115-1 catalog and a new immutable bundle ID when the inputs change. To reproduce
the checked-in lock exactly, the canonical snapshot must match that lock's
checksum and 4,565-record count.

```bash
python3 scripts/build_embedding_bundle.py \
  --canonical /path/to/course_outlines_1151.jsonl \
  --output /path/to/staging-bundle/vector \
  --lock-output /path/to/staging-bundle/bundle-lock.json \
  --bundle-id <new-immutable-bundle-id> \
  --year 115 --semester 1 --batch-size 64
```

The source bundle supplied to the Docker build must contain the generated
`vector/`, its matching `bundle-lock.json`,
`canonical/course_outlines_1151.jsonl`, and the pinned `model-cache/`. Verify
the complete bundle before provisioning it into an immutable target directory:

```bash
python3 scripts/verify_artifact_bundle.py --bundle /path/to/staging-bundle
scripts/provision_artifact_bundle.sh \
  /path/to/staging-bundle /var/lib/crs/artifact-bundles
```

`provision_artifact_bundle.sh` verifies a staging copy and atomically places it
under `TARGET_ROOT/<bundle-id>` without overwriting an existing bundle. The
bundle-local `bundle-lock.json` is the input to `--bundle` verification; the
checked-in `artifact-locks/` file is the repository's lock reference.

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
frontend host. `/health/live` and `/health/ready` are separate health
endpoints; the readiness endpoint is independent of frontend mounting and still
answers when the artifact/model runtime is ready, so a missing frontend build
does not by itself break container health checks.

The v3 artifact build also creates `query-route-index.json` and
`query-route-embeddings.f32`. Routes describe only reviewed role/context
phrases (for example, capstone or internship); they never replace the raw
query vector or act as a subject-domain classifier. The batch endpoint accepts
at most eight query texts and can encode them in one embedding-model call:

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
  `FJU_ANALYTICS_ID_RETENTION_DAYS` (7); the remaining typed event fields follow
  their own retention windows.
- **No personal data in analytics.** For analytics requests, department, grade,
  minor, double major, completed courses, favourites and the timetable stay in
  IndexedDB and are not included. There is no field in the analytics schema
  that could carry them. The optional AI assistant is separate and has the
  consented data flow described below.
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
- **Retry-safe.** Each event is assigned an opaque idempotency key (or a
  server-derived canonical digest for older clients), backed by a SQLite unique
  index so an identical network retry is ignored.
- **Bounded storage.** Retention remains time-based, with configurable row and
  database-size ceilings that evict the oldest events before rejecting a batch.

By default, raw product events are retained for 180 days, diagnostic events
(`api_performance` and `error`) for 90 days, and the session/interaction
identifiers are nulled after 7 days; these windows are controlled by the
`FJU_ANALYTICS_*_RETENTION_DAYS` variables. Daily aggregate tables are retained
separately. These analytics retention statements do not describe the optional
AI assistant's request data.

```http
POST /api/v1/analytics/events        # batched, ≤40 events, fire-and-forget (202)
GET  /api/v1/analytics/report        # aggregates; X-Analytics-Token required
GET  /api/v1/analytics/dashboard     # the internal dashboard page
```

Set `FJU_ANALYTICS_ADMIN_TOKEN` to read the report, `FJU_ANALYTICS_ENABLED=0` to
switch collection off. The student-facing disclosure and opt-out live at
`/privacy`; the browser's Do Not Track signal is honoured without one.
Student profiles, completed courses, favorites, and schedules remain in the
browser for ordinary catalog/recommendation/analytics flows; the application
does not log request bodies.

For the Cloudflare Tunnel deployment, rate limiting accepts `CF-Connecting-IP`
only when the socket peer is in `FJU_TRUSTED_PROXY_IPS`; `X-Forwarded-For` is
never trusted. Production API docs are disabled by default with `FJU_ENV=production`.

Evaluate the relevance set after changing the embedding model or retrieval strategy.
The report compares the dense baseline with the query-only hybrid RRF ranking:

```bash
python -m fju_outline.evaluation --artifacts-dir /var/lib/crs/artifact-bundles/<immutable-bundle-id>/vector
```

The production runtime is a single container:

On the production host, use the guarded deployment script from the clean
deployment worktree:

```bash
cd /home/hyslchs/CourseRecommanderSystem-deploy
./deploy.sh
```

The script performs fast-forward-only `git pull`, immutable bundle verification,
named-context Docker build, and local/public readiness checks. It uses a
revision-scoped Compose project so previous containers remain available for
rollback; it never copies `.env` or secrets into the image.

```bash
# This is an example bundle path. CRS_ARTIFACT_BUNDLE_DIR selects the bundle root.
export CRS_ARTIFACT_BUNDLE_DIR=/var/lib/crs/artifact-bundles/<immutable-bundle-id>
python3 scripts/verify_artifact_bundle.py --bundle "$CRS_ARTIFACT_BUNDLE_DIR"
docker compose -f compose.yaml -f compose.build.yaml build

# The image tag contains the immutable bundle ID and source Git revision; update it for every source change.
# Runtime Compose contains only the immutable image; it does not rebuild or download data.
docker compose -f compose.yaml up -d --no-build
```

When `CRS_ARTIFACT_BUNDLE_DIR` is unset, `deploy.sh` uses its own default:
`/home/hyslchs/crs-artifact-bundles/1151-embeddinggemma-768-r57c266a-c9935a9392ab`.
The `/var/lib/crs/artifact-bundles/...` path above is only an example and is
not the `deploy.sh` default.

## Production Docker network

Production Compose uses the operator-managed external network
`crs-production-network`. Its fixed configuration is:

```text
subnet:  172.24.0.0/24
gateway: 172.24.0.1
```

Create this network once, after checking that its subnet does not overlap any
Docker, VPN, or host network on the production server:

```bash
docker network create \
  --driver bridge \
  --subnet 172.24.0.0/24 \
  --gateway 172.24.0.1 \
  crs-production-network
```

This is a protected production resource. Do not run `docker network rm` or
`docker network prune` against it. Compose does not create or remove this
external network, and `deploy.sh` fails before stopping the current application
container if the network is missing or its driver, subnet, or gateway is wrong.

The deployment still uses a commit-scoped Compose project and keeps the
revision-specific container identity needed by the existing rollback handler.
Only one revision may publish `127.0.0.1:8080` at a time, so cutover remains
stop-before-start; the old container is retained for rollback. The CRS network
must not be mixed with `freshrss_default`, and `cloudflared` continues to use
`http://127.0.0.1:8080`.

Set the production environment once to:

```text
FJU_TRUSTED_PROXY_IPS=172.24.0.1/32
```

The Docker gateway is the socket peer seen by FastAPI on the localhost
published-port path. Future commit deployments reuse the same external network
and do not require another trusted-proxy change. The application never trusts
`X-Forwarded-For`.

During the first legacy-network to fixed-network migration, the old container
may still be attached to the legacy network and retain its legacy environment.
If the new container fails, restore the old container and confirm the
operator-managed `.env` matches the active legacy topology before another
deployment. Do not delete the legacy network until the rollback window has
closed. After the migration succeeds, future rollback keeps both revisions on
the fixed network and does not recreate or remove any network.

## AI course assistant

The repository includes an optional AI course assistant, but this feature is
currently not enabled on the public deployment at
`https://crs.sixhuang.com`. The statements in this section describe repository
capability and apply only to a deployment that explicitly enables the feature;
they do not mean that the public site currently sends data to OpenAI or
generates AI answers.

When enabled, the `/assistant` page calls `POST /api/v1/ai/ask` and uses a
separate keyword/BM25 RAG flow. It does not call or depend on the existing
query-embedding recommendation endpoints. The server can rank/filter up to 30
retrieved candidates internally, then sends at most five compact course
contexts to the model. The default model is `gpt-5.6-luna`; `FJU_AI_MODEL` can
override it. The structured answer must be in Traditional Chinese and can
recommend only course IDs present in those five retrieved contexts. Course
details, warnings, and official links are filled from the local catalog after
the model response.

The feature is opt-in. After user consent, the frontend sends the following to
the CRS backend. The table distinguishes that backend request from the data
actually included in the OpenAI Responses prompt:

| Data | CRS backend | OpenAI Responses prompt |
| --- | --- | --- |
| Question | Yes | Yes |
| `division`, `department`, `department_identity`, `grade`, `study_level`, `preferred_weekdays` | Yes | Yes |
| `completed_course_ids`, `schedule_course_ids` | Yes | No; used for server-side completion, eligibility, and schedule-conflict filtering |
| `hard_constraints` | Yes | No; used for server-side candidate filtering |
| Recent history | At most two turns | At most two turns; questions are clipped and recommended IDs are retained |
| Favorites and the full IndexedDB | No | No |

The server uses `completed_course_ids` and `schedule_course_ids` for filtering,
eligibility, and conflict checks; those two arrays are deliberately excluded
from the model prompt. The OpenAI prompt contains the cleaned question, the
non-ID student context above, recent history, and up to five local course
contexts containing course ID, title, metadata, objective, weekly progress,
skills, prerequisite, and enrollment-note fields. If
`FJU_AI_MODERATION_ENABLED` is enabled (the default), the cleaned question may
also be sent to OpenAI's `omni-moderation-latest` endpoint before generation.

Keep `OPENAI_API_KEY` empty to leave the assistant disabled. With no key, the
service is not initialised, no OpenAI provider is called, and
`POST /api/v1/ai/ask` returns HTTP 503 with `AI 小幫手尚未設定 API key`.
Generation uses the Responses API with `store=False`. The usage ledger at
`data/runtime/ai-usage.sqlite3` stores monthly call counts, token totals,
success/failure counts, and model name; it does not store prompt, question,
profile, completed-course, schedule, or answer content.
Set `FJU_AI_USAGE_DB` to change the ledger path.

Runtime-enforced assistant limits are:

- Question length: `FJU_AI_MAX_QUESTION_CHARS`, default 500 and capped at 500.
- Browser/UI memory: up to six completed turns are retained for display; each
  AI request sends only the latest two turns as history.
- Retrieval and output: up to 30 internal candidates, up to five model
  contexts, and `FJU_AI_MAX_OUTPUT_TOKENS` output tokens (default 1,000,
  clamped to 100–1,000). The constructed user-side RAG prompt is clipped at
  7,000 characters; this is not an exact input-token ceiling.
- Usage guards: `FJU_AI_REQUESTS_PER_MINUTE` defaults to 10 and
  `FJU_AI_MONTHLY_REQUEST_LIMIT` defaults to 10,000.

Cost figures are estimates for a future or other deployment with the assistant
enabled, not measurements or hard limits for `crs.sixhuang.com`. Under
illustrative pricing assumptions, 10,000 calls at roughly 4,000
input / 800 output tokens are about US$17.60 (about NT$616 at US$1 = NT$35),
while a 5,000 / 1,000-token scenario is about NT$770. Actual cost depends on
provider pricing, tokenization, retries, and measured usage; the character
limit above does not guarantee either input-token scenario.

The ordinary vector recommendation flow remains local-first: profiles,
completed courses, favorites, and schedules stay in IndexedDB, while the
server handles only query text derived from the submitted input for
`/api/v1/query-embedding` (or the deterministic compound path
`/api/v1/query-embeddings` when enabled). It does not send the optional AI
context unless the separate assistant flow is enabled and consented. The
application does not log request bodies.
