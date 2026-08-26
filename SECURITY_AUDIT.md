# Security Audit Report — Course Recommander System

**Audit date:** 2026-08-24  
**Repository revision:** `893dd45e7ebeeaeb90e587eb6d899f9ce5b7048a` (`main`)  
**Audit type:** Full-repository source, dependency, secrets, configuration, and safe local dynamic review  
**Production code changes:** None

## 1. Executive Summary

This audit found **no confirmed Critical or High production vulnerability**. Ten confirmed findings remain: **6 Medium and 4 Low**. The most important risks are abuse of unauthenticated cost-bearing AI/embedding endpoints, a stored-XSS path in the legacy frontend fallback, reliance on client-asserted eligibility facts, insufficient validation of crawler responses, unpinned supply-chain inputs, and execution of the production container as root.

The application has a comparatively small server-side attack surface and does not store user accounts, passwords, sessions, or server-side student profiles. SQL injection, command injection, SSRF from web requests, path traversal, BOLA/IDOR, CSRF, permissive CORS, and unsafe deserialization were specifically investigated and were not confirmed. The official catalog is public, so changing `course_id` or search filters does not cross an ownership boundary. However, changing the AI request's `grade` or claimed completed courses can change `blocked_confirmed` to `eligible_confirmed`; the official enrollment system remains the final enforcement point, but the recommender can still give a materially incorrect eligibility signal.

Overall risk is **Medium**. There is no P0 emergency, but P1 work should protect costly compute/provider calls, remove the legacy inline-handler XSS, stop presenting unverified profile assertions as confirmed eligibility, and harden the crawler/supply chain.

### Findings Summary

| ID | Severity | Confidence | Finding | Priority |
|---|---|---:|---|---|
| SEC-001 | Medium | High | Public AI and embedding endpoints can be abused for cost/compute exhaustion | P1 |
| SEC-002 | Medium | High | Untrusted `course_id` reaches an inline JavaScript handler in the legacy fallback | P1 |
| SEC-003 | Medium | High | Client-asserted eligibility facts can flip blocked courses to eligible | P1 |
| SEC-004 | Medium | Medium | Crawler buffers and trusts redirected third-party JSON without size/schema/host controls | P1 |
| SEC-005 | Medium | High | CI actions, container bases, Python resolution, and model download are not integrity-pinned | P1 |
| SEC-006 | Medium | High | Production container runs as root | P1 |
| SEC-007 | Low | High | Browser security headers are absent and interactive API docs remain enabled | P2 |
| SEC-008 | Low | High | Full public catalog aggregates instructor email addresses from course text | P2 |
| SEC-009 | Low | High | JSON backup import lacks file-size, depth, row-count, and field-schema limits | P2 |
| SEC-010 | Low | High | Security monitoring is minimal and production access logging is disabled | P2 |

| Severity | Count |
|---|---:|
| Critical | 0 |
| High | 0 |
| Medium | 6 |
| Low | 4 |

## 2. Architecture / Threat Model

### System and data flow

```text
FJU Outline API (untrusted external data)
        |
        v
offline crawler -> raw/canonical JSON -> artifact builder + embedding model
                                            |
                                            v
Browser <---- static React/legacy UI ---- FastAPI ---- local catalog/embeddings
   |                                      |
   v                                      v
IndexedDB (profile, history, plans)      OpenAI API (AI assistant only)
```

### Trust boundaries

1. **Internet client → FastAPI:** all URL, query, JSON body, headers, IDs, profile facts, and request history are attacker-controlled.
2. **FJU API → crawler/build pipeline:** TLS provides transport protection, but every returned field remains untrusted content. A compromised upstream or redirect can poison artifacts.
3. **Artifacts → application/model:** hashes detect accidental or single-file changes, but the manifest is not signed and is stored beside the artifacts.
4. **Browser → IndexedDB:** student profile, completed courses, favorites, and schedules are local plaintext data accessible to same-origin script.
5. **FastAPI → OpenAI:** user question, study context, course IDs, and retrieved course text cross an external-service boundary after explicit UI consent.
6. **GitHub Actions / registries / base images / Hugging Face → build:** third-party code and model assets enter the build pipeline.

### Assets and threat actors

- **Assets:** OpenAI credential and budget, service availability, recommendation/eligibility integrity, student-local planning data, instructor contact data, build/release integrity.
- **Threat actors:** anonymous internet users, distributed automation/bots, a malicious or compromised course-data source, a compromised package/action/image/model publisher, and a malicious backup file sender.
- **Authentication model:** none. Course data is intentionally public. There are no user roles, tenants, server-side accounts, cookies, or session tokens.

### API inventory

The application defines 21 application routes plus FastAPI's default `/docs`, `/redoc`, and `/openapi.json`. Public routes cover health, catalog/facets/departments, individual and batch course lookup, embeddings, AI assistant, query-route artifacts, and legacy `/api/*` compatibility endpoints. No admin or mutation endpoint for server-side user data exists.

### OWASP coverage conclusion

| Category | Result |
|---|---|
| OWASP A01 / API1 / API5 — Access control, BOLA, BFLA | No ownership boundary exists for public courses; no confirmed IDOR. SEC-003 covers decision-integrity trust instead. |
| A02 — Cryptographic failures | No application cryptography/password storage. TLS termination and HSTS deployment configuration were not present in-repo. |
| A03 — Injection | SEC-002 confirmed in legacy UI. SQLi, command injection, SSTI, and server-side header injection not confirmed. |
| A04 / API4 / API6 — Insecure design/resource/business flow | SEC-001 and SEC-003 confirmed. |
| A05 / API8 — Misconfiguration | SEC-006 and SEC-007 confirmed. CORS is not permissive. |
| A06 — Vulnerable components | Node advisories exist but are dev/build paths; see Dependency Vulnerabilities. Python runtime resolution had no known CVE. |
| A07 / API2 — Authentication failures | No user authentication exists or is required for public catalog data; SEC-001 applies to the cost-bearing endpoint. |
| A08 / API10 — Integrity/unsafe API consumption | SEC-004 and SEC-005 confirmed. No unsafe `pickle`/YAML/XML deserialization found. |
| A09 — Logging/monitoring | SEC-010 confirmed. |
| A10 / API7 — SSRF | No web endpoint accepts a URL. The crawler target is configured by an operator, not a remote web client. |

## 3. Tools & Skills Used

### OWASP Secure Agent Playbook

The requested skills were not installed locally. The playbook was cloned from `https://github.com/OWASP/secure-agent-playbook` into an ignored local audit directory, and the corresponding `SKILL.md`, `plays/`, and report/finding templates were read and followed:

- `code-review-security`
- `web-security-review`
- `api-security-review`
- `sca-audit`
- `secrets-scan`
- `iac-security-review`

### Automated and manual tools

| Tool | Scope | Result |
|---|---|---|
| Semgrep 1.174.0 | 260 local OWASP/Python/TypeScript/YAML/Docker rules, 56 tracked files | 5 findings; four mutable CI action tags and one root container, all manually validated |
| Bandit 1.9.4 | Python SAST | 2 scanner findings; both rejected after source tracing |
| detect-secrets 1.5.0 + masked manual patterns | Current sensitive files and tracked source | One live-format token in ignored `.env`; no tracked/history exposure; one catalog false positive |
| Git history scan | All 13 commits, high-confidence token/private-key patterns | No matching secret exposure |
| pnpm audit | Exact `pnpm-lock.yaml`, 229 dependencies | 1 Critical, 2 High, 3 Moderate upstream advisories; none confirmed reachable in production runtime |
| pip-audit 2.10.1 | Fresh resolution of 55 Python production dependencies | No known vulnerability |
| pytest | Full repository test suite | 62 passed |
| FastAPI TestClient / custom localhost-safe checks | Headers, CORS preflight, traversal, body size, AI rate limit | Confirmed findings and rejected candidates documented below |
| jsdom | HTML parsing of legacy inline handler | Confirmed entity-decoding produces attacker-controlled JavaScript handler text |
| Manual source/data-flow review | All tracked source, Dockerfile, CI, manifests, data/import paths, business logic | Two-pass review completed |

### NOT TESTED

- **OWASP ZAP DAST:** NOT TESTED — ZAP was unavailable. No production/third-party target was contacted. Equivalent non-destructive checks were run in-process against the local ASGI app only.
- **Trivy/OSV-Scanner/container image CVEs:** NOT TESTED — binaries and Docker engine were unavailable. Package ecosystems were covered with pnpm audit and pip-audit, but OS packages/base-image layers were not scanned.
- **Gitleaks/TruffleHog:** NOT TESTED — unavailable. detect-secrets plus a masked current-tree and all-commit pattern scan was used instead.
- **Cloud/TLS/reverse proxy/WAF:** NOT TESTED — no deployment manifests, ingress, certificate, or cloud configuration were present.
- **Live credential validity:** NOT TESTED by design; no discovered credential was used.
- **Destructive DoS and production testing:** NOT TESTED by safety requirement.

## 4. Critical Findings

No confirmed Critical finding.

The Critical Vitest advisory reported by pnpm is not reachable in the deployed container: the vulnerable UI server is not started (`vitest run` is used), and the final Python image contains no Node runtime or frontend development server. It remains an upgrade item, not a confirmed Critical production vulnerability.

## 5. High Findings

No confirmed High finding.

All scanner-reported High/Critical candidates were traced for input control, reachability, protection, and deployment context. Results are recorded under Dependency Vulnerabilities and False Positives / Rejected Findings.

## 6. Medium Findings

### SEC-001 — Public cost-bearing and CPU-heavy endpoints can be exhausted

- **Severity:** Medium
- **Confidence:** High
- **CWE / OWASP mapping:** CWE-799, CWE-400; OWASP A04:2021; OWASP API4:2023 Unrestricted Resource Consumption; API6:2023
- **File + line:** `src/fju_outline/web.py:239`, `src/fju_outline/web.py:300`, `src/fju_outline/web.py:489`, `src/fju_outline/web.py:523`, `src/fju_outline/rag.py:242`, `Dockerfile:21`
- **Evidence:** The AI and embedding endpoints require no authenticated identity or client entitlement. Limits are process-local dictionaries keyed only by client IP (10 AI or 30 embedding requests/minute by default). The persistent ledger limits monthly AI calls globally, but every accepted call reserves quota before provider completion. A local test produced ten `200` responses followed by one `429`, confirming a single-IP limit but no caller authorization/global distributed throttle. Limiter keys are never removed from `_events`.
- **Attack scenario:** A botnet or rotating proxy pool sends valid course questions and embedding requests. It bypasses per-IP limits, drains the global provider allowance, consumes CPU/model inference, grows the in-memory key map, and denies legitimate students. Restarts clear per-process limits. A reverse-proxy trust mistake can alternatively collapse all clients to one key, allowing one user to consume the shared minute window.
- **Impact:** Provider cost up to the configured monthly cap, premature monthly quota exhaustion, CPU/thread-pool saturation, memory growth, and application availability loss. README estimates make the financial ceiling limited, which keeps this below High.
- **Recommended fix:** Require a server-verified user/session or scoped short-lived client token for `/api/v1/ai/ask`; add shared Redis/API-gateway limits per identity and IP, global concurrency caps, timeouts, and provider project budgets. Put embeddings behind a shared token or cache common queries. Expire empty limiter keys and reject requests at the edge before model work.
- **Verification method:** From two simulated identities/IPs, verify per-user, per-IP, global concurrency, and monthly caps; restart and scale to two workers and confirm counters remain shared; load test safely in staging and verify `429` occurs before provider/model execution.

### SEC-002 — Stored XSS in legacy fallback through inline `course_id`

- **Severity:** Medium
- **Confidence:** High
- **CWE / OWASP mapping:** CWE-79; OWASP A03:2021 Injection; API10:2023 Unsafe Consumption of APIs
- **File + line:** `src/fju_outline/web_assets/app.js:102`, `src/fju_outline/web_assets/app.js:120`, `src/fju_outline/normalize.py:188`, `src/fju_outline/web.py:628`
- **Evidence:** The legacy UI concatenates crawler-derived `row.course_id` into `onclick="openDetail('...')"`. Its `html()` encoder converts `'` to `&#039;`, but HTML parsing decodes the entity before compiling the event handler. A local jsdom proof parsed the safe, non-destructive test value into `openDetail('');globalThis.auditMarker=1;//')`. Normalization converts upstream `jonCouSn` with `str()` but does not require digits. The fallback is selected whenever `frontend/dist/index.html` is absent, which is the current source checkout/default CLI state; the Docker build does include the React distribution and is not affected.
- **Attack scenario:** A compromised or malicious course-data response supplies a crafted `jonCouSn`. The artifact is later served by a source/legacy deployment. When a user loads the course table, the inline handler is injected; a click executes attacker JavaScript in the application origin.
- **Impact:** Read/modify IndexedDB profile, completed-course and schedule data; issue same-origin AI requests; alter recommendations; and exfiltrate local planning data. Exploitation requires poisoned upstream/artifact data and the legacy fallback, so the production-Docker condition lowers severity from High.
- **Recommended fix:** Remove inline event attributes entirely. Render with DOM APIs, assign `textContent`, and attach `addEventListener` closures that capture the ID. Validate `jonCouSn`/`course_id` against the official numeric format during ingestion and artifact validation. Prefer failing startup when the production React build is missing instead of silently serving legacy assets. Add a CSP that disallows inline scripts.
- **Verification method:** Add a regression fixture whose ID is `');globalThis.auditMarker=1;//`; render the legacy table in jsdom/browser and assert no handler text or marker execution exists. Confirm ingestion rejects non-numeric IDs and production startup fails without the intended frontend bundle.

### SEC-003 — Client-asserted eligibility state can change blocked courses to eligible

- **Severity:** Medium
- **Confidence:** High
- **CWE / OWASP mapping:** CWE-807; OWASP A04:2021 Insecure Design; OWASP API3:2023 Broken Object Property Level Authorization (trust in client properties)
- **File + line:** `frontend/src/App.tsx:832`, `src/fju_outline/rag.py:106`, `src/fju_outline/rag.py:136`, `src/fju_outline/rag.py:371`, `src/fju_outline/eligibility.py:247`
- **Evidence:** `grade`, department/division/study level, completed course IDs, and schedule IDs are accepted from the request and used as facts in server-side eligibility filtering. Pydantic validates shape/range but not truth. Against the real catalog, changing grade from 1 to 7 changed course `741560` from `blocked_confirmed` to `eligible_confirmed`; claiming the prerequisite for course `741704` changed it from `blocked_confirmed` to `eligible_confirmed`.
- **Attack scenario:** A caller edits `/api/v1/ai/ask`, supplies a higher grade/different department, or claims prerequisite IDs. The server filters and prompts on those false assertions and can return the course without the original restriction warning.
- **Impact:** Incorrect academic-planning advice and overconfident `eligible_confirmed` status. It does **not** enroll the student, access another user, or bypass the university enrollment system; the UI disclaimer reduces but does not eliminate decision-integrity impact.
- **Recommended fix:** Rename outcomes based on self-reported data to `eligible_based_on_profile` rather than `eligible_confirmed`. Preserve and always display official restriction evidence. If authoritative qualification is a product requirement, authenticate with the university and derive department, grade, semester, and completed courses server-side. Bind server-verified facts to a signed session; keep user preferences separate from authoritative attributes.
- **Verification method:** Repeat the two mutation tests and verify unverified requests can never receive `eligible_confirmed`; verify official rule evidence remains visible regardless of supplied profile values; if SSO is added, test mismatched request properties are ignored/rejected.

### SEC-004 — Unsafe and unbounded consumption of crawler responses

- **Severity:** Medium
- **Confidence:** Medium
- **CWE / OWASP mapping:** CWE-20, CWE-400; OWASP A08:2021 Software and Data Integrity Failures; OWASP API10:2023 Unsafe Consumption of APIs
- **File + line:** `src/fju_outline/client.py:75`, `src/fju_outline/client.py:113`, `src/fju_outline/client.py:126`, `src/fju_outline/client.py:135`, `src/fju_outline/client.py:163`, `src/fju_outline/crawler.py:140`, `src/fju_outline/normalize.py:31`
- **Evidence:** All transports buffer and parse the complete response without a byte cap. `httpx` follows redirects, but final scheme/host is not allowlisted. Only the top-level result is required to be a dictionary; nested course fields, list lengths, types, and string lengths are not schema-validated before persistence and artifact generation. SEC-002 demonstrates one concrete downstream sink.
- **Attack scenario:** A compromised upstream, malicious redirect, or unexpected official response returns a very large JSON document or poisoned nested fields. The crawler exhausts memory/disk, generates oversized artifacts, poisons model input, or feeds the legacy XSS sink.
- **Impact:** Offline pipeline/build denial of service, corrupted recommendations, stored content injection, and untrusted data sent to the model. The fixed HTTPS origin and need for upstream compromise reduce confidence/exploitability.
- **Recommended fix:** Stream responses with strict compressed/decompressed byte limits; require HTTPS and allowlist the final host after every redirect (or disable redirects); validate `Content-Type`; define strict Pydantic schemas with numeric IDs, bounded strings/lists, and allowed enum/range values; quarantine invalid records; record provenance; sanitize only at the correct output sink rather than treating crawler data as trusted.
- **Verification method:** Use a local mock upstream to return oversized bodies, wrong content type, off-host redirects, invalid IDs, deep JSON, long strings, and prompt/XSS payloads. Confirm requests abort early, invalid records are quarantined, and no artifact is generated from rejected data.

### SEC-005 — Build and CI supply-chain inputs are mutable

- **Severity:** Medium
- **Confidence:** High
- **CWE / OWASP mapping:** CWE-829, CWE-1104; OWASP A08:2021 Software and Data Integrity Failures; OWASP A06:2021
- **File + line:** `.github/workflows/ci.yml:9`, `.github/workflows/ci.yml:10`, `.github/workflows/ci.yml:14`, `.github/workflows/ci.yml:16`, `Dockerfile:1`, `Dockerfile:8`, `Dockerfile:11`, `Dockerfile:14`, `pyproject.toml:11`
- **Evidence:** Four GitHub Actions use mutable major tags rather than full commit SHAs. Base images use mutable tags, Python production dependencies have ranges and no lock/hash file, and the Hugging Face model is downloaded by name without an explicit revision/digest. The artifact manifest records a model revision, but startup compares model name and vector dimension, not model revision. Semgrep independently flagged all four action references.
- **Attack scenario:** An action tag, image tag, public package resolution, or model repository is compromised/repointed. A clean rebuild pulls different code/assets, potentially executing attacker code during CI/build or silently changing model semantics while retaining the same dimension.
- **Impact:** CI credential/repository exposure subject to token permissions, compromised release image, arbitrary build execution, or recommendation integrity loss.
- **Recommended fix:** Pin actions and base images by immutable SHA/digest; add explicit `permissions: contents: read`; create a hash-locked Python requirements file (or lock tool output) and use `--require-hashes`; pin the model revision and verify expected files/digests; compare runtime `model_revision` to the manifest; generate an SBOM and sign image/artifact provenance; add Dependabot/Renovate and CI SCA/secrets scanning.
- **Verification method:** Build twice from the same commit in clean environments and compare SBOM/image/artifact digests. Confirm all external references are immutable and a mismatched model revision fails startup.

### SEC-006 — Production container runs as root

- **Severity:** Medium
- **Confidence:** High
- **CWE / OWASP mapping:** CWE-250; OWASP A05:2021 Security Misconfiguration
- **File + line:** `Dockerfile:8`, `Dockerfile:21`
- **Evidence:** The final image never declares `USER`; Semgrep confirmed the last process runs as root. The application also creates the runtime SQLite directory/file.
- **Attack scenario:** A future FastAPI, native ML library, parser, or application exploit gains code execution. The payload runs as container root and can modify application/model/catalog files and any mounted writable volume, increasing escape/post-exploitation opportunities.
- **Impact:** Larger blast radius inside the container and on mounted storage. No current RCE was found, so this is defense-in-depth rather than a direct root compromise.
- **Recommended fix:** Create a dedicated non-root UID/GID, pre-create and `chown` only `/app/data/runtime`, keep source/artifacts/model cache read-only, set `USER`, drop Linux capabilities, use a read-only root filesystem and tmpfs where deployment supports it, and apply memory/CPU/PID limits.
- **Verification method:** Run the image and assert UID is non-zero; confirm the app can write only the usage database; attempt writes to `/app/src`, catalog, and model cache and verify failure.

## 7. Low Findings

### SEC-007 — Missing browser security headers and exposed interactive docs

- **Severity:** Low
- **Confidence:** High
- **CWE / OWASP mapping:** CWE-693, CWE-1021; OWASP A05:2021; OWASP API8:2023
- **File + line:** `src/fju_outline/web.py:291`, `src/fju_outline/web.py:305`
- **Evidence:** Local responses lacked CSP, `X-Content-Type-Options`, `X-Frame-Options`/`frame-ancestors`, HSTS, Referrer-Policy, and Permissions-Policy. `/docs` and `/openapi.json` returned `200`. No in-repo reverse proxy adds them.
- **Attack scenario:** Clickjacking or a future injection flaw has fewer browser mitigations; public interactive docs simplify endpoint discovery and invocation.
- **Impact:** Defense-in-depth loss. No authenticated action/cookie exists, and absent CORS blocked the tested hostile preflight (`405` with no ACAO), limiting direct impact.
- **Recommended fix:** Add a tested security-header middleware or enforce headers at the ingress. Use a nonce/hash CSP with no inline script; set `frame-ancestors 'none'`, `nosniff`, strict referrer/permissions policies, and HSTS only at a confirmed HTTPS boundary. Disable docs/schema in production or explicitly accept the exposure.
- **Verification method:** Automated response-header tests for HTML, JSON, static, error, and redirect responses; browser CSP report-only rollout before enforcement; confirm docs are disabled or authenticated in production.

### SEC-008 — Public catalog aggregates instructor email addresses

- **Severity:** Low
- **Confidence:** High
- **CWE / OWASP mapping:** CWE-359; OWASP A01:2021 Data Exposure / Broken Access Control
- **File + line:** `src/fju_outline/artifacts.py:308`, `src/fju_outline/web.py:366`
- **Evidence:** The 19.3 MB catalog is downloadable as one public response. A masked data scan found email-shaped content in three course records (`742432`, `742604`, `744402`) inside published course sections. The source outlines are public, but aggregation materially simplifies bulk collection.
- **Attack scenario:** A scraper downloads one file and extracts instructor contact addresses for spam, phishing, or profiling.
- **Impact:** Limited personal-data aggregation/exposure. Existing public source availability lowers severity.
- **Recommended fix:** Apply data minimization when building the public catalog: omit or mask email addresses/contact strings unless required for the recommender. Document source, purpose, retention, and contact/removal process; consider robots/rate/CDN controls while recognizing they do not replace minimization.
- **Verification method:** Scan generated catalog fields for email/phone patterns and manually review exceptions; assert only explicitly approved contact fields survive artifact generation.

### SEC-009 — Backup import validates only the outer shape

- **Severity:** Low
- **Confidence:** High
- **CWE / OWASP mapping:** CWE-20, CWE-400; OWASP A04:2021
- **File + line:** `frontend/src/db.ts:122`, `frontend/src/db.ts:134`, `frontend/src/App.tsx:1115`
- **Evidence:** The browser reads the entire selected file and synchronously `JSON.parse`s it. Validation checks schema/version and six array types only. It imposes no file bytes, nesting depth, row count, allowed nested fields, string lengths, ID formats, or extra-key rejection before writing rows to IndexedDB.
- **Attack scenario:** A user is socially engineered into importing an oversized or malformed backup. It freezes/crashes the tab, exhausts local quota, or poisons local profile/schedule data later used in recommendations.
- **Impact:** Local-only availability and recommendation-integrity loss; React output encoding prevents the reviewed values from becoming direct HTML execution.
- **Recommended fix:** Reject files above a small documented limit before `file.text()`, validate with a strict versioned schema, cap arrays/strings/nesting, reject extra stores/fields, validate course IDs against the catalog, and apply the import in a single transaction after preview.
- **Verification method:** Unit/fuzz tests for oversized, deeply nested, extra-key, wrong-type, huge-array, invalid-ID, and quota-exhaustion fixtures; assert no partial writes occur.

### SEC-010 — Insufficient security logging and monitoring

- **Severity:** Low
- **Confidence:** High
- **CWE / OWASP mapping:** CWE-778; OWASP A09:2021 Security Logging and Monitoring Failures
- **File + line:** `Dockerfile:21`, `src/fju_outline/rag.py:215`, `src/fju_outline/web.py:489`
- **Evidence:** Production explicitly uses `--no-access-log`. The usage ledger records monthly aggregate calls/tokens/success/failure but no rate-limit events, abuse signals, latency, request correlation, or security alerts. There is no documented monitoring/incident response pipeline.
- **Attack scenario:** Distributed AI/embedding abuse, repeated invalid payloads, crawler poisoning, or endpoint probing occurs without actionable detection until quota or service failure is noticed.
- **Impact:** Delayed response and weak forensic capability. Avoiding request text is a positive privacy choice and should remain.
- **Recommended fix:** Emit structured, privacy-preserving events for request ID, endpoint class, status, latency, rate-limit result, hashed/truncated network identifier, provider errors, quota thresholds, crawler schema rejects, and artifact integrity failures. Never log question text, profile data, tokens, or raw course contact data. Add alerts and retention/access controls.
- **Verification method:** Trigger safe synthetic `413`, `422`, `429`, provider failure, artifact mismatch, and crawler reject events; verify structured records/alerts appear without secrets or user content.

## 8. Dependency Vulnerabilities

### Node / pnpm

`pnpm audit` scanned 229 exact locked dependencies and reported the following upstream advisories:

| Package | Locked version | Advisory | Upstream severity | Fixed version | Reachability / effective assessment |
|---|---:|---|---|---|---|
| vitest | 2.1.9 | GHSA-5xrq-8626-4rwp | Critical | >=3.2.6 | Vulnerable UI server not started; `vitest run` only; absent from final image. Rejected as production Critical; upgrade P2. |
| vite | 5.4.21 | GHSA-fx2h-pf6j-xcff | High | >=6.4.3 | Windows dev-server path traversal; not in final runtime. Potential developer-environment exposure; upgrade P1/P2. |
| nanoid | 3.3.16 | GHSA-2v37-7h3g-55p8 | High | >=3.3.18 | Transitive build dependency; vulnerable custom zero-size generator not used by repository. Rejected as reachable. |
| vite | 5.4.21 | GHSA-v6wh-96g9-6wx3 | Moderate | >=6.4.3 | Windows dev-server launch-editor path; no production server. |
| vite | 5.4.21 | GHSA-4w7w-66w2-5vf9 | Moderate | >=6.4.2 | Optimized-deps source-map traversal in dev server; no production server. |
| esbuild | 0.21.5 | GHSA-67mh-4wv8-2f99 | Moderate | >=0.24.3 | Dev server cross-origin read; no production server. |

Update Vite, Vitest, and their transitive lockfile resolution, then rerun build/tests/audit. Keep development servers loopback-only and do not expose them to untrusted networks.

### Python

A fresh audit-time resolution of the eight production dependency constraints produced **55 packages and no known vulnerability**. This is a point-in-time result, not reproducible assurance, because `pyproject.toml` has broad minimum ranges and no production lock/hashes. The local audit virtual environment's old `pip` had advisories, but `pip` is a build tool rather than an application dependency and that environment is not the production image. Upgrade the image's pip before installs and pin/hash the resolved graph.

### Containers and OS packages

Base image and OS-package CVEs are **NOT TESTED** because Docker/Trivy were unavailable. Add Trivy (or equivalent) against the built image and SBOM in CI, and pin remediated base image digests.

## 9. Secrets Findings

### Current tree and history

- detect-secrets found one OpenAI-token-shaped value at `.env:3`. It is reported only as `OpenAI token: ****` and was never printed or used.
- `.env` is not tracked, has no commit history, and is excluded by both `.gitignore` and `.dockerignore`.
- A masked high-confidence scan across all 13 commits found no AWS/OpenAI/Anthropic/GitHub/Slack/private-key pattern outside the rejected catalog match.
- Activity/permissions of the local token are **NOT TESTED** by safety requirement.

This is not a committed hardcoded-secret vulnerability. Keep the file workstation-restricted, prefer an OS/container secret manager for deployment, and rotate the token if it has ever been copied to logs, chat, backups, screenshots, or another repository.

### Preventive controls

| Control | Status |
|---|---|
| `.gitignore` excludes `.env` / `.env.*` | Present |
| `.dockerignore` excludes `.env` / `.env.*` | Present |
| Placeholder-only `.env.example` | Present |
| Git-history secret exposure | Not found |
| Pre-commit secret scanner | Missing |
| CI secret scanner | Missing |
| Gitleaks/detect-secrets allowlist config | Missing |
| External deployment secret manager documentation | Missing |

## 10. Business Logic Findings

SEC-003 is the primary business-logic issue. Adversarial tests specifically modified fields requested in scope:

| Mutation | Result |
|---|---|
| `course_id` on GET/batch | Returns another public course or 404/missing; no private object boundary, so not IDOR. |
| `department` / `grade` on search | Changes public filtering only; does not grant enrollment or protected access. |
| `grade` in AI context | Confirmed ability to flip a real course from blocked to eligible (SEC-003). |
| claimed completed course IDs | Confirmed ability to satisfy a real prerequisite in eligibility evaluation (SEC-003). |
| `semester` / academic year | No selectable server-side dataset parameter; the server loads one configured artifact directory. Mutation cannot switch to protected data. |
| frontend schedule/conflict/eligibility state | Can be edited locally, but affects only that browser's planning data; official enrollment remains outside the system. |

Additional strengths include server re-fetch/allowlisting of recommended course IDs, rejection of unknown JSON fields, output recommendation IDs restricted to retrieved candidates, server-side hard-constraint checks, and explicit UI warnings that official enrollment data is authoritative.

## 11. Privacy Findings

- **Local data:** profile, completed courses, favorites, dismissals, and schedules are plaintext IndexedDB records. This is consistent with the disclosed local-first design, but same-origin XSS (especially SEC-002) can read them. There is a clear-data feature and JSON export/import.
- **AI transfer:** the consent screen explicitly states that question, study context, preferred weekdays, and completed/scheduled course IDs go to the server and OpenAI. `store=False` is set on the API request, and the local ledger deliberately avoids request text.
- **Catalog:** SEC-008 covers instructor email aggregation. The catalog contains no student records or account credentials.
- **Logging:** avoiding question/profile content in logs is a strength; SEC-010 recommends metadata-only monitoring.
- **Recommended privacy actions:** publish a concise retention/data-flow notice, minimize public contact data, make AI consent revocable/inspectable, and document browser data lifetime and shared-device risk.

## 12. False Positives / Rejected Findings

| Candidate | Rejection rationale |
|---|---|
| Bandit B608 SQL injection at `rag.py:264` | The interpolated column is selected only by internal boolean (`completed` or `failed`); all values/month are parameterized. Attacker cannot control SQL syntax. |
| Bandit B310 URL open at `client.py:163` | No web request reaches this code. Endpoint names are constants and base URL is fixed by default/operator-controlled CLI construction. No remote SSRF path exists. SEC-004 separately covers redirect/response trust. |
| Encoded path traversal `/%2e%2e/Dockerfile` | Safe local request returned the SPA page, not the file. Static candidate is checked to remain under the resolved static directory before FileResponse. |
| `course_id` enumeration / batch lookup as IDOR | All course records are intentionally public and there is no user/tenant ownership attribute. |
| SQL injection in course search | Search is an in-memory comparison; no attacker-provided SQL is constructed. SQLite usage uses parameters. |
| Command injection | No subprocess/shell execution sink exists in application code. |
| Web SSRF | No API accepts a URL or makes a caller-selected outbound request. |
| CSRF | No cookies/authenticated server mutation exists. Cross-origin JSON preflight received `405` and no ACAO header. |
| Permissive CORS | No CORS middleware/header was present; hostile origin was not allowed. |
| Current catalog `sk-...` token match | The 28-character match occurs inside public course content (`course_id 751270`), not a valid configured OpenAI credential; rejected without publishing the string. |
| pnpm Critical/High as production RCE/file read | Vite/Vitest development servers are not started and Node is absent from the final runtime image. Retained as dependency maintenance risk. |
| Missing authentication on course routes | Public catalog is the intended data classification. Authentication is required only if future endpoints add private/server-side user data. |
| Modified semester/year bypass | No request property chooses the loaded artifact set; one operator-configured dataset is used. |

## 13. Security Strengths

- Pydantic request models use `extra="forbid"`, bounded strings/lists, type/range checks, and normalized text.
- Request bodies are capped at 16 KiB, including chunked bodies without `Content-Length`; pagination is capped at 100.
- Same-origin policy is retained; no permissive CORS or credentialed wildcard exists.
- React renders crawler/model strings as text and external links use `rel="noreferrer"`.
- SQL data values are parameterized; no command execution, `eval`, `pickle`, unsafe YAML, XML parser, or raw SQL input sink was found.
- Artifact sizes/hashes and embedding dimensions are verified by default; model/artifact metadata is recorded.
- AI has no tools/actions, uses structured output, `store=False`, retrieved-ID allowlisting, secret/URL output filtering, input length limits, a monthly ledger, and prompt/data boundary instructions.
- Suspicious retrieved course text is excluded from RAG, and official course IDs are rejoined to server catalog objects before response.
- The AI consent disclosure accurately describes the external data transfer, while local recommendation data remains in IndexedDB.
- `.env` is excluded from Git and Docker; the example contains no credential.
- Docker is multi-stage and keeps Node/build tools out of the final image; model access is offline at runtime.
- All 62 existing tests passed during the audit.

## 14. Remediation Priority — P0 / P1 / P2 / P3

### P0 — Immediate

No confirmed P0 issue. If the local OpenAI token has been exposed outside this ignored workstation file, rotate it immediately; this audit did not test token activity.

### P1 — Before public production exposure / next security release

1. Protect AI/embedding endpoints with verified identity/entitlement, shared global throttling, concurrency limits, and edge/provider budgets (SEC-001).
2. Remove legacy inline handlers, validate numeric course IDs, and fail closed when the production frontend is missing (SEC-002).
3. Stop labeling self-asserted facts as `eligible_confirmed`; preserve official restrictions or integrate authoritative university identity/course history (SEC-003).
4. Add response size, final-host, content-type, and strict nested schema validation to the crawler (SEC-004).
5. Pin actions/images/model/dependency graph; add read-only CI permissions, SBOM, signing, SCA, and secrets scanning (SEC-005).
6. Run the final container as a non-root user with read-only application/artifact paths and resource limits (SEC-006).

### P2 — Near term

1. Add CSP and other security headers; decide whether docs/schema are public in production (SEC-007).
2. Minimize/mask instructor contact data in public artifacts (SEC-008).
3. Strictly validate and cap backup imports (SEC-009).
4. Add privacy-preserving security telemetry and alerts (SEC-010).
5. Upgrade Vite/Vitest/esbuild/nanoid, rerun pnpm audit, and add built-image Trivy scanning.

### P3 — Ongoing assurance

1. Add regression security tests for legacy XSS, profile-property tampering, crawler poisoning, headers, and distributed limits.
2. Maintain an endpoint/data inventory and revisit authentication if private user features are introduced.
3. Periodically rescan Git history, dependencies, images, and model/artifact provenance.
4. Run a localhost-only ZAP baseline/API scan against a production-equivalent container once Docker/ZAP are available.

## 15. Direct Answer — 依照嚴重程度排列，目前有哪些漏洞，可以如何修復

目前沒有確認可利用的 Critical 或 High production 漏洞。依嚴重程度，應先修復的項目如下：

1. **Medium — 公開 AI/embedding 資源耗盡：** 加入可信身分或短效權杖、Redis/API gateway 共用限流、全域 concurrency/budget cap，並在模型/供應商呼叫前拒絕超額請求。
2. **Medium — legacy frontend stored XSS：** 移除 inline `onclick` 字串拼接，改用 `addEventListener`，且 ingestion 僅允許合法數字 course ID；production frontend 缺失時 fail closed。
3. **Medium — 系所/年級/已修課可由 request 偽造：** 不再顯示 `eligible_confirmed`，保留官方限制證據；需要「確認資格」時必須以校方 SSO/可信資料源在 server 端取得資料。
4. **Medium — 爬蟲不可信輸入未充分限制：** 限制 response bytes、停用或驗證 redirect、allowlist 最終 HTTPS host、驗證 content type，並以嚴格 schema/長度/型別規則隔離不合格資料。
5. **Medium — supply chain 未完整鎖定：** actions/base images/model revision 使用 immutable SHA/digest；Python 使用 lock + hashes；加入 SBOM、簽章、SCA 與 secrets CI gate。
6. **Medium — container 以 root 執行：** 建立 non-root UID，僅讓 runtime SQLite 目錄可寫，其他路徑 read-only，並 drop capabilities/設定資源限制。
7. **Low — 缺安全 headers/docs 公開：** 加 CSP、`nosniff`、frame protection、Referrer/Permissions Policy 與 HTTPS 邊界的 HSTS；production 關閉或保護 docs。
8. **Low — catalog 聚合教師 email：** artifact build 階段遮罩/移除非必要聯絡資訊並建立資料最小化規則。
9. **Low — JSON 匯入缺嚴格限制：** 限制檔案大小、深度、筆數與欄位，拒絕 extra keys/非法 ID，驗證完成後以單一 transaction 匯入。
10. **Low — security monitoring 不足：** 記錄不含問題內容/個資的結構化安全事件，對 `429`、quota、provider error、crawler reject、artifact mismatch 建立告警。
