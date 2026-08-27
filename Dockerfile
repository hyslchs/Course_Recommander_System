# syntax=docker/dockerfile:1.7
FROM node:24.15-alpine AS frontend
WORKDIR /app/frontend
# Build the production React bundle and its optimized font assets.
RUN apk add --no-cache python3 py3-pip py3-brotli \
    && pip install --break-system-packages --no-cache-dir "fonttools==4.63.0"
COPY frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY frontend/ ./
RUN pnpm run build
RUN find dist -name "*.map" -delete

FROM python:3.11-slim-bookworm AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/app/model-cache \
    FJU_RECOMMENDER_ARTIFACTS_DIR=/app/data/artifacts/1151-embeddinggemma-768 \
    FJU_VERIFY_ARTIFACT_HASHES=1 \
    FJU_FRONTEND_DIST=/app/frontend/dist
WORKDIR /app
COPY pyproject.toml README.md ./
COPY src/ ./src/
RUN python -m pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu "torch==2.13.0+cpu"
RUN python -m pip install --no-cache-dir \
    "fastapi==0.141.1" \
    "numpy==2.4.6" \
    "orjson==3.12.0" \
    "pydantic==2.13.4" \
    "sentence-transformers==6.0.0" \
    "transformers==5.15.1" \
    "openai==2.54.0" \
    "python-dotenv==1.2.3" \
    "uvicorn[standard]==0.52.4" \
    .
ENV HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    HF_DATASETS_OFFLINE=1 \
    FJU_EMBEDDING_DEVICE=cpu \
    FJU_EMBEDDING_THREADS=8
COPY scripts/verify_artifact_bundle.py ./scripts/verify_artifact_bundle.py
COPY --from=crs_artifacts /model-cache/ ./model-cache/
COPY --from=crs_artifacts /vector/ ./data/artifacts/1151-embeddinggemma-768/
COPY --from=crs_artifacts /canonical/course_outlines_1151.jsonl ./data/canonical/course_outlines_1151.jsonl
COPY --from=crs_artifacts /bundle-lock.json ./artifact-lock.json
COPY data/reference/departments_115.json ./data/reference/departments_115.json
COPY --from=frontend /app/frontend/dist/ ./frontend/dist/
RUN python scripts/verify_artifact_bundle.py \
    --artifact-dir /app/data/artifacts/1151-embeddinggemma-768 \
    --canonical /app/data/canonical/course_outlines_1151.jsonl \
    --lock /app/artifact-lock.json \
    --require-app-validator
RUN python -c 'from sentence_transformers import SentenceTransformer; m=SentenceTransformer("google/embeddinggemma-300m", revision="57c266a740f537b4dc058e1b0cda161fd15afa75", device="cpu", local_files_only=True); assert m.get_sentence_embedding_dimension() == 768'
RUN mkdir -p /app/data/runtime
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=5 CMD python -c 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8080/health/ready", timeout=3)'
CMD ["uvicorn", "fju_outline.web:app", "--host", "0.0.0.0", "--port", "8080", "--no-access-log"]
