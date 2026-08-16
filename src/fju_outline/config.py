from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


BASE_URL = "https://travellerlink.fju.edu.tw/Outline/api"
SOURCE_VIEW_URL = "https://outline.fju.edu.tw/#/outlineSearch/outlineView/{jon_cou_sn}/{lcid}"
DEFAULT_HY = 115
DEFAULT_HT = 1
DEFAULT_SCO_TYP = 100
DEFAULT_LCID = 1028
DEFAULT_PAGE_SIZE = 100
DEFAULT_CONCURRENCY = 3
DEFAULT_TIMEOUT_SECONDS = 45
DEFAULT_RETRIES = 3


@dataclass(frozen=True)
class DatasetPaths:
    base_dir: Path
    hy: int
    ht: int

    @property
    def tag(self) -> str:
        return f"{self.hy}{self.ht}"

    @property
    def raw_dir(self) -> Path:
        return self.base_dir / "data" / "raw"

    @property
    def canonical_dir(self) -> Path:
        return self.base_dir / "data" / "canonical"

    @property
    def derived_dir(self) -> Path:
        return self.base_dir / "data" / "derived"

    @property
    def reference_dir(self) -> Path:
        return self.base_dir / "data" / "reference"

    @property
    def artifacts_dir(self) -> Path:
        return self.base_dir / "data" / "artifacts" / self.tag

    @property
    def log_dir(self) -> Path:
        return self.base_dir / "logs"

    @property
    def raw_jsonl(self) -> Path:
        return self.raw_dir / f"course_outlines_{self.tag}.raw.jsonl"

    @property
    def list_jsonl(self) -> Path:
        return self.raw_dir / f"course_list_{self.tag}.jsonl"

    @property
    def fetch_log_jsonl(self) -> Path:
        return self.log_dir / f"fetch_log_{self.tag}.jsonl"

    @property
    def canonical_jsonl(self) -> Path:
        return self.canonical_dir / f"course_outlines_{self.tag}.jsonl"

    @property
    def validation_json(self) -> Path:
        return self.log_dir / f"validation_{self.tag}.json"

    @property
    def department_catalog_json(self) -> Path:
        return self.reference_dir / f"departments_{self.hy}.json"

    def ensure_dirs(self) -> None:
        for path in (
            self.raw_dir,
            self.canonical_dir,
            self.derived_dir,
            self.reference_dir,
            self.artifacts_dir,
            self.log_dir,
        ):
            path.mkdir(parents=True, exist_ok=True)
