# FJU Course Recommender System

An open-source course discovery and decision-support system for students at Fu Jen Catholic University.

The project combines structured course data, semantic retrieval, keyword search, eligibility rules, and timetable tools to help students explore and compare courses more efficiently.

> This is an independent open-source project and is not an official Fu Jen Catholic University service.

## Demo

**Live demo: https://crs.sixhuang.com**


![FJU Course Recommender System screenshot](assets/overview.png)

## Features

* **Semantic course search**

  * Search with natural-language goals such as "database and backend development".
  * Queries do not need to exactly match words in a course title or syllabus.

* **Hybrid retrieval**

  * Combines dense semantic retrieval with BM25 keyword search.
  * Uses Reciprocal Rank Fusion (RRF) to merge retrieval results.

* **Eligibility-aware recommendations**

  * Uses structured information such as study level, department, and grade.
  * Unknown eligibility conditions are handled conservatively instead of automatically excluding a course.

* **Course discovery and filtering**

  * Filter by weekday, time, credits, course type, department, and other catalog metadata.
  * Designed to support both in-department and cross-department course exploration.

* **Timetable and conflict detection**

  * Add courses to a timetable while exploring alternatives.
  * Detect schedule conflicts without preventing students from comparing competing course choices.

* **Local-first student data**

  * Profiles, completed courses, favorites, and timetables are primarily stored in browser IndexedDB.
  * The core recommendation experience does not require an account.

* **No generative LLM in the core recommendation path**

  * Core course retrieval does not depend on Chat Completion or another generative model.
  * Runtime search primarily uses embeddings, retrieval, deterministic rules, and ranking.

## How Recommendation Works

At a high level:

```text
User Query
    │
    ├── Query Embedding
    │
    ├── BM25 Keyword Search
    │
    ▼
Dense Retrieval + BM25
    │
    ▼
Reciprocal Rank Fusion (RRF)
    │
    ▼
Eligibility / Hard Constraints
    │
    ▼
Filtering & Ranking
    │
    ▼
Recommended Courses
```

### 1. Course representation

Normalized course records are converted into a searchable catalog. Embeddings are built from course information such as the title, objectives, syllabus content, and other structured metadata.

The current production artifact uses:

* Model: `google/embeddinggemma-300m`
* Dimension: `768`
* Vector format: `float32`

Model revisions and artifact metadata are pinned so that the catalog, embeddings, and runtime model remain reproducible.

### 2. Query retrieval

For each search query, the system:

1. Generates a query embedding.
2. Performs dense semantic retrieval.
3. Performs BM25 keyword retrieval.
4. Combines the rankings using RRF.

This gives the system both:

* semantic recall when a course uses different wording from the query, and
* strong lexical matching when specific terms matter.

### 3. Eligibility and constraints

Retrieved candidates are then evaluated using structured course information, including:

* study level
* grade
* department / intended audience
* known enrollment restrictions
* user-selected filters

Only restrictions that can be supported by available course data are treated as confirmed blockers. Missing information is generally surfaced as something that should be checked rather than being interpreted as definite ineligibility.

More detailed design and evaluation documentation should live in `docs/recommendation.md` and `docs/evaluation.md`.

## Architecture

```text
                     ┌──────────────────────┐
                     │       Browser        │
                     │ React / TypeScript   │
                     │ IndexedDB profile    │
                     └──────────┬───────────┘
                                │
                                │ HTTP API
                                ▼
                     ┌──────────────────────┐
                     │       FastAPI        │
                     │ Catalog / Retrieval  │
                     │ Eligibility Rules    │
                     └──────────┬───────────┘
                                │
                    ┌───────────┴───────────┐
                    ▼                       ▼
          ┌──────────────────┐    ┌──────────────────┐
          │ Course Catalog   │    │ Vector Artifacts │
          │ Structured Data  │    │ EmbeddingGemma   │
          └──────────────────┘    └──────────────────┘
                    ▲
                    │
          ┌─────────┴──────────┐
          │   Data Pipeline    │
          │ Crawl → Normalize  │
          │ Validate → Build   │
          └────────────────────┘
```

Main technologies:

| Layer         | Technology                   |
| ------------- | ---------------------------- |
| Frontend      | React 19, TypeScript, Vite   |
| UI            | HeroUI, Tailwind CSS         |
| Client data   | IndexedDB                    |
| Backend       | FastAPI                      |
| Embedding     | EmbeddingGemma               |
| Retrieval     | Dense retrieval + BM25 + RRF |
| Data pipeline | Python                       |
| Deployment    | Docker                       |

## Dataset

The current primary dataset contains course outlines for **Academic Year 115, Semester 1** at Fu Jen Catholic University.

Course information is collected from public interfaces used by the university's course-outline system and processed through:

```text
Discovery
   ↓
Crawling
   ↓
Normalization
   ↓
Validation
   ↓
Canonical Catalog
   ↓
Embedding / Search Artifacts
```

The current production catalog contains approximately **4,565 course records**.

Complete production runtime artifacts are not treated as source code and are not committed directly to the Git repository.

See `docs/data-pipeline.md` for data processing and artifact-generation details.

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

### Backend

Create a Python environment and install the project:

```bash
python -m venv .venv

# Linux / macOS
source .venv/bin/activate

# Windows PowerShell
# .venv\Scripts\Activate.ps1

pip install -e ".[pipeline,test]"
```

Run the test suite:

```bash
pytest -q
```

### Frontend

```bash
cd frontend
pnpm install
pnpm dev
```

During development, Vite proxies `/api` requests to the backend.

### Running the complete recommender

The complete recommendation system requires a compatible:

* canonical course catalog
* embedding artifact set
* artifact metadata / lock file
* query embedding model

Production artifacts are **not included directly in the Git repository**.

If you already have a compatible artifact bundle:

```bash
fju-outline-web \
  --artifacts-dir /path/to/artifact-bundle/vector \
  --port 8080
```

Then start the frontend in another terminal:

```bash
cd frontend
pnpm dev
```

To rebuild the dataset and embedding artifacts from source data, see `docs/data-pipeline.md`.

## Data Pipeline

The crawler and dataset pipeline are also part of this repository.

For example:

```bash
python -m fju_outline.cli discover --hy 115 --ht 1
python -m fju_outline.cli departments --hy 115 --lcid 1028
python -m fju_outline.cli crawl --hy 115 --ht 1
python -m fju_outline.cli normalize --hy 115 --ht 1
python -m fju_outline.cli validate --hy 115 --ht 1
```

These commands handle course discovery, collection, normalization, and validation.

The production EmbeddingGemma artifacts use a separate pinned build process. Detailed build and verification instructions belong in:

```text
docs/data-pipeline.md
```

## Repository Structure

```text
.
├── frontend/          # React / TypeScript frontend
├── src/fju_outline/   # Backend, crawler and data pipeline
├── scripts/           # Artifact build and verification tools
├── evaluation/        # Recommendation evaluation resources
├── artifact-locks/    # Versioned production artifact metadata
├── data/              # Local/generated data workspace
├── Dockerfile
├── compose.yaml
├── pyproject.toml
└── README.md
```

## Privacy

The project follows a local-first approach.

For normal course discovery and recommendation flows, the following data primarily remains in the user's browser:

* student profile
* completed courses
* favorite courses
* timetable

The product analytics layer is designed around aggregate product usage rather than maintaining identifiable user profiles, and the application does not require an account for the core recommendation flow.

The repository also contains an optional AI course assistant. It is separate from the core recommendation pipeline and is currently disabled on the public deployment.

Detailed documentation for analytics, retention, opt-out behavior, and any external AI-provider data flow should be maintained in:

```text
docs/privacy.md
```

## Documentation

The README intentionally contains only the information needed to understand and start working with the project.

Detailed maintainer documentation should be separated into:

```text
docs/
├── architecture.md       # Components and system architecture
├── data-pipeline.md      # Crawling, normalization and artifact builds
├── recommendation.md     # Retrieval and recommendation logic
├── evaluation.md         # Relevance sets and recommendation evaluation
├── privacy.md            # Analytics, privacy and optional AI data flows
└── deployment.md         # Production deployment, networking and rollback
```

Production server paths, Docker subnets, trusted-proxy configuration, Cloudflare Tunnel settings, rollback procedures, and other operator-specific information belong in `docs/deployment.md`, not in the project homepage.

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

Changes to the embedding model, retrieval strategy, or ranking logic should be followed by recommendation evaluation rather than only checking that the application starts successfully.

## License

Source code created as part of this project is licensed under the **Apache License 2.0**.

Apache-2.0 does **not** automatically relicense every dataset, model, font, dependency, or other third-party resource associated with this repository.

This includes, but is not limited to:

* Fu Jen Catholic University public course data
* EmbeddingGemma models and model artifacts
* Noto Sans TC
* Python and JavaScript dependencies
* other third-party resources

Those materials remain subject to their respective licenses and terms of use.

See [LICENSE](LICENSE) and the repository's third-party notices for details.

## Disclaimer

This project is an independent tool for course discovery, recommender-system research, and course-selection decision support.

Recommendations and eligibility assessments are provided for reference only. Official course availability, enrollment eligibility, prerequisites, capacity, and course changes should always be verified through **Fu Jen Catholic University's official course registration and course-outline systems**.
