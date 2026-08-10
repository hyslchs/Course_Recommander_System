from __future__ import annotations

from pathlib import Path
from typing import Any, Iterable

import orjson


def dumps_json(data: Any, *, indent: bool = False) -> bytes:
    option = orjson.OPT_APPEND_NEWLINE
    if indent:
        option |= orjson.OPT_INDENT_2
    return orjson.dumps(data, option=option)


def append_jsonl(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("ab") as fh:
        fh.write(dumps_json(data))


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(dumps_json(data, indent=True))


def iter_jsonl(path: Path) -> Iterable[Any]:
    if not path.exists():
        return
    with path.open("rb") as fh:
        for line in fh:
            line = line.strip()
            if line:
                yield orjson.loads(line)


def write_jsonl(path: Path, rows: Iterable[Any]) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with path.open("wb") as fh:
        for row in rows:
            fh.write(dumps_json(row))
            count += 1
    return count
