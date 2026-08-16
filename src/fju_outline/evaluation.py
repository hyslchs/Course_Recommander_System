from __future__ import annotations

import argparse
import json
import math
import re
import unicodedata
from pathlib import Path
from typing import Any

import numpy as np

from .artifacts import SentenceTransformerEncoder, validate_artifacts


RRF_K = 60
RETRIEVAL_LIMIT = 200
FIELD_WEIGHTS = {
    "title": 3.2,
    "objective": 1.8,
    "weekly_progress": 1.3,
    "prerequisite": 1.0,
    "materials": 0.9,
    "skills": 0.8,
}


def evaluate_recommendations(
    artifacts_dir: Path,
    relevance_path: Path,
    *,
    recall_threshold: float = 0.70,
    ndcg_threshold: float = 0.60,
) -> dict[str, Any]:
    manifest = validate_artifacts(artifacts_dir)
    index = json.loads((artifacts_dir / "embedding-index.json").read_text(encoding="utf-8"))
    rows = json.loads(relevance_path.read_text(encoding="utf-8"))
    if len(rows) < 30:
        raise ValueError("Evaluation set must contain at least 30 queries")
    course_ids = np.asarray(index["course_ids"])
    catalog = json.loads((artifacts_dir / "catalog.json").read_text(encoding="utf-8"))
    course_names = np.asarray([item["name_zh"] for item in catalog])
    name_by_id = {item["course_id"]: item["name_zh"] for item in catalog}
    vectors = np.memmap(
        artifacts_dir / "course-embeddings.f32",
        dtype="<f4",
        mode="r",
        shape=(manifest["course_count"], manifest["dimension"]),
    )
    encoder = SentenceTransformerEncoder(manifest["model_name"])
    baseline_recalls = []
    baseline_ndcgs = []
    hybrid_recalls = []
    hybrid_ndcgs = []
    details = []
    for row in rows:
        relevant_ids = set(row["relevant_course_ids"])
        relevant = {name_by_id[course_id] for course_id in relevant_ids}
        if len(relevant_ids) < 5:
            raise ValueError(f"Query must have at least 5 relevant courses: {row['query']}")
        query = encoder.encode_query(row["query"])
        semantic = vectors @ query
        dense_ranking = np.argsort(-semantic)[:RETRIEVAL_LIMIT]
        lexical = np.asarray([_lexical_course_score(row["query"], item) for item in catalog])
        sparse_ranking = [
            int(position)
            for position in np.argsort(-lexical)
            if lexical[position] > 0
        ][:RETRIEVAL_LIMIT]
        rrf = np.zeros(len(catalog), dtype=np.float64)
        for rank, position in enumerate(dense_ranking, start=1):
            rrf[position] += 1 / (RRF_K + rank)
        for rank, position in enumerate(sparse_ranking, start=1):
            rrf[position] += 1 / (RRF_K + rank)
        hybrid_ranking = np.argsort(-rrf)
        baseline_recall, baseline_ndcg = _ranking_metrics(
            np.argsort(-semantic), course_ids, course_names, name_by_id, relevant
        )
        hybrid_recall, hybrid_ndcg = _ranking_metrics(
            hybrid_ranking, course_ids, course_names, name_by_id, relevant
        )
        baseline_recalls.append(baseline_recall)
        baseline_ndcgs.append(baseline_ndcg)
        hybrid_recalls.append(hybrid_recall)
        hybrid_ndcgs.append(hybrid_ndcg)
        details.append({
            "query": row["query"],
            "baseline_recall_at_10": baseline_recall,
            "baseline_ndcg_at_10": baseline_ndcg,
            "hybrid_recall_at_10": hybrid_recall,
            "hybrid_ndcg_at_10": hybrid_ndcg,
        })
    baseline_recall = float(np.mean(baseline_recalls))
    baseline_ndcg = float(np.mean(baseline_ndcgs))
    hybrid_recall = float(np.mean(hybrid_recalls))
    hybrid_ndcg = float(np.mean(hybrid_ndcgs))
    result = {
        "queries": len(rows),
        "recall_at_10": hybrid_recall,
        "ndcg_at_10": hybrid_ndcg,
        "baseline": {"recall_at_10": baseline_recall, "ndcg_at_10": baseline_ndcg},
        "hybrid": {"recall_at_10": hybrid_recall, "ndcg_at_10": hybrid_ndcg},
        "thresholds": {"recall_at_10": recall_threshold, "ndcg_at_10": ndcg_threshold},
        "passed": hybrid_recall >= recall_threshold and hybrid_ndcg >= ndcg_threshold,
        "details": details,
    }
    return result


def _ranking_metrics(ranking, course_ids, course_names, name_by_id, relevant):
    top_ids = []
    seen_names: set[str] = set()
    for position in ranking:
        name = str(course_names[position])
        if name in seen_names:
            continue
        top_ids.append(str(course_ids[position]))
        seen_names.add(name)
        if len(top_ids) == 10:
            break
    hits = [1 if name_by_id[course_id] in relevant else 0 for course_id in top_ids]
    recall = sum(hits) / len(relevant)
    dcg = sum(hit / math.log2(position + 2) for position, hit in enumerate(hits))
    ideal = sum(1 / math.log2(position + 2) for position in range(min(len(relevant), 10)))
    return recall, dcg / ideal


def _lexical_course_score(query: str, item: dict[str, Any]) -> float:
    query_tokens = set(_tokens(query))
    if not query_tokens:
        return 0.0
    title = f"{item.get('name_zh') or ''} {item.get('name_en') or ''}"
    normalized_query = unicodedata.normalize("NFKC", query).lower().replace(" ", "")
    normalized_title = unicodedata.normalize("NFKC", title).lower().replace(" ", "")
    title_tokens = set(_tokens(title))
    title_match = 1.0 if normalized_query in normalized_title else len(query_tokens & title_tokens) / len(query_tokens)
    body_weight = sum(weight for field, weight in FIELD_WEIGHTS.items() if field != "title")
    body_match = sum(
        weight * len(query_tokens & set(_tokens(_field_text(item, field)))) / len(query_tokens)
        for field, weight in FIELD_WEIGHTS.items()
        if field != "title"
    ) / body_weight
    return max(0.0, min(1.0, 0.45 * title_match + 0.55 * body_match))


def _field_text(item: dict[str, Any], field: str) -> str:
    sections = item.get("sections") or {}
    if field == "title":
        return f"{item.get('name_zh') or ''} {item.get('name_en') or ''}"
    if field == "prerequisite":
        return f"{item.get('prerequisite') or ''} {sections.get('prerequisite') or ''}"
    return str(sections.get(field) or "")


def _tokens(value: str) -> list[str]:
    normalized = unicodedata.normalize("NFKC", str(value)).lower()
    tokens = re.findall(r"[a-z0-9]+(?:[+#.-][a-z0-9]+)*", normalized)
    for run in re.findall(r"[\u4e00-\u9fff]+", normalized):
        characters = list(run)
        tokens.extend(characters)
        tokens.extend(characters[index] + characters[index + 1] for index in range(len(characters) - 1))
    tokens.extend(word for word in re.findall(r"[\w]+", normalized) if word not in tokens)
    return [token for token in tokens if token]


def main() -> None:
    parser = argparse.ArgumentParser(prog="fju-recommendation-eval")
    parser.add_argument("--artifacts-dir", default="data/artifacts/1151")
    parser.add_argument("--relevance", default="evaluation/relevance_v1.json")
    args = parser.parse_args()
    result = evaluate_recommendations(Path(args.artifacts_dir), Path(args.relevance))
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if not result["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
