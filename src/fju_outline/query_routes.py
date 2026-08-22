"""Small, reviewable semantic routes used by the deterministic query analyser.

Routes describe *roles and contexts*, not course subject domains.  The raw query
and every goal vector remain authoritative; a route can only add a soft hint
or mark a context as required when the utterance explicitly attaches it.
"""

from __future__ import annotations

from typing import Any

import numpy as np

ANALYSIS_VERSION = "deterministic-v1"
ROUTE_THRESHOLD = 0.78
ROUTE_MARGIN = 0.04

ROUTES: tuple[dict[str, Any], ...] = (
    {
        "id": "capstone",
        "label": "畢業專題",
        "policy": "soft",
        "utterances": ["畢業專題", "專題製作", "做畢業專題", "專題實作", "畢業製作"],
    },
    {
        "id": "internship",
        "label": "實習",
        "policy": "attached_required",
        "utterances": ["實習", "企業實習", "校外實習", "產業實習", "實務實習"],
    },
    {
        "id": "hands_on",
        "label": "實作",
        "policy": "soft",
        "utterances": ["實作", "動手做", "有實務操作", "實務應用", "工作坊"],
    },
    {
        "id": "beginner",
        "label": "初學",
        "policy": "soft",
        "utterances": ["初學者", "零基礎", "入門", "沒有基礎也能學", "適合新手"],
    },
    {
        "id": "career_goal",
        "label": "職涯目標",
        "policy": "soft",
        "utterances": ["想找工作", "職涯發展", "就業準備", "轉職需要", "未來工作"],
    },
    {
        "id": "research",
        "label": "研究",
        "policy": "soft",
        "utterances": ["研究方法", "學術研究", "論文研究", "做研究", "研究導向"],
    },
)


def route_index() -> dict[str, Any]:
    return {
        "analysis_version": ANALYSIS_VERSION,
        "threshold": ROUTE_THRESHOLD,
        "margin": ROUTE_MARGIN,
        "routes": [
            {
                "id": route["id"],
                "label": route["label"],
                "policy": route["policy"],
                "utterance_count": len(route["utterances"]),
            }
            for route in ROUTES
        ],
    }


def route_data(embeddings: np.ndarray, *, model_name: str | None = None, model_revision: str | None = None) -> dict[str, Any]:
    values = np.asarray(embeddings, dtype="<f4")
    return {
        **route_index(),
        "dimension": int(values.shape[1]) if values.ndim == 2 else 0,
        "route_count": len(ROUTES),
        "utterance_count": sum(len(route["utterances"]) for route in ROUTES),
        "model_name": model_name,
        "model_revision": model_revision,
    }


def build_route_embeddings(encoder: Any, *, batch_size: int = 64) -> np.ndarray:
    """Encode all route utterances and average each route into one vector."""
    rows: list[np.ndarray] = []
    for route in ROUTES:
        utterances = list(route["utterances"])
        if hasattr(encoder, "encode_passages"):
            vectors = np.asarray(encoder.encode_passages(utterances), dtype=np.float32)
        else:
            vectors = np.stack([encoder.encode_query(text) for text in utterances])
        if vectors.ndim != 2 or not len(vectors):
            raise ValueError(f"Invalid route embedding for {route['id']}")
        mean = vectors.mean(axis=0)
        mean /= max(float(np.linalg.norm(mean)), 1e-12)
        rows.append(mean.astype(np.float32))
    return np.stack(rows).astype("<f4")


def match_routes(
    vector: np.ndarray,
    route_embeddings: np.ndarray,
    *,
    threshold: float = ROUTE_THRESHOLD,
    margin: float = ROUTE_MARGIN,
) -> list[dict[str, Any]]:
    """Return at most one confident role route for a query vector."""
    values = np.asarray(route_embeddings, dtype=np.float32)
    if values.ndim != 2 or not len(values):
        return []
    query = np.asarray(vector, dtype=np.float32)
    query /= max(float(np.linalg.norm(query)), 1e-12)
    scores = values @ query
    order = np.argsort(-scores)
    best = int(order[0])
    second = float(scores[order[1]]) if len(order) > 1 else -1.0
    if float(scores[best]) < threshold or float(scores[best] - second) < margin:
        return []
    route = ROUTES[best]
    return [{
        "id": route["id"],
        "label": route["label"],
        "policy": route["policy"],
        "score": float(scores[best]),
        "margin": float(scores[best] - second),
    }]
