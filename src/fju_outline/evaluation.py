from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

import numpy as np

from .artifacts import SentenceTransformerEncoder, validate_artifacts


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
    recalls = []
    ndcgs = []
    details = []
    for row in rows:
        relevant_ids = set(row["relevant_course_ids"])
        relevant = {name_by_id[course_id] for course_id in relevant_ids}
        if len(relevant_ids) < 5:
            raise ValueError(f"Query must have at least 5 relevant courses: {row['query']}")
        query = encoder.encode_query(row["query"])
        semantic = vectors @ query
        lexical = np.asarray([_lexical_title_score(row["query"], title) for title in course_names])
        ranking = np.argsort(-(0.9 * semantic + 0.1 * lexical))
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
        ndcg = dcg / ideal
        recalls.append(recall)
        ndcgs.append(ndcg)
        details.append({"query": row["query"], "recall_at_10": recall, "ndcg_at_10": ndcg})
    result = {
        "queries": len(rows),
        "recall_at_10": float(np.mean(recalls)),
        "ndcg_at_10": float(np.mean(ndcgs)),
        "thresholds": {"recall_at_10": recall_threshold, "ndcg_at_10": ndcg_threshold},
        "passed": float(np.mean(recalls)) >= recall_threshold and float(np.mean(ndcgs)) >= ndcg_threshold,
        "details": details,
    }
    return result


def _lexical_title_score(query: str, title: str) -> float:
    def bigrams(value: str) -> set[str]:
        normalized = "".join(character.lower() for character in value if character.isalnum())
        return {normalized[index : index + 2] for index in range(max(1, len(normalized) - 1))}

    query_bigrams = bigrams(query)
    title_bigrams = bigrams(str(title))
    return len(query_bigrams & title_bigrams) / max(1, len(title_bigrams))


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
