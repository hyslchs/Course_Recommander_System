# Security Audit Report — Course Recommander System

**Audit date:** 2026-08-26
**Repository revision:** `53968924eda61fbe8a363ee8dd574d3dec68e016` (`main`) **plus uncommitted local working-tree changes**
**⚠️ Working-tree note:** at audit time, `src/fju_outline/web.py`, `src/fju_outline/artifacts.py`, and `.env.example` carried substantial **uncommitted** local edits on top of the commit above (an in-progress refactor of artifact/catalog loading, ~565 changed lines) — these were already present when this audit began and were not made by this audit. Every finding in this report was verified by reading the actual files on disk (i.e., against this working-tree state, which is what would actually run), so file:line evidence is accurate to what's really there — but it is **not** identical to what `git show 5396892:...` would print for those two files. Re-run a diff-aware check after these changes are committed.
**Audit type:** Full-repository re-audit — source, dependencies, secrets, configuration, business logic, and safe local dynamic checks. Multi-agent methodology: 4 independent specialist reviews + 1 adversarial second pass + manual orchestrator verification of every High/Medium finding.
**Prior audit:** `2026-08-24`, revision `893dd45`. This report supersedes it. Findings are labeled **FIXED**, **CARRIED FORWARD**, **ELEVATED**, or **NEW** against that baseline.
**Production code changes:** None. Audit only.

---

## 1. Executive Summary

This re-audit covers the repository as it stands after the React/HeroUI frontend redesign and the addition of a new privacy-first analytics feature (ingest endpoint, SQLite store, token-gated admin dashboard) since the prior audit. **No Critical vulnerability was found. One High-severity finding was confirmed** — an improvement in specificity over the prior audit, which had only raised the equivalent risk hypothetically as Medium. Ten further findings were confirmed: **7 Medium and 5 Low, plus one Informational** note.

**The single most important finding (HIGH):** all of the application's rate limiters key on `request.client.host`. In the actual deployed production topology (`DEPLOYMENT.md`: Cloudflare Tunnel → `cloudflared` → plain HTTP to `127.0.0.1:8080`, no `X-Forwarded-For`/`CF-Connecting-IP` parsing anywhere in the code), that value is identical for every real internet visitor. Every "per-client" limit — on the AI assistant, the embedding endpoints, and analytics ingest — is therefore one shared, site-wide bucket. A single browser tab, with no distribution or botnet needed, can already exhaust the AI assistant's shared per-minute budget for every other user, and can burn through the entire **monthly** OpenAI usage cap (10,000 calls) in well under a day by sending requests continuously at the allowed 10/minute rate. This is a real, verified, reachable financial-DoS and availability risk against the deployed system, not a theoretical one.

The prior audit's stored-XSS finding (**SEC-002**) is **confirmed FIXED**: the legacy fallback frontend (`web_assets/app.js`, `index.html`) that built an inline `onclick` handler from untrusted `course_id` text was deleted during the frontend redesign, and the server now fails closed (503) instead of falling back to it. No `dangerouslySetInnerHTML`/`innerHTML`/inline-handler pattern exists anywhere in the new React frontend or the new analytics dashboard, and the new analytics feature itself (~1,300 lines of new server code) is well-built — parameterized SQL throughout, strict per-event-type field allowlisting with no free-text/JSON-blob escape hatch, a PII-key denylist, catalog-bound `course_id` validation, and timing-safe admin-token comparison.

The application still has no user accounts, authentication, sessions, or server-side student profiles — the course catalog is intentionally public data. Confirmed clean this round, independently by multiple reviewers: SQL/command injection, path traversal, SSRF, CSRF, permissive CORS, BOLA/IDOR (no ownership boundary exists to violate), and unsafe deserialization. The remaining Medium findings are mostly about **decision integrity and abuse resistance** rather than confidentiality breaches: client-asserted student facts (grade, department, division, study level, completed courses) drive an eligibility verdict the AI assistant presents as "confirmed"; the new analytics admin endpoint has no rate limiting (brute-forceable in principle, though the deployed token is high-entropy); the analytics store has no size cap; and analytics events can be replayed to poison dashboard metrics. Supply-chain hygiene (unpinned CI Actions, floating Docker base image tags, an unpinned ML model revision, no Python lockfile) and the still-root production container remain open from the prior audit.

**Overall risk: Medium-High**, driven up from the prior "Medium" mainly by the confirmed, deployment-topology-specific severity of the rate-limiting finding. There is no P0 emergency requiring the service be taken offline, but the rate-limiter fix should not wait for a routine release cycle — see §14 for the deployment recommendation.

### Findings Summary

| ID | Status | Severity | Confidence | Finding |
|---|---|---|---:|---|
| CRS-01 | **ELEVATED** (was SEC-001, Medium) | **High** | High | Rate limiters share one key for all real visitors — Cloudflare Tunnel topology defeats per-client throttling |
| CRS-02 | ELEVATED (was SEC-003) | Medium | High | Client-asserted grade/department/division/study-level/completed-courses drive a "confirmed" eligibility verdict |
| CRS-03 | NEW | Medium | High | `/api/v1/analytics/report` (the only token-gated route) has no rate limiting — unthrottled online token guessing |
| CRS-04 | NEW | Medium | High | Analytics SQLite store has no total row/size cap — only day-based retention |
| CRS-05 | NEW | Medium | Medium | No replay/idempotency protection on analytics events — dashboard metrics can be poisoned |
| CRS-06 | CARRIED (SEC-004) | Medium | Medium | Crawler consumes unbounded/unvalidated third-party (FJU API) responses |
| CRS-07 | CARRIED (SEC-005) | Medium | High | CI Actions, Docker base images, ML model revision, and Python deps remain unpinned/mutable |
| CRS-08 | CARRIED (SEC-006) | Medium | High | Production container still runs as root (no `USER` in `Dockerfile`) |
| CRS-09 | CARRIED (SEC-007) | Low | High | No browser security headers (CSP/`nosniff`/frame/HSTS/Referrer/Permissions-Policy) |
| CRS-10 | NEW | Low | High | `/docs`, `/redoc`, `/openapi.json` remain reachable in production |
| CRS-11 | CARRIED (SEC-008) | Low | High | Public catalog still aggregates instructor/contact email addresses from free-text fields |
| CRS-12 | CARRIED (SEC-009) | Low | High | Backup import validates only outer shape (impact now confirmed bounded to the importing user's own browser data — no XSS path exists) |
| CRS-13 | CARRIED (SEC-010) | Low | High | Production access logging disabled; minimal security telemetry |
| CRS-14 | NEW | Low | High | AI content-moderation call fails open on its own API error (network/timeout/outage) |
| — | FIXED (was SEC-002) | — | — | Legacy stored-XSS fallback deleted; server now fails closed instead |

| Severity | Count |
|---|---:|
| Critical | 0 |
| High | 1 |
| Medium | 7 |
| Low | 6 |
| Informational | 1 |

---

## 2. Architecture / Threat Model

### System and data flow (updated)

```text
Internet users
     |  HTTPS/TLS 1.3
     v
Cloudflare Edge (crs.sixhuang.com)
     |  Cloudflare Tunnel (outbound-only)
     v
cloudflared (host systemd service)
     |  plain HTTP, 127.0.0.1:8080  <-- no proxy-header (X-Forwarded-For/CF-Connecting-IP) handling anywhere
     v
Docker container: FastAPI + SentenceTransformer + React SPA (crs-app)
     |                                  |                        |
     v                                  v                        v
local catalog/embeddings   SQLite: ai-usage.sqlite3     SQLite: analytics.sqlite3 (NEW)
(data/artifacts, model)    (monthly AI call ledger)     (event ingest + admin report)
     |
     v
OpenAI API (AI assistant + moderation) <-- only outbound third-party call the app makes at request time

offline, operator-run, not reachable from the internet:
FJU Outline API (untrusted external data) -> crawler -> raw/canonical JSON -> artifact builder + embedding model -> baked into the Docker image

Browser <-- static React/legacy UI served by FastAPI
   |
   v
IndexedDB (profile, completed courses, favorites, schedules, backups) -- unchanged from prior audit, local-only
```

### Trust boundaries (updated)

1. **Internet client → FastAPI:** all URL, query, JSON body, headers, IDs, profile facts, and analytics events are attacker-controlled. Unchanged from prior audit.
2. **cloudflared → FastAPI:** **new boundary made explicit this round.** The app trusts `request.client.host` as a client identity for rate limiting, but that socket is always `cloudflared`'s loopback connection — the app has *no* visibility into the real origin IP at all. This isn't a spoofing risk (nothing can be "spoofed" that was never read) — it's a design gap: the rate limiter has no working notion of "client" in production.
3. **FJU API → crawler/build pipeline:** unchanged — TLS provides transport protection only; every returned field remains untrusted content until validated.
4. **Artifacts → application/model:** hash verification remains in force (`FJU_VERIFY_ARTIFACT_HASHES=1` by default, enforced in `artifacts.py`), but it's a self-referencing manifest, not a signed one, and the Hugging Face model itself is pulled by name with no pinned revision at image-build time (only verified by vector *dimension* at runtime, not by *revision*).
5. **Browser → IndexedDB:** unchanged — local plaintext data, same-origin-script-accessible.
6. **FastAPI → OpenAI:** unchanged in shape, but now with two call sites — the RAG `ask` completion and, separately, the moderation call, which the audit found fails open on its own transport error (CRS-14).
7. **Anonymous client → analytics ingest → analytics dashboard (NEW boundary):** the ingest endpoint is unauthenticated by design (it has to be, to collect from real visitors) but the *report/dashboard* is meant to be trusted, admin-only data. This audit found that boundary is under-defended in two ways: no rate limit on the token check (CRS-03) and no protection against an attacker manufacturing fake "signal" in the aggregates the dashboard reader trusts (CRS-05).
8. **GitHub Actions / registries / base images / Hugging Face → build:** unchanged — third-party code and model assets enter the build pipeline without immutable pinning (CRS-07).

### Assets and threat actors

Unchanged from the prior audit: OpenAI credential and budget, service availability, recommendation/eligibility decision integrity, student-local planning data, instructor contact data, build/release integrity — **plus, newly, the integrity of the analytics dashboard's aggregate metrics**, which this audit treats as an asset in its own right (CRS-04, CRS-05) since it's presented to an operator as ground truth about product usage.

Threat actors: anonymous internet users (the only class that matters — there is still no authentication model beyond the single analytics admin token), automation/bots, a compromised or malicious upstream course-data source, a compromised package/action/image/model publisher.

### API inventory

`register_routes()` in `src/fju_outline/web.py` defines the application's routes (health, catalog/facets/departments, course lookup single+batch, embeddings, AI assistant, query-route artifacts, legacy `/api/*` compatibility, and the new analytics ingest/report/dashboard routes), plus FastAPI's default `/docs`, `/redoc`, `/openapi.json` (confirmed still enabled — CRS-10). `analytics_report` (`web.py:704`) is the **only** route in the entire application gated by anything resembling authentication.

### OWASP coverage conclusion

| Category | Result |
|---|---|
| A01 / API1 / API5 — Access control, BOLA, BFLA | No ownership boundary exists for public course data (unchanged). The one real access-control boundary — the analytics admin token — is correctly *implemented* (fails closed, constant-time compare, header transport) but **not rate-limited** (CRS-03). |
| A02 — Cryptographic failures | No application cryptography/password storage. TLS termination is out-of-repo (Cloudflare-managed). |
| A03 — Injection | Prior SEC-002 (stored XSS) confirmed **fixed**. No SQLi, command injection, SSTI found; analytics writes are fully parameterized. |
| A04 / API4 / API6 — Insecure design / resource / business flow | **CRS-01 (High)**, CRS-02, CRS-03, CRS-04, CRS-05 all live here — this is the dominant risk category this round. |
| A05 / API8 — Misconfiguration | CRS-08 (root container), CRS-09 (headers), CRS-10 (docs exposed). CORS is not permissive (no CORS middleware exists at all). |
| A06 — Vulnerable components | No exploitable CVE confirmed reachable in the deployed app (see §8). CRS-07 covers pinning/supply-chain hygiene rather than a live CVE. |
| A07 / API2 — Authentication failures | No user authentication exists or is required for public catalog data. The analytics admin token mechanism itself is sound; its lack of throttling is CRS-03. |
| A08 / API10 — Integrity / unsafe API consumption | CRS-06 (crawler) and CRS-07 (supply chain) confirmed. No unsafe `pickle`/YAML/XML deserialization found. |
| A09 — Logging/monitoring | CRS-13 confirmed. |
| A10 / API7 — SSRF | No web endpoint accepts a URL for the server to fetch. |
| API9 — Improper inventory management | CRS-10 (docs/OpenAPI schema exposure aids reconnaissance). |

---

## 3. Skills / Tools Used

This audit used the OWASP Secure Agent Playbook `code-security-skills` plugin (installed via `/plugin marketplace add OWASP/secure-agent-playbook` + `/plugin install code-security-skills`), run as four parallel specialist subagents, followed by one adversarial second-pass subagent, followed by manual orchestrator verification against live source for every High/Medium finding:

| Agent / pass | Coverage |
|---|---|
| `code-security-skills:code-security-reviewer` | Secrets scanning, web-app security (injection/XSS/CSRF/deserialization/SSRF), general code-level review across `src/fju_outline/**` and `frontend/src/**` |
| `code-security-skills:dependency-auditor` | SCA — Python (`pyproject.toml` + installed venv) and Node (`pnpm-lock.yaml`) dependency CVE audit |
| `code-security-skills:api-security-reviewer` | OWASP API Security Top 10 review of every FastAPI route, admin-token gate, business logic, rate limiting |
| general-purpose (IaC/CI/CD reviewer) | `Dockerfile`, `compose.yaml`, `.github/workflows/ci.yml`, `.dockerignore`, model/artifact provenance |
| general-purpose (adversarial second pass) | Fresh-eyes hunt for access-control, business-logic, trust-boundary, and configuration issues the first four passes could plausibly have missed |
| Orchestrator (this session) | Manual re-verification of every High/Medium finding against live source with exact file:line evidence; independent secrets/PII scans; safe local checks |

### Automated tooling actually available/used

No `semgrep`, `gitleaks`, `trufflehog`, `osv-scanner`, `trivy`, or `pip-audit` CLI is installed in this environment (verified — same gap noted in the prior audit). This round compensated with:

- **OSV.dev API** (`api.osv.dev/v1/query`, `/v1/querybatch`) — queried directly for 42 PyPI packages and 23 npm packages by exact resolved version.
- **`pnpm audit`** — run against the full resolved 239-package frontend dependency tree (works here because `frontend/pnpm-lock.yaml` is committed, unlike the prior audit's `npm audit`, which failed for lack of a lockfile).
- **Manual pattern-based secret scanning** (`git grep` for AKIA/`sk-`/private-key headers/etc. across all tracked files, excluding data artifacts) — no hardcoded secret found in tracked files.
- **`git log --all --full-history -- .env`** — confirms `.env` was never committed, at any point in history.
- **Recursive PII scan** of the actual Docker-shipped catalog data (`data/artifacts/1151/catalog.json`, 4,233 records) for email-address patterns in nested fields — confirms CRS-11 is still live in the data that actually ships.
- **`pytest -q`** (local run) — 170 passed, 46 subtests passed, 1 unrelated failure in a vendored third-party test under the git-ignored `tmp/` scratch directory (not part of the app), 33 errors that are a Windows-sandbox temp-directory permission issue in *this specific audit environment* (`PermissionError: [WinError 5]` on `AppData\Local\Temp\pytest-of-*`), not an application defect — the repo's own CI runs the same suite cleanly on Linux.
- Route-registration-order and reachability analysis (Starlette matches routes in registration order — confirmed `/docs` etc. are not shadowed by the SPA catch-all, and the catch-all cannot escape `frontend/dist`).

### NOT tested (unchanged from prior audit, same reasons)

OWASP ZAP DAST, Trivy/container-image CVE scanning, Gitleaks/TruffleHog binaries, cloud/TLS/WAF configuration (out of repo), live credential validity, and any destructive or production-targeted testing. All dynamic checks in this audit were local-process/localhost-only.

---

## 4. Findings

### 4.1 HIGH

#### CRS-01 — Rate limiters share one key for every real visitor (Cloudflare Tunnel defeats per-client throttling) — *elevates SEC-001*

- **Severity:** High **Confidence:** High
- **CWE / OWASP:** CWE-770 (Allocation of Resources Without Limits), CWE-307-adjacent; OWASP A04:2021; API4:2023 Unrestricted Resource Consumption
- **Files/lines:**
  - `src/fju_outline/web.py:657-659` (`analytics_events`), `:723-725` (`ai_ask`), `:769-771` (`query_embedding`), `:787-789` (`query_embeddings`) — every one does `client = request.client.host if request.client else "unknown"` then `.allow(client)`.
  - `src/fju_outline/analytics.py:18-21` (module docstring) — explicitly documents: *"No IP. ... The one place the client address is touched is the shared in-memory rate limiter in `web.py`, which keeps a deque of timestamps and never writes to disk."* — confirming this was a deliberate privacy design choice whose availability side-effect wasn't evaluated against the real deployment topology.
  - `DEPLOYMENT.md:18` — `cloudflared` connects to the container over **plain HTTP to `127.0.0.1:8080`**, and no `nginx`/reverse-proxy header normalization exists anywhere in the repo. `git grep` for `X-Forwarded-For`/`CF-Connecting-IP` in `src/` returns zero matches.
  - `src/fju_outline/web.py:442-452` — `RateLimiter()` (default 30/min), `ai_rate_limiter` (`FJU_AI_REQUESTS_PER_MINUTE`, default 10/min), `analytics_rate_limiter` (`FJU_ANALYTICS_REQUESTS_PER_MINUTE`, default 60/min) are all process-local, single-key-space limiters.
  - `src/fju_outline/rag.py:215-254` (`UsageLedger.reserve_call`) — the *only* cross-request, cross-IP guard is a shared monthly counter (`FJU_AI_MONTHLY_REQUEST_LIMIT`, default 10,000) that fails closed for **everyone** once exhausted.
- **Evidence / verification performed:** confirmed by two independent reviewers (code-security-reviewer, api-security-reviewer) and re-verified directly by the orchestrator by reading the exact `request.client.host` call sites, the `RateLimiter` implementation, and `DEPLOYMENT.md`'s network diagram together. Because `cloudflared` is the only thing that ever opens a TCP connection to the app, `request.client.host` is the tunnel daemon's own loopback address for **every** request from **every** visitor — legitimate or malicious, there is exactly one bucket per limiter, site-wide.
- **Attack scenario:** No distribution or botnet is required (a more conservative framing from one reviewer assumed ~17 concurrent IPs would be needed to exhaust the monthly cap under working per-IP isolation — that assumption doesn't hold here, since per-IP isolation isn't actually happening). A single client sending one request every 6 seconds (well within the "10 requests/minute" the limiter is *trying* to allow that one client) sustains 14,400 requests/day — enough to exhaust the entire 10,000/month `FJU_AI_MONTHLY_REQUEST_LIMIT` in **under a day**, using one browser tab, no coordination, no credential, no rate-limit evasion needed. The same shared-bucket problem simultaneously means that traffic is denial-of-service against every *other* legitimate visitor trying to use the AI assistant, embeddings, or send analytics during that window — one abusive user's requests count against the same 10-per-minute budget everyone else is drawing from.
- **Impact:** (1) Financial DoS — burns the configured monthly OpenAI budget. (2) Full outage of the AI assistant feature for all legitimate users for the remainder of the billing month once the ledger trips. (3) Availability DoS on the embedding and analytics-ingest endpoints for all concurrent users, independent of the monthly-budget angle. Rated **High** rather than Critical because: no data confidentiality/integrity boundary is crossed, the blast radius is bounded by the monthly-spend cap itself (not unbounded spend), and core catalog browsing/search functionality (which doesn't call these endpoints) is unaffected.
- **Remediation:**
  1. Parse and trust `CF-Connecting-IP` (Cloudflare's own de-proxied client IP header) specifically, since `cloudflared` is a controlled, first-party hop — do **not** trust generic `X-Forwarded-For` from an arbitrary reverse proxy without validating the proxy chain.
  2. Add a coarser **global** ceiling in front of the monthly ledger (e.g., a soft-throttle at 80% of the monthly budget, or a daily sub-budget) so a single burst cannot consume a month's allowance in hours.
  3. Consider a lightweight bot-detection signal (e.g., Cloudflare Turnstile) on `/api/v1/ai/ask` specifically, since it's the only cost-bearing route.
  4. Once (1) is fixed, re-verify the per-key limiter actually differentiates real clients with a two-IP local test (as the prior audit's methodology did).

---

### 4.2 MEDIUM

#### CRS-02 — Client-asserted profile facts drive a "confirmed" eligibility verdict — *elevates SEC-003*

- **Severity:** Medium **Confidence:** High
- **CWE / OWASP:** CWE-807 (Reliance on Untrusted Inputs in a Security Decision); OWASP A04:2021; API3:2023-adjacent (trust in client-supplied properties)
- **Files/lines:** `src/fju_outline/rag.py:106-144` (`AIContext` — `division`, `department`, `grade`, `study_level`, `completed_course_ids` all fully client-supplied, Pydantic-validated for shape/range only, not truth), `rag.py:371-378` (call into `evaluate_eligibility(...)`), `src/fju_outline/eligibility.py:247-308` (`minimum_grade`, `exact_grade`, `division_only`, `department_only`, `study_level_only`, `audience_grade_only` rule kinds; `:301` `"blocked_confirmed"`, `:305` `"eligible_confirmed"`).
- **What's new this round:** the prior audit confirmed `grade` and `completed_course_ids` could flip a real course from `blocked_confirmed` to `eligible_confirmed`. This audit's adversarial pass confirmed the **same class of trust gap also applies to `study_level` and `division`** — a client claiming `study_level: "master"` or `division: "研究所"` (graduate school) satisfies the `study_level_only`/`division_only` rule kinds exactly the same way. The rule-set logic itself was checked line-by-line for off-by-one or fail-open bugs (e.g., a field being merely absent vs. present-but-wrong) — none found; the *only* issue is that every one of these facts is self-reported with no verification path.
- **Attack scenario:** A user (or an automated tool) edits the request body sent to `/api/v1/ai/ask` to claim a higher grade, a different department/division, a graduate `study_level`, or a fabricated completed-course ID, and receives an eligibility verdict labeled "confirmed" for a course that is actually restricted to them.
- **Impact:** Decision-integrity, not confidentiality — no ownership boundary is crossed (the catalog is public regardless of the claimed profile) and the official FJU enrollment system remains the actual gate. But a student can be given false confidence that they qualify for a restricted course, and the "confirmed" wording overstates what the system actually verified (nothing).
- **Remediation:** Rename the outcome to something that doesn't claim verification (e.g. `eligible_based_on_self_report`); always surface the official restriction text regardless of the claimed profile; if a real "confirmed" status is ever wanted, it needs to come from an authenticated, university-verified source of grade/department/completed-courses, not the request body.

#### CRS-03 — No rate limiting on the analytics admin-token check (`/api/v1/analytics/report`) — NEW

- **Severity:** Medium **Confidence:** High
- **CWE / OWASP:** CWE-307 (Improper Restriction of Excessive Authentication Attempts); API4:2023
- **Files/lines:** `src/fju_outline/web.py:690-702` (`_require_analytics_admin` — timing-safe `secrets.compare_digest` check, but no call to any `RateLimiter`), `:704-710` (`analytics_report` route). Every *other* gated/throttled route in the same file calls `.allow(client)` first (`ai_ask` `:723-725`, `query_embedding` `:769-771`, `query_embeddings` `:787-789`, `analytics_events` `:658-659`) — `analytics_report` is the sole exception.
- **Attack scenario:** An attacker sends unlimited `GET /api/v1/analytics/report` requests with different `x-analytics-token` header guesses. Nothing slows this down. `FJU_ANALYTICS_ADMIN_TOKEN` is read as a bare string (`web.py:691`) with no length/entropy requirement enforced by the app — an operator who sets a short or memorable token has no guardrail against brute force.
- **Verification / mitigating context:** the token actually configured in this deployment's `.env` is a long, high-entropy random string (confirmed present and gitignored — see §6; value not reproduced in this report). Practical brute-force of *that specific token* is infeasible today. The finding stands as a Medium because the application enforces no minimum token strength and provides no defense-in-depth against a future weaker token, an operator credential-reuse mistake, or the token leaking through an out-of-band channel (screenshots, chat, logs) and then being guessed/replayed indefinitely.
- **Impact:** Successful brute force yields read access to aggregate analytics only — no PII (by the module's own design, see §7) — so blast radius is bounded to operational/competitive information disclosure, not a privacy breach.
- **Remediation:** Apply the existing `RateLimiter` to `analytics_report` before the token check (e.g. 5/min), and consider a short lockout after N consecutive `401`s. Fixing CRS-01 first is a prerequisite for this to be meaningful per-client rather than another shared bucket.

#### CRS-04 — Analytics store has no total-size/row cap, only day-based retention — NEW

- **Severity:** Medium **Confidence:** High
- **CWE / OWASP:** CWE-770
- **Files/lines:** `src/fju_outline/analytics.py` — `AnalyticsStore.record()` (`:668-694`) inserts unconditionally; `maintain()`/`_expire()` (`:725-746`) only deletes rows *older than* the retention windows (180/90/7 days) — no `PRAGMA max_page_count`, row-count ceiling, or DB-file-size check anywhere.
- **Attack scenario:** Sustained flooding of otherwise-valid `POST /api/v1/analytics/events` batches (trivial to construct — allowlisted enums plus any real, publicly-enumerable `course_id`) grows `analytics.sqlite3` without bound for up to 180 days before the oldest rows are ever reclaimed. Today this is incidentally throttled by CRS-01's broken shared limiter (≈2,400 events/min site-wide worst case ≈ 3.5M rows/day) — but that's a coincidental ceiling from a different bug, not a real backstop in the storage layer, and fixing CRS-01 correctly (giving each real client its own budget) would *remove* this incidental cap and multiply the growth rate.
- **Impact:** Disk exhaustion → SQLite write failures / host instability, independent of whatever happens with CRS-01.
- **Remediation:** Add an explicit cap in `maintain()` — refuse new inserts or start evicting oldest rows once `analytics_events` exceeds N rows or the DB file exceeds N MB.

#### CRS-05 — No replay/idempotency protection on analytics events — dashboard metrics can be poisoned — NEW

- **Severity:** Medium **Confidence:** Medium
- **CWE / OWASP:** CWE-345 (Insufficient Verification of Data Authenticity)
- **Files/lines:** `src/fju_outline/analytics.py` — `validate_event`/`validate_batch` (`:376-460`, `:1070-1091`) validate shape/enum membership only; `record()` (`:668-694`) does a plain `executemany` INSERT with an `AUTOINCREMENT` key and no uniqueness constraint over `(session_id, interaction_id, event, course_id, …)`. `_aggregate_day` (`:756-924`) simply `COUNT(*)`/`SUM(*)`s these rows.
- **Attack scenario:** `course_id` only needs to name a real, public catalog entry (`course_exists`, `:447-448`). An attacker crafts one valid `recommendation_impression`/`recommendation_clicked`/`course_added` event for a target course and replays the identical batch repeatedly. Each resend is individually valid, so the dashboard's CTR, adoption-rate, click-to-add, and per-course "訊號" flags (`analytics_dashboard.py:113-121`) can be driven to whatever shape the attacker wants — e.g. manufacturing a fake low-CTR/high-impression flag on a course, or a fake adoption spike. `zero_result_rate`/`search_refinement_rate` are similarly manipulable via replayed `search`/`zero_result` events.
- **Impact:** Integrity of an internal reporting dashboard used to inform product/curation decisions. No PII or account exposure, but an operator reading the dashboard has no way to distinguish real usage from replayed noise.
- **Remediation:** Deduplicate on a per-request idempotency token (not currently in the schema), or cap how many events of a given type a single `session_id` may contribute per day before aggregation; consider a coarse sessions-per-IP-per-day sanity check once CRS-01 is fixed.

#### CRS-06 — Unsafe and unbounded consumption of crawler responses — *carried forward (SEC-004)*

- **Severity:** Medium **Confidence:** Medium
- **CWE / OWASP:** CWE-20, CWE-400; A08:2021; API10:2023
- **Files/lines:** `src/fju_outline/client.py:75,113,126,135,163`; `crawler.py:140`; `normalize.py:31`.
- **Status:** re-confirmed unchanged by this round's code-security-reviewer — responses are still buffered/parsed without a byte cap, redirects are followed without a final-host allowlist, and nested course fields aren't schema-validated before persistence. This is now purely a **build-time/offline-pipeline** risk (the crawler is not reachable from the internet and is not part of the deployed container's runtime attack surface), which is why it remains Medium rather than escalating — but a compromised/malicious upstream or redirect can still poison the artifacts baked into the next image build.
- **Remediation:** unchanged from prior audit — stream with byte limits, allowlist the final host post-redirect, validate `Content-Type`, strict Pydantic schemas with bounded strings/lists and numeric IDs, quarantine invalid records.

#### CRS-07 — Supply-chain inputs remain mutable/unpinned — *carried forward (SEC-005)*

- **Severity:** Medium **Confidence:** High
- **CWE / OWASP:** CWE-829, CWE-1104; A08:2021, A06:2021
- **Files/lines & evidence (re-verified this round):**
  - `.github/workflows/ci.yml:9,10,14,16` — `actions/checkout@v4`, `actions/setup-python@v5`, `pnpm/action-setup@v4`, `actions/setup-node@v4`, all floating major-version tags, no commit-SHA pin, no `permissions:` block (though the workflow currently uses no `secrets.*`, which bounds today's blast radius).
  - `Dockerfile:1` (`FROM node:24.15-alpine`), `:21` (`FROM python:3.11-slim`) — tag-pinned, not digest-pinned.
  - `Dockerfile:27` — `SentenceTransformer('intfloat/multilingual-e5-small')` pulled by name with no `revision=` pin at build time; the committed artifact manifest records an exact model revision, but application startup (`web.py` lifespan, ~`:417-424`) only compares model **name** and embedding **dimension**, not revision — a silent model swap with the same dimension would pass startup checks.
  - `pyproject.toml` — every dependency uses an unbounded `>=` constraint (only `openai<3` and `python-dotenv<2` have ceilings); no `uv.lock`/`poetry.lock`/hash-pinned requirements file exists, so every `pip install .` (Docker build, CI, local dev) can legally resolve to a different graph than the last build. By contrast, `frontend/pnpm-lock.yaml` does this correctly (hash-pinned, `--frozen-lockfile` enforced in both CI and `Dockerfile`).
  - Consequence confirmed by the dependency audit: the floating `pyarrow>=15.0` floor (used only in the optional `pipeline` extra, for `export.py:69`'s **write-only** `to_parquet` call — never reads untrusted Arrow/Parquet input, and the extra is never installed into the production image) legally permits resolving into a version range affected by two historical Apache Arrow advisories (GHSA-rgxp-2hwp-jwgg / PYSEC-2026-113, PYSEC-2024-161). Not reachable in the deployed app today, but the lack of a lockfile is precisely the mechanism that would let it become a live problem without any diff in the repo.
- **Remediation:** pin all four GitHub Actions to commit SHAs (with version comments); pin both `FROM` lines to `@sha256:` digests; pin the HF model `revision=` at build time and compare `model_revision` (not just dimension) at startup; generate and commit a Python lockfile (`uv lock`) and install with `--require-hashes`/`--frozen`; raise the `pyarrow` floor to `>=23.0.1` regardless of current unreachability.

#### CRS-08 — Production container runs as root — *carried forward (SEC-006)*

- **Severity:** Medium **Confidence:** High
- **CWE / OWASP:** CWE-250; A05:2021
- **Files/lines:** `Dockerfile` — no `USER` directive anywhere in the file (confirmed by reading the full file this round, and via `git log -p --follow -- Dockerfile`, which shows a `USER` line was never added in any revision); `CMD` (`:34`) runs `uvicorn` as whatever user the base image defaults to (root).
- **Remediation:** unchanged — create a dedicated non-root UID/GID, `chown` only the writable runtime paths (`/app/data/runtime`), set `USER`, drop Linux capabilities, consider a read-only root filesystem.

---

### 4.3 LOW

#### CRS-09 — Missing browser security headers — *carried forward (SEC-007)*

- **Files/lines:** `src/fju_outline/web.py:454-472` — only `GZipMiddleware` and a request-size-limiting middleware are registered; no CSP, `X-Content-Type-Options`, `X-Frame-Options`/`frame-ancestors`, HSTS, Referrer-Policy, or Permissions-Policy anywhere. Re-confirmed directly this round by reading the full middleware registration block.
- **Remediation:** add a security-headers middleware (or set at the Cloudflare edge); disable `/docs` in production or gate it (see CRS-10).

#### CRS-10 — `/docs`, `/redoc`, `/openapi.json` remain reachable in production — NEW

- **CWE / OWASP:** CWE-200; API9:2023 (Improper Inventory Management)
- **Files/lines:** `src/fju_outline/web.py:432-436` — `FastAPI(...)` never sets `docs_url=None`/`redoc_url=None`/`openapi_url=None`. Reachability confirmed via route-registration-order analysis: FastAPI's built-in doc routes register inside `FastAPI.__init__`, before the SPA catch-all (registered last, in `_mount_frontend`) — Starlette matches in registration order, so `/docs` etc. are served normally, not swallowed by the SPA fallback.
- **Attack scenario:** visiting `/openapi.json` yields the complete route inventory and every request/response schema (field names, `max_length`, numeric ranges for `AIContext`, `QueryEmbeddingsRequest`, etc.) in one request, shortening reconnaissance for the other findings in this report. It does *not* leak the `x-analytics-token` header name (that check is manual, not a FastAPI `Header()` dependency, so it's absent from the schema) — but that header name is already visible in the public `/api/v1/analytics/dashboard` page source regardless, so `/docs` isn't the gating factor for that specific detail.
- **Remediation:** set `docs_url=None, redoc_url=None, openapi_url=None` in production (e.g. behind an env flag defaulting off), or block those three paths at the Cloudflare edge.

#### CRS-11 — Public catalog still aggregates instructor/contact email addresses — *carried forward (SEC-008), re-verified against live data*

- **Files/lines:** `src/fju_outline/artifacts.py`, `web.py:515-526` (`/api/v1/catalog/data`, `/api/v1/catalog/manifest`).
- **Re-verification performed this round:** the prior audit's flat scan for this round initially came back clean and had to be redone — email addresses are embedded inside **nested** free-text fields (syllabus/reference notes), not top-level string fields, so a shallow per-field regex check misses them. A recursive scan of the actual Docker-shipped `data/artifacts/1151/catalog.json` (4,233 records — the directory `Dockerfile:29` `COPY`s into the image and the default `FJU_RECOMMENDER_ARTIFACTS_DIR`) found multiple real email addresses embedded in course reference-material text (format confirmed, e.g. `name@domain.tld`-shaped strings inside syllabus reference lists) — consistent with the prior audit's finding at different course records, confirming the underlying data-minimization gap is still open in the data that actually ships today.
- **Impact:** limited personal-data aggregation/exposure; the source outlines are already public, but a single downloadable catalog file materially simplifies bulk collection.
- **Remediation:** unchanged — apply data minimization when building the public catalog (mask/strip email-shaped substrings from free-text fields at artifact-build time).

#### CRS-12 — Backup import validates only outer shape — *carried forward (SEC-009), impact now more precisely bounded*

- **Files/lines:** `frontend/src/data/db.ts:187-197` (`validateBackup` — checks schema/version tag and that each named key is an array; no per-row size/depth/field validation), `frontend/src/pages/data/DataPage.tsx:90-102` (`readImport` — no file-size check before `file.text()`/`JSON.parse`).
- **What's new this round:** the frontend was substantially rewritten since the prior audit (the old `App.tsx`/`db.ts` call sites cited previously no longer exist in that form). Re-reading the current `DataPage.tsx`/`db.ts` confirms the same class of gap persists, but the adversarial pass also confirmed the **impact ceiling**: a full `frontend/src` grep for `dangerouslySetInnerHTML` returns **zero matches** — every place imported data is rendered uses plain JSX text interpolation (React's default escaping). A malicious backup file therefore cannot achieve XSS through this app; the residual risk is strictly limited to writing malformed/oversized records into the *importing user's own* IndexedDB (self-only, no trust-boundary crossing).
- **Remediation:** unchanged in spirit but lower urgency given the confirmed ceiling — reject oversized files before `file.text()`, validate with a strict versioned schema, cap array/string/nesting sizes, validate course IDs against the catalog.

#### CRS-13 — Insufficient security logging and monitoring — *carried forward (SEC-010)*

- **Files/lines:** `Dockerfile:34` (`--no-access-log`), `rag.py:215` (usage ledger records aggregate calls/tokens only, no rate-limit/abuse-signal events).
- **Remediation:** unchanged — emit structured, privacy-preserving events for rate-limit hits, provider errors, and artifact-integrity failures without logging question/profile text.

#### CRS-14 — AI content-moderation call fails open on its own API error — NEW

- **CWE / OWASP:** CWE-636 (Not Failing Securely)
- **Files/lines:** `src/fju_outline/web.py:944-955`:
  ```python
  def moderate(text: str) -> bool:
      try:
          result = client.moderations.create(model="omni-moderation-latest", input=text)
          ...
      except Exception:  # noqa: BLE001
          return False   # treated as "not flagged" on any moderation-call error
  ```
  Confirmed the flag itself (`FJU_AI_MODERATION_ENABLED`) defaults to **on** (`"1"`) — the issue is narrower than "moderation is off by default"; it's that a transient failure of the moderation *call* (timeout, outage, network blip) silently skips moderation for that request rather than rejecting it or flagging the gap. Confirmed this path is live (not dead code): `rag.py:396-397` calls `self.moderator(query)` on every non-empty-result `ask` invocation.
- **Impact:** Low — the RAG service has no tools/function-calling, output is constrained to a strict schema, and `rag.py` independently post-filters answers for secret patterns and external URLs (`_SECRET_RE`, `_EXTERNAL_URL_RE`) regardless of moderation. A moderation outage risks an unflagged *question* reaching the model, not an unfiltered *answer* reaching the user.
- **Remediation:** log/count each moderation-call error distinctly from a genuine "not flagged" result so operators can see outage windows; consider making moderation a hard gate (503 on error) if that's the intended security posture.

---

## 5. Dependency Vulnerabilities

### Python

42 packages checked directly against the OSV.dev API (exact resolved versions from the local `.venv`, or floor versions for the few declared-but-not-installed packages). **No exploitable CVE confirmed reachable in the deployed application.** One item worth tracking:

| Package | Constraint | Status |
|---|---|---|
| `pyarrow` | `>=15.0` (optional `pipeline` extra) | Floor sits inside GHSA-rgxp-2hwp-jwgg/PYSEC-2026-113 (UAF) and PYSEC-2024-161 (deserialization RCE) ranges, fixed at 23.0.1/17.0.0 respectively. **Not reachable**: used only for a write-only `to_parquet()` call (`export.py:69`), never parses untrusted Arrow/Parquet/IPC input; the `pipeline` extra is never installed into the production Docker image. See CRS-07. |

All other checked packages (FastAPI 0.141.1, numpy 2.5.1, orjson 3.11.9, pydantic 2.13.4, sentence-transformers 5.6.1, uvicorn 0.52.0, torch 2.13.0, transformers 5.14.1, cryptography 50.0.0, requests 2.34.2, and the rest of the resolved dependency graph including `scrapling[fetchers]`'s browser-automation transitive stack) came back **clean**.

### Node / frontend

`pnpm audit` against the full, exactly-resolved 239-package tree (`frontend/pnpm-lock.yaml`): **0 vulnerabilities**. This is a meaningful improvement over the prior audit's dependency state, where `vitest`/`vite`/`esbuild`/`nanoid` carried unresolved Critical/High/Moderate advisories (all dev-server-only, never reachable in production) — those packages have since been upgraded (`vite` 8.2.2, `vitest` 4.1.11) and the advisories no longer apply.

### Containers / OS packages

Base-image/OS-package CVE scanning (Trivy or equivalent) remains **NOT TESTED** — no scanner binary available in this environment. `Dockerfile` uses `node:24.15-alpine` and `python:3.11-slim`, both tag-pinned not digest-pinned (CRS-07).

### CI / build supply chain

Covered under CRS-07 — GitHub Actions and the ML model pull are unpinned/mutable; no exploited instance found, this is a hygiene/exposure-window finding, not a confirmed live compromise.

---

## 6. Secrets Findings

- **`.env` (local, workstation-only):** contains a live-format `OPENAI_API_KEY` and the configured `FJU_ANALYTICS_ADMIN_TOKEN`. Both were read during this audit **solely** to confirm they are not committed to git and to assess the token's entropy for CRS-03 — **neither value is reproduced anywhere in this report, was used for any request, or was sent anywhere.**
- **Git tracking status (verified):** `git ls-files | grep -x '\.env'` returns nothing (not currently tracked); `git log --all --full-history -- .env` returns no commits (never tracked, at any point in history). `.gitignore` correctly excludes `.env` and `.env.*` while explicitly un-ignoring `.env.example` (`.gitignore:7-10`).
- **Tracked-file secret scan:** `git grep` across all tracked files (excluding data/artifact directories, which are large public course-catalog JSON, not secrets) for AWS-key, OpenAI-key, and private-key-header patterns returned **no matches**. One earlier broad grep over `data/` produced a false-positive-looking hit that on inspection was ordinary course-catalog JSON content, not a secret — excluded from findings.
- **Token strength:** the currently configured `FJU_ANALYTICS_ADMIN_TOKEN` is a long, high-entropy random string — good practice, and the reason CRS-03's real-world exploitability is assessed as low today despite the missing rate limit.

### Preventive controls status

| Control | Status |
|---|---|
| `.gitignore` excludes `.env`/`.env.*` | Present |
| `.dockerignore` excludes secrets/`.env`/`.git` | Present (confirmed by IaC review — no `COPY . .` anywhere in `Dockerfile`) |
| Placeholder-only `.env.example` | Present |
| Git-history secret exposure | Not found |
| Pre-commit / CI secret scanner | Missing |

---

## 7. Business Logic & Privacy Findings

Consistent with the prior audit's conclusion, re-verified this round: there is no ownership boundary over course data (all public), so mutating `course_id`, `department`, `grade`, or `semester` in catalog/search requests only changes *which public data* is returned, never crosses into private/another-user data (no IDOR). The live business-logic risk remains entirely in the **AI assistant's eligibility framing** (CRS-02) and, newly, in the **analytics pipeline's abuse resistance** (CRS-03/04/05).

**Privacy:** the new analytics module was specifically designed and independently verified (by two reviewers) to collect no free text, no JSON blobs, no IP addresses, and to null out session/interaction correlation keys after 7 days — a genuine "privacy-first" implementation as documented. This is a security **strength**, not a finding. The instructor-email aggregation issue (CRS-11) is unrelated to the analytics feature — it's inherited public catalog data.

---

## 8. False Positives / Rejected Candidates

| Candidate | Rejection rationale |
|---|---|
| `analytics_report` brute force as High/Critical | Deployed token is high-entropy; realistic exploitability today is low. Kept as Medium for the missing defense-in-depth control, not as an active compromise. |
| `pyarrow` CVE range as a live vulnerability | Write-only usage (`to_parquet`), extra never shipped to the production image. Confirmed unreachable. |
| `course_id`/department/grade mutation as IDOR | All course records are intentionally public; no user/tenant ownership attribute exists to violate. |
| SQL injection anywhere in analytics or catalog code | All analytics writes are parameterized (`executemany` with placeholders); no raw string interpolation into SQL found. |
| CSRF | No cookies or authenticated server-side mutation exists to protect. |
| Permissive CORS | No CORS middleware exists in the codebase at all — cross-origin requests are same-origin-blocked by default, which is stricter than a misconfigured-but-present CORS policy. |
| `course_id` unicode/whitespace/case bypass into analytics | `COURSE_ID_PATTERN = ^[A-Za-z0-9._:-]{1,64}$` (`analytics.py:213`) is ASCII-only, no whitespace permitted; catalog match is exact-string — no bypass surface. |
| Backup-import gap (CRS-12) as an XSS vector | Confirmed zero `dangerouslySetInnerHTML` usages anywhere in `frontend/src`; all rendering goes through React's default-escaping JSX interpolation. |
| SEC-002 (legacy stored XSS) as still open | Confirmed fixed — legacy `web_assets/` deleted in commit `41bc58f`; server fails closed (503) rather than falling back to it. |
| pytest `PermissionError` failures (33) as an application defect | Isolated to `AppData\Local\Temp\pytest-of-*` ACL behavior specific to this Windows audit sandbox; the repo's own CI (`ci.yml`) runs the identical suite on Linux without this class of error. |

---

## 9. Security Strengths

- Pydantic models throughout use `extra="forbid"`, bounded string/list lengths, and range-checked numeric fields (`AIContext`, `AIAskRequest`, analytics event schemas).
- Request bodies are capped (`enforce_request_size` middleware, `web.py:456-472`), including chunked bodies with no `Content-Length`.
- No CORS middleware, no cookies, no server-side sessions — same-origin policy holds by default.
- The new analytics module is a genuinely well-scoped privacy design: enum/bounded fields only, no free text, no JSON blob persisted, PII-key denylist checked before projection, session/interaction IDs nulled after 7 days.
- The admin-token check (`_require_analytics_admin`) fails closed when unset, uses `secrets.compare_digest` (timing-safe), and transports the token via a header (not a URL query string, so it won't land in access logs/referrers/proxy caches).
- AI assistant has no tools/function-calling, `store=False` on the OpenAI call, output-recommendation IDs are re-joined against the server's own catalog (never trusts the model's raw text as a course reference), and answers are independently post-filtered for secret patterns and external URLs.
- Artifact hash/dimension verification is on by default (`FJU_VERIFY_ARTIFACT_HASHES=1`) and actually enforced at load time.
- Docker build is multi-stage; the runtime image contains no Node.js/frontend build tooling, and the ML model is loaded fully offline at runtime (`HF_HUB_OFFLINE=1`).
- `frontend/pnpm-lock.yaml` is properly hash-pinned and installed with `--frozen-lockfile` in both CI and `Dockerfile` — this is the correct pattern the Python side (CRS-07) should be brought up to.
- The legacy stored-XSS vulnerability from the prior audit is confirmed fully remediated, not merely mitigated.
- 170 of the application's own tests pass locally (plus 46 subtests); the repository's CI runs the same suite cleanly on its target platform.

---

## 10. Remediation Priority — P0 / P1 / P2 / P3

### P0 — Immediate

None required to keep the service running safely as-is. However, **CRS-01 should not wait for the next scheduled release** — see §11 for the deployment recommendation. If ever suspecting the `.env` OpenAI key or analytics admin token has left the workstation (chat, screenshot, another repo), rotate it immediately; this audit did not test either credential's live validity or usage.

### P1 — Before/soon after next public exposure change

1. **CRS-01** — Parse `CF-Connecting-IP` for real per-client rate limiting; add a global soft-throttle ahead of the hard monthly AI budget.
2. **CRS-02** — Stop labeling self-asserted eligibility as "confirmed"; extend the fix to cover `study_level`/`division`, not just `grade`/`department`/`completed_course_ids`.
3. **CRS-03** — Rate-limit `/api/v1/analytics/report`.
4. **CRS-08** — Run the container as non-root.

### P2 — Near term

1. **CRS-04** — Add a total-size/row cap to the analytics store.
2. **CRS-05** — Add replay/idempotency protection to analytics event ingestion.
3. **CRS-06** — Bound and schema-validate crawler responses.
4. **CRS-07** — Pin CI Actions (SHA), Docker base images (digest), the HF model revision (and verify it at startup), and add a Python lockfile.
5. **CRS-09 / CRS-10** — Add security headers; disable `/docs`/`/redoc`/`/openapi.json` in production.

### P3 — Ongoing assurance

1. **CRS-11** — Minimize/mask instructor contact data at artifact-build time.
2. **CRS-12** — Add stricter backup-import validation (defense-in-depth; confirmed non-exploitable today).
3. **CRS-13** — Add privacy-preserving security telemetry (rate-limit hits, provider errors) without logging user content.
4. **CRS-14** — Distinguish "moderation errored" from "moderation passed" in logs/metrics.
5. Re-run this audit's dependency/SCA checks periodically as `pyproject.toml` and `pnpm-lock.yaml` evolve; add CI-integrated SCA/secrets scanning once tooling is available in the build environment.

---

## 11. Direct Answer — Is the current version fit to deploy as a public service?

**Conditionally yes — with one fix that should land before or immediately after the next deploy, not treated as routine backlog.**

There is no Critical vulnerability, and the one confirmed High finding (CRS-01) is an **availability/cost-control** gap, not a data-confidentiality or integrity breach — no student data, no private records, no cross-user access is at risk, because the system has no accounts and the course catalog is intentionally public. The application can be deployed or continue running as-is without exposing anyone's private data.

However, deploying (or continuing to run) it in its current state means the AI assistant feature is one persistent user away from a full-month outage and a burned OpenAI budget, because the rate limiter cannot actually distinguish clients behind the deployed Cloudflare Tunnel. **Recommendation: fix CRS-01 (or at minimum, add the global soft-throttle ahead of the monthly ledger) before or immediately alongside the next production deploy**, and treat CRS-03/CRS-08 as fast-follow within the same release window. The remaining Medium/Low findings (CRS-02, 04–07, 09–14) are appropriate for the normal P2/P3 cadence and do not block a public launch or continued operation.

## 12. 直接回答（中文）— 目前版本是否適合直接部署為公開服務

**有條件地適合 — 但有一項修復不應排入例行 backlog，應在下次部署前後儘快處理。**

本次稽核沒有發現 Critical 等級漏洞。唯一確認的 High 等級問題（CRS-01：所有速率限制器共用同一把 key，因為正式環境的 Cloudflare Tunnel 架構讓每一位真實訪客的 `request.client.host` 都相同）屬於**可用性／成本控管**問題，不是資料外洩或跨使用者存取問題 — 系統本身沒有帳號機制，課程目錄本來就是公開資料，因此本問題不會造成任何學生隱私或私有資料外洩。系統可以維持現狀部署，不會因此洩漏任何人的私有資料。

但在目前狀態下，AI 小幫手功能距離「被單一使用者一整個月打到額度歸零」只差一個持續發送請求的瀏覽器分頁，因為速率限制器在目前部署架構下實際上無法區分不同使用者。**建議：在下次部署前或同一個發布窗口內修復 CRS-01（至少先在每月硬上限前加入全域軟性節流），並將 CRS-03、CRS-08 視為同批次的快速跟進項目。** 其餘 Medium/Low 等級問題（CRS-02、04–07、09–14）可依正常 P2/P3 節奏處理，不構成公開上線或持續營運的阻斷條件。

---

## Appendix: Raw specialist-agent reports

Full detail from each individual review pass (including items superseded, merged, or reframed in the consolidated findings above) is retained for reference in the git-ignored audit workspace:

- `tmp/security-audit-2026-08-26/01-code-security-reviewer.md`
- `tmp/security-audit-2026-08-26/02-dependency-auditor.md`
- `tmp/security-audit-2026-08-26/03-api-security-reviewer.md`
- `tmp/security-audit-2026-08-26/04-iac-supplychain-reviewer.md`
- `tmp/security-audit-2026-08-26/05-adversarial-second-pass.md`

These are excluded from version control (`tmp/` is gitignored) and are working notes, not the final record — this file (`SECURITY_AUDIT.md`) is the authoritative report.
