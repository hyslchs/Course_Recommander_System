"""Create a reviewable, non-approved compound-query evaluation draft.

The generator deliberately leaves course IDs and approval empty.  A human
reviewer must attach catalog evidence and mark rows approved before a release
gate can consume them.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

CATEGORY_COUNTS = {
    "SINGLE": 20,
    "COVERAGE": 25,
    "INTERSECTION": 20,
    "CONTEXT_GOAL": 20,
    "NEGATION_HARD_CONSTRAINT": 25,
    "UNSUPPORTED_FALLBACK": 15,
    "UNANSWERABLE": 15,
    "TYPO_MIXED_GARBAGE_REWRITE": 20,
}

TEMPLATES = {
    "SINGLE": ["Python", "資料庫", "人工智慧", "公司法", "初學日文"],
    "COVERAGE": ["資料庫＋後端", "統計、機率與迴歸", "行銷和財務", "心理與行銷", "永續＋金融＋英文"],
    "INTERSECTION": ["企業法務實習", "教育科技實作", "醫療人工智慧", "英文授課的國際貿易", "商學院學生程式設計"],
    "CONTEXT_GOAL": ["做畢業專題想學資料庫跟後端", "想找實作型人工智慧", "初學者想學資料分析", "想研究行銷", "轉職需要後端"],
    "NEGATION_HARD_CONSTRAINT": ["想學AI但不要寫程式", "不要早八的通識", "只要星期五且2學分的日文課", "排除星期三的資料庫", "不要實習但想學法律"],
    "UNSUPPORTED_FALLBACK": ["Python 或 R", "如果沒有後端就推薦資料庫", "先學統計再學機器學習", "後端最重要資料庫其次", "只要最涼的課"],
    "UNANSWERABLE": ["甜課", "想找給分高的課", "下學期的熱門課", "報告少又不用考試", "離校門近的課"],
    "TYPO_MIXED_GARBAGE_REWRITE": ["pyhton", "資料褲", "後端api啦", "🚀AI＋法律？！", "我想學 db backend"],
}


def build_draft() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for category, count in CATEGORY_COUNTS.items():
        for index in range(count):
            template = TEMPLATES[category][index % len(TEMPLATES[category])]
            rows.append({
                "id": f"compound-v1-{len(rows) + 1:03d}",
                "split": "development" if len(rows) < 100 else "validation" if len(rows) < 130 else "hidden_test",
                "category": category,
                "query": template,
                "suggested_relation": category if category in {"SINGLE", "COVERAGE", "INTERSECTION"} else "FALLBACK" if category in {"UNSUPPORTED_FALLBACK", "UNANSWERABLE"} else None,
                "suggested_goals": [],
                "suggested_contexts": [],
                "suggested_exclusions": [],
                "candidate_course_ids": [],
                "review": {"status": "draft", "approved": False, "reviewer": None, "notes": "請人工依 115-1 catalog 補證據與標註。"},
            })
    return rows


def write_draft(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"schema_version": "compound-evaluation-v1", "rows": build_draft()}, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    write_draft(Path("evaluation/compound_queries_v1.json"))
