# FJU Course Recommender System

This repository contains a data pipeline for collecting Fu Jen Catholic University
course outlines for recommendation-system research.

The repository now also contains a local-first course recommendation MVP:

- FastAPI catalog and query-embedding API.
- React/TypeScript course discovery, recommendation, and timetable UI.
- IndexedDB-only profiles, completed courses, favorites, and schedules.
- Conservative eligibility rules with source evidence.
- Versioned catalog and float32 embedding artifacts.

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
python3 -m fju_outline.cli crawl --hy 115 --ht 1 --page-size 100 --concurrency 3
python3 -m fju_outline.cli normalize --hy 115 --ht 1
python3 -m fju_outline.cli export --hy 115 --ht 1
python3 -m fju_outline.cli validate --hy 115 --ht 1
python3 -m fju_outline.cli artifacts --hy 115 --ht 1
```

Outputs are written under `data/`:

- `data/raw/`: complete API responses, one JSON object per line.
- `data/canonical/`: normalized nested course-outline records.
- `data/derived/`: analysis-friendly Parquet tables.
- `logs/`: fetch logs and validation summaries.

## Development

```bash
pip install -e ".[pipeline,test]"
pytest -q

cd frontend
pnpm install
pnpm dev
```

Run the API in another terminal after generating artifacts:

```bash
fju-outline-web --artifacts-dir data/artifacts/1151 --port 8080
```

Evaluate the fixed 30-query relevance set after changing the embedding model:

```bash
python -m fju_outline.evaluation --artifacts-dir data/artifacts/1151
```

The production build is a single container:

```bash
docker build -t fju-course-recommender .
docker run --rm -p 8080:8080 fju-course-recommender
```

The application never sends department, grade, completed courses, favorites,
or timetable data to the API. Only text explicitly submitted for semantic
recommendation is sent to `/api/v1/query-embedding`; request bodies must not be
logged by the application or its reverse proxy.
