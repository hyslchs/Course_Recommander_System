# FJU Course Recommender System

[English](README-en.md) | [繁體中文](README.md)

An open-source course discovery and course-selection decision-support system for students at Fu Jen Catholic University.

The project combines structured course-outline data, semantic retrieval, BM25 lexical search, eligibility rules, filters, and timetable information to help students discover and compare courses.

> This is an independent open-source project. It is not an official Fu Jen Catholic University service.

## Demo

**Live demo:** https://crs.sixhuang.com

![FJU Course Recommender System](assets/overview.png)

## Features

* **Semantic course search** — describe what you want to learn in natural language instead of relying only on exact course-title matches.
* **Hybrid retrieval** — combines course embeddings with field-weighted BM25 lexical search.
* **Eligibility-aware recommendations** — uses available study-level, department, grade, prerequisite, and audience information.
* **Course filtering** — filter courses by schedule, credits, course type, department, teaching method, assessment method, language, and other available metadata.
* **Timetable and conflict detection** — compare courses while detecting conflicts with an existing schedule.
* **Course-family deduplication and diversity** — groups closely related offerings and uses diversity-aware ranking to avoid filling the result list with near-duplicates.
* **Local-first student data** — profiles, completed courses, favorites, dismissed courses, schedules, and recommendation preferences are stored in browser IndexedDB.
* **No generative LLM in the core recommendation path** — the main recommender uses embeddings, deterministic query processing, filtering, and ranking rather than Chat Completion.
* **Optional compound-query analysis** — a deterministic frontend parser can recognize multiple goals, exclusions, contexts, and supported hard constraints. This feature is controlled by `FJU_COMPOUND_QUERY_ENABLED` and is disabled by default.

## How Recommendation Works

The recommendation pipeline is primarily executed in the browser.

```text
User query
    │
    ├─────────────────────────────────────┐
    │                                     │
    ▼                                     ▼
FastAPI query-embedding API         Deterministic query analysis
    │                               (when enabled)
    ▼                                     │
Query vector                              │
    │                                     │
    └─────────────────┬───────────────────┘
                      ▼
              Browser-side ranking
                      │
        ┌─────────────┴─────────────┐
        ▼                           ▼
Dense semantic ranking        BM25 lexical ranking
        │                           │
        └─────────────┬─────────────┘
                      ▼
          Reciprocal Rank Fusion
                      │
                      ▼
       Eligibility / hard constraints
       Schedule / user-selected filters
                      │
                      ▼
           Course-family grouping
                      │
                      ▼
          Diversity selection (MMR)
                      │
                      ▼
             Recommended courses
```

### Dense retrieval

Course embeddings are downloaded from the backend and cached by the frontend. For each query, the backend generates a compatible query embedding and the browser compares it against course vectors.

The pinned production artifact currently uses:

|                |                              |
| -------------- | ---------------------------- |
| Model          | `google/embeddinggemma-300m` |
| Dimension      | `768`                        |
| Vector type    | `float32`                    |
| Catalog schema | `fju_catalog_v4`             |
| Course records | `4,565`                      |

The exact model revision, canonical-data checksum, artifact checksums, and build metadata are recorded in:

[`artifact-locks/1151-embeddinggemma-768.json`](artifact-locks/1151-embeddinggemma-768.json)

### Lexical retrieval

The frontend also builds a field-weighted BM25 index over:

* course title
* course objective
* weekly progress
* prerequisites
* materials
* skills

The dense and lexical rankings are combined using **Reciprocal Rank Fusion (RRF)**.

### Eligibility, filtering, and diversity

Before a course is presented as a recommendation, the frontend can account for information such as:

* student profile and study level
* department relationship
* completed courses
* known prerequisites
* existing timetable conflicts
* preferred weekdays
* course category
* credits
* advanced course filters
* supported query-level hard constraints

Confirmed restrictions may block a course. Conditions that cannot be determined from available data can instead remain marked as requiring confirmation.

After retrieval, similar course offerings are grouped into course families and a **Maximal Marginal Relevance (MMR)** step is used to improve result diversity.

### Compound queries

The repository also contains an optional deterministic query-analysis layer for queries such as:

```text
資料庫＋後端
企業法務實習
不要星期三的通識
```

It can distinguish supported relations such as single-goal, coverage, intersection, filtering, exclusions, and selected metadata constraints.

It does **not** use a generative LLM to interpret these searches.

The feature is disabled by default:

```text
FJU_COMPOUND_QUERY_ENABLED=0
```

Evaluation material for this feature is available in [`evaluation/`](evaluation/).

## Architecture

```text
┌──────────────────────────────────────────────┐
│                  Browser                     │
│                                              │
│ React / TypeScript                           │
│                                              │
│ • Course discovery UI                        │
│ • Query analysis                             │
│ • Eligibility and schedule checks            │
│ • Dense + BM25 + RRF ranking                 │
│ • Course-family grouping + MMR               │
│ • IndexedDB user data                        │
│ • Cached catalog and vector artifacts        │
└──────────────────────┬───────────────────────┘
                       │ HTTP
                       ▼
┌──────────────────────────────────────────────┐
│                  FastAPI                     │
│                                              │
│ • Course catalog APIs                        │
│ • Facets / department metadata               │
│ • Query embedding                            │
│ • Catalog and embedding artifacts            │
│ • Optional analytics                         │
│ • Optional AI assistant                      │
└──────────────────────┬───────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────┐
│               Artifact Bundle                │
│                                              │
│ canonical catalog                            │
│ course embeddings                            │
│ embedding index                              │
│ query-route artifacts                        │
│ pinned model runtime                         │
└──────────────────────────────────────────────┘
```

### Main technologies

| Layer             | Technology                   |
| ----------------- | ---------------------------- |
| Frontend          | React 19, TypeScript, Vite   |
| UI                | HeroUI, Tailwind CSS         |
| Client-side state | IndexedDB, TanStack Query    |
| Backend           | FastAPI                      |
| Embedding         | EmbeddingGemma               |
| Retrieval         | Dense retrieval + BM25 + RRF |
| Diversification   | MMR                          |
| Data pipeline     | Python                       |
| Deployment        | Docker                       |

## Dataset and Data Pipeline

The current production artifact is based on Fu Jen Catholic University course-outline data for:

* Academic year: **115**
* Semester: **1**
* Course type: `100`
* Language setting: `1028`

The crawler accesses the public JSON APIs used by the university's course-outline system.

The pipeline consists of:

```text
Course discovery
      ↓
Department metadata
      ↓
Course crawling
      ↓
Normalization
      ↓
Validation
      ↓
Canonical JSONL
      ↓
Embedding artifact build
```

The main CLI commands are:

```bash
fju-outline discover --hy 115 --ht 1
fju-outline departments --hy 115 --lcid 1028
fju-outline crawl --hy 115 --ht 1
fju-outline normalize --hy 115 --ht 1
fju-outline export --hy 115 --ht 1
fju-outline validate --hy 115 --ht 1
```

### Compare course-search data with outlines

The two student course-search pages are queried through their public JSON APIs. The audit uses Scrapling, saves the raw responses, and compares course IDs and course-code variants with the canonical outline JSONL:

```bash
python scripts/course_search_audit.py --hy 115 --ht 1 --page-size 100 --concurrency 3
```

By default, the snapshot and report are written to `tmp/course_search_audit_<hy><ht>/`. The report records the capture time of both sources because a count mismatch across different dates does not by itself prove that the crawler missed records.

Generated raw course data, canonical datasets, derived tables, and production artifact bundles are not all committed to this repository.

The tracked `data/` directory currently contains reference data used by the project, including department metadata and department-matching review data.

The production-compatible EmbeddingGemma builder is:

[`scripts/build_embedding_bundle.py`](scripts/build_embedding_bundle.py)

Artifact verification is implemented in:

[`scripts/verify_artifact_bundle.py`](scripts/verify_artifact_bundle.py)

## Quick Start

### Requirements

* Python 3.11+
* Node.js
* pnpm

Clone the repository:

```bash
git clone https://github.com/hyslchs/Course_Recommender_System.git
cd Course_Recommender_System
```

Create a Python environment:

```bash
python -m venv .venv
```

Activate it:

```bash
# Linux / macOS
source .venv/bin/activate
```

```powershell
# Windows PowerShell
.venv\Scripts\Activate.ps1
```

Install the backend, pipeline dependencies, and test dependencies:

```bash
pip install -e ".[pipeline,test]"
```

Run backend tests:

```bash
pytest -q
```

### Frontend development

```bash
cd frontend
pnpm install
pnpm test
pnpm dev
```

The Vite development server proxies `/api` and `/health` to:

```text
http://127.0.0.1:8080
```

### Running the complete application

A fresh clone does **not** contain the complete production artifact bundle.

The backend requires a compatible vector artifact directory containing the catalog, embedding index, course vectors, and model metadata.

If you already have a compatible artifact bundle:

```bash
fju-outline-web \
  --artifacts-dir /path/to/vector-artifacts \
  --port 8080
```

Then run the frontend in another terminal:

```bash
cd frontend
pnpm dev
```

For rebuilding the pinned EmbeddingGemma artifact format, inspect the builder options with:

```bash
python scripts/build_embedding_bundle.py --help
```

Before using a generated production bundle, it can be checked with:

```bash
python scripts/verify_artifact_bundle.py --help
```

## Evaluation

The repository includes recommendation and compound-query evaluation resources under [`evaluation/`](evaluation/).

These include:

* `relevance_v1.json`
* `manual_test_cases_v1.csv`
* `manual_test_cases_v1.json`
* `compound_queries_v1.json`
* RESQUE user-simulation reports

The hybrid recommendation evaluator compares dense retrieval against the hybrid ranking using **Recall@10** and **NDCG@10**:

```bash
python -m fju_outline.evaluation \
  --artifacts-dir /path/to/vector-artifacts
```

The compound-query evaluation material and its review status are documented in:

[`evaluation/README.md`](evaluation/README.md)

Some evaluation files are explicitly drafts or require manual review; they should not automatically be treated as validated relevance ground truth.

## Local Data and Optional Services

Student-side application data is stored in browser IndexedDB.

The current stores include:

```text
profile
completedCourses
favorites
dismissedCourses
schedulePlans
recommendationPreferences
catalogCache
preferences
```

The repository also contains two optional server-side features:

**Product analytics**

Analytics support exists in the backend and frontend, but the example configuration disables collection by default:

```text
FJU_ANALYTICS_ENABLED=0
```

**AI course assistant**

An optional AI course assistant is also implemented separately from the main recommender. It requires an explicitly configured `OPENAI_API_KEY`.

The example configuration leaves the key empty, so the feature is not enabled by default.

Neither feature is required for the core semantic recommendation flow.

See [`.env.example`](.env.example) for the available runtime configuration.

## Repository Structure

```text
.
├── .github/
│   └── workflows/             # CI
├── artifact-locks/            # Pinned production artifact metadata
├── assets/
│   └── overview.png           # README screenshot
├── data/
│   └── reference/             # Tracked reference datasets
├── evaluation/                # Recommendation and query evaluation data
├── frontend/                  # React / TypeScript application
├── scripts/                   # Artifact and deployment utilities
├── src/
│   └── fju_outline/           # Backend, crawler, pipeline and evaluation code
├── .env.example
├── Dockerfile
├── compose.yaml
├── pyproject.toml
├── THIRD_PARTY_NOTICES.md
├── LICENSE
├── README-en.md
└── README.md                # Default Traditional Chinese README
```

## Development

Backend:

```bash
pip install -e ".[pipeline,test]"
pytest -q
```

Frontend:

```bash
cd frontend
pnpm install
pnpm test
pnpm build
```

Changes to embedding generation, lexical retrieval, ranking, eligibility rules, or compound-query behavior should also be checked against the relevant evaluation material.

## License

Original source code developed for this project is licensed under the **Apache License 2.0**.

The Apache License 2.0 for this repository's original source code does not automatically apply to third-party materials such as:

* Fu Jen Catholic University course data
* EmbeddingGemma model files
* Noto Sans TC
* third-party Python and JavaScript dependencies
* other externally provided data or services

Those materials remain subject to their respective licenses, terms, and applicable laws.

See:

* [LICENSE](LICENSE)
* [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)

for details.

## Disclaimer

This project is an independent tool for course discovery, recommender-system research, and course-selection decision support.

Recommendation results and eligibility assessments are for reference only.

Official course availability, enrollment restrictions, prerequisites, capacity, schedules, and other registration requirements should always be verified through Fu Jen Catholic University's official systems.
