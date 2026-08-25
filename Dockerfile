FROM node:24.15-alpine AS frontend
WORKDIR /app/frontend
# `pnpm run prebuild` merges @fontsource's 105 unicode-range slices per weight
# back into one font and re-cuts them into the three "FJU Sans" tiers
# (frontend/scripts/build-fonts.py), which is what takes the render-blocking CSS
# from 250 kB gzip to 37 kB. brotli must come from apk — musl has no wheel.
# This is a BUILDER stage: the ~80 MB of Python is discarded, and the runtime
# image gets smaller because 404 hashed woff2 collapse to 12.
RUN apk add --no-cache python3 py3-pip py3-brotli \
    && pip install --break-system-packages --no-cache-dir 'fonttools>=4.63'
COPY frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY frontend/ ./
RUN pnpm run build
# `build.sourcemap` is "hidden": no `sourceMappingURL` is emitted, so nothing in
# the runtime image can consume these, but they are still 4.6 MB of the 16 MB
# dist and the COPY below takes dist wholesale. Dropping them here keeps local
# builds map-enabled for debugging while leaving them out of the image.
RUN find dist -name '*.map' -delete

FROM python:3.11-slim AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HF_HOME=/app/model-cache FJU_RECOMMENDER_ARTIFACTS_DIR=/app/data/artifacts/1151 FJU_FRONTEND_DIST=/app/frontend/dist
WORKDIR /app
COPY pyproject.toml README.md ./
COPY src/ ./src/
RUN pip install --no-cache-dir .
RUN python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('intfloat/multilingual-e5-small')"
ENV HF_HUB_OFFLINE=1
COPY data/artifacts/1151/ ./data/artifacts/1151/
COPY data/reference/departments_115.json ./data/reference/departments_115.json
COPY --from=frontend /app/frontend/dist/ ./frontend/dist/
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health/ready', timeout=3)"
CMD ["uvicorn", "fju_outline.web:app", "--host", "0.0.0.0", "--port", "8080", "--no-access-log"]
