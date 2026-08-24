#!/usr/bin/env python3
"""Regenerate the committed tier-1 / tier-2 codepoint lists (T41b).

WHY THE LISTS ARE COMMITTED RATHER THAN COMPUTED AT BUILD TIME
The frontend Docker stage is `COPY frontend/` only — `data/` never enters that
image, so `build-fonts.py` cannot read the catalogue. The lists are therefore
generated here, committed, and consumed by the build. CI re-runs this script and
`git diff --exit-code`s the result, so the lists cannot silently drift away from
the corpus.

TIERS (see .whl/plan/decision-fonts.md)
  1  every codepoint a user sees before opening a syllabus: course names,
     departments, teachers, rooms, division/credit meta, plus every literal in
     frontend/src (all UI chrome).
  2  the rest of the corpus (syllabus prose) UNION the remainder of Big5
     Level 1, so free text — the plan-name input, the LLM assistant — stays
     covered. Big5 L1 is the load-bearing half: a corpus-only subset drops
     Big5 coverage to 68.9%.
  3  is NOT listed here. It is computed at build time as
     (everything the merged font has) - tier1 - tier2, so it needs no corpus.

Run from the repository root:  python3 frontend/scripts/font-tiers.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent / "font-tiers"

# Catalogue fields that render in a list/card/table before any syllabus is open.
CHROME_FIELDS = (
    "name_zh",
    "name_en",
    "department",
    "raw_department",
    "teacher",
    "teacher_en",
    "required_elective_name",
    "division",
    "class_group",
)
# Syllabus prose — only reachable by opening a course detail.
PROSE_SECTIONS = (
    "objective",
    "weekly_progress",
    "prerequisite",
    "skills",
    "materials",
    "assessment",
)

SOURCE_SUFFIXES = {".ts", ".tsx", ".css", ".html", ".json", ".js", ".mjs", ".md"}


def big5_level1() -> set[str]:
    """Big5 lead bytes A1-C6: the symbol block plus all 5,411 Level-1 hanzi."""
    out: set[str] = set()
    trail = list(range(0x40, 0x7F)) + list(range(0xA1, 0xFF))
    for hi in range(0xA1, 0xC7):
        for lo in trail:
            try:
                out.add(bytes([hi, lo]).decode("big5"))
            except UnicodeDecodeError:
                continue
    return out


def walk(node, sink: set[str]) -> None:
    if isinstance(node, str):
        sink.update(node)
    elif isinstance(node, dict):
        for value in node.values():
            walk(value, sink)
    elif isinstance(node, list):
        for value in node:
            walk(value, sink)


def main() -> int:
    catalog_path = REPO / "data" / "artifacts" / "1151" / "catalog.json"
    if not catalog_path.exists():
        print(f"missing {catalog_path} — run this from a checkout with data/", file=sys.stderr)
        return 1

    chrome: set[str] = set()
    prose: set[str] = set()

    for course in json.loads(catalog_path.read_text("utf-8")):
        for field in CHROME_FIELDS:
            walk(course.get(field), chrome)
        for meeting in course.get("meetings") or []:
            walk(meeting.get("room"), chrome)
        sections = course.get("sections") or {}
        for section in PROSE_SECTIONS:
            walk(sections.get(section), prose)

    # Department tables and the match review are chrome: they back the picker.
    for name in ("departments_115.json", "ambiguous_departments_115.json",
                 "department_match_review_115.json"):
        path = REPO / "data" / "reference" / name
        if path.exists():
            walk(json.loads(path.read_text("utf-8")), chrome)

    # Every literal the UI can render, plus index.html.
    frontend = REPO / "frontend"
    for path in list((frontend / "src").rglob("*")) + [frontend / "index.html"]:
        if path.is_file() and path.suffix in SOURCE_SUFFIXES:
            chrome.update(path.read_text("utf-8", errors="ignore"))

    tier1 = {ord(c) for c in chrome if ord(c) >= 0x20}
    tier2 = {ord(c) for c in (prose | big5_level1()) if ord(c) >= 0x20} - tier1

    OUT.mkdir(exist_ok=True)
    for name, tier in (("tier1.txt", tier1), ("tier2.txt", tier2)):
        body = "".join(f"{cp:04X}\n" for cp in sorted(tier))
        (OUT / name).write_text(body, "utf-8")
        print(f"{name}: {len(tier)} codepoints")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
