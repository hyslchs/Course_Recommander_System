#!/usr/bin/env python3
"""Build the three-tier "FJU Sans" webfonts from @fontsource/noto-sans-tc (T41b).

WHAT THIS REPLACES
fontsource ships Noto Sans TC as 105 `unicode-range` slices per weight. Four
weights of that is 420 @font-face rules whose `unicode-range` hex strings alone
are ~330 kB of render-blocking, barely-compressible CSS — measured 250 kB gzip
on the wire, which is what the browser must parse before it can paint anything.
The glyphs were never the problem; the CSS was.

WHAT IT DOES INSTEAD
Merges the 105 slices back into one font per weight (fontTools.merge, keeping
GSUB/GPOS/GDEF/BASE — dropping them widens kerned Latin by 2.3%), then cuts each
into three tiers declared as three FAMILIES rather than three unicode-ranges:

  FJU Sans 1   everything visible before a syllabus is opened
  FJU Sans 2   syllabus prose + the rest of Big5 Level 1 (free-text safety net)
  FJU Sans 3   every remaining codepoint the source font has

`font-family: "FJU Sans 1","FJU Sans 2","FJU Sans 3"` gives byte-identical
coverage in 12 @font-face rules with zero `unicode-range`. The browser resolves
per codepoint, so tier 2 and 3 are only fetched when a character actually needs
them — coarser than 105 slices, but capped and cached.

TIER LISTS are committed under scripts/font-tiers/ because the frontend Docker
stage only does `COPY frontend/` and cannot see data/. Regenerate with
scripts/font-tiers.py; CI diffs the result.

OFL-1.1 CLAUSE 2 is why `--name-IDs='*'` and the LICENSE copy below exist: the
fontsource binaries carry an empty nameID 13 and pyftsubset drops nameID 14
outright, so before this script dist/ shipped a modified OFL font with no
copyright notice and no licence anywhere. That was a pre-existing gap.

Requires: fonttools>=4.63, brotli (for woff2).
Usage:    python3 frontend/scripts/build-fonts.py [--force]
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
import tempfile
from pathlib import Path

FRONTEND = Path(__file__).resolve().parents[1]
FONTSOURCE = FRONTEND / "node_modules" / "@fontsource" / "noto-sans-tc"
TIER_DIR = Path(__file__).resolve().parent / "font-tiers"
OUT_DIR = FRONTEND / "src" / "assets" / "fonts"
LICENSE_COPY = FRONTEND / "public" / "assets" / "OFL.txt"
WEIGHTS = (400, 500, 600, 700)
MANIFEST = OUT_DIR / "manifest.json"

# Every layout feature is kept. pyftsubset's default `--layout-features` is a
# curated list that drops, among others, `kern`-adjacent GPOS lookups this font
# uses for Latin; a fidelity check measured kerned Latin 2.3% wider without them.
SUBSET_OPTIONS = {
    "layout_features": ["*"],
    "name_IDs": ["*"],
    "name_legacy": True,
    "name_languages": ["*"],
    "notdef_outline": True,
    "recalc_bounds": False,
    "drop_tables": [],
    "passthrough_tables": True,
}


def slice_files(weight: int) -> list[Path]:
    """The 105 woff2 fontsource's <weight>.css declares, in declaration order."""
    css = (FONTSOURCE / f"{weight}.css").read_text("utf-8")
    names = re.findall(r"url\(\./files/([^)]+\.woff2)\)", css)
    if len(names) < 100:
        raise SystemExit(
            f"{weight}.css declared {len(names)} woff2 slices, expected ~105. "
            "The @fontsource layout changed — fix this script rather than shipping "
            "a font with holes in it."
        )
    return [FONTSOURCE / "files" / name for name in names]


def read_tier(name: str) -> set[int]:
    text = (TIER_DIR / name).read_text("utf-8")
    return {int(line, 16) for line in text.split() if line}


def fingerprint(tier1: set[int], tier2: set[int]) -> str:
    meta = json.loads((FONTSOURCE / "metadata.json").read_text("utf-8"))
    digest = hashlib.sha256()
    digest.update(f"{meta['id']}@{meta['version']}".encode())
    digest.update(Path(__file__).read_bytes())
    digest.update(repr(sorted(tier1)).encode())
    digest.update(repr(sorted(tier2)).encode())
    return digest.hexdigest()


def main() -> int:
    force = "--force" in sys.argv
    try:
        from fontTools.merge import Merger
        from fontTools.subset import Options, Subsetter
        from fontTools.ttLib import TTFont
    except ImportError:
        print(
            "build-fonts: fontTools is required.\n"
            "  pip install 'fonttools>=4.63' brotli\n"
            "(Docker/alpine: apk add python3 py3-pip py3-brotli && "
            "pip install --break-system-packages fonttools)",
            file=sys.stderr,
        )
        return 1

    # OFL-1.1 clause 2: every copy, modified or not, ships with the notice.
    # `public/` is copied verbatim into dist, so the committed OFL.txt lands in
    # dist/assets/ next to the woff2 the browser actually fetches. It is
    # committed rather than generated here so it exists even if this script is
    # skipped; the equality check is what stops it drifting from the upstream
    # licence after a @fontsource bump.
    upstream = (FONTSOURCE / "LICENSE").read_bytes()
    if LICENSE_COPY.read_bytes() != upstream:
        LICENSE_COPY.write_bytes(upstream)
        print(
            f"build-fonts: refreshed {LICENSE_COPY.relative_to(FRONTEND)} from "
            "@fontsource — commit it (OFL-1.1 clause 2).",
            file=sys.stderr,
        )
        return 1

    tier1 = read_tier("tier1.txt")
    tier2 = read_tier("tier2.txt")
    stamp = fingerprint(tier1, tier2)

    if not force and MANIFEST.exists():
        try:
            cached = json.loads(MANIFEST.read_text("utf-8"))
        except json.JSONDecodeError:
            cached = {}
        if cached.get("fingerprint") == stamp and all(
            (OUT_DIR / name).exists() for name in cached.get("files", [])
        ):
            print(f"build-fonts: up to date ({len(cached['files'])} files)")
            return 0

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    written: list[str] = []
    totals: dict[str, int] = {}

    with tempfile.TemporaryDirectory() as tmp:
        for weight in WEIGHTS:
            merged_path = Path(tmp) / f"merged-{weight}.ttf"
            Merger().merge([str(p) for p in slice_files(weight)]).save(merged_path)
            covered = set(TTFont(merged_path, lazy=True).getBestCmap())

            # Tier 3 is the remainder, so the three tiers partition the source
            # font exactly: coverage after the split equals coverage before it.
            keep1 = tier1 & covered
            keep2 = tier2 & covered
            keep3 = covered - keep1 - keep2
            for index, keep in ((1, keep1), (2, keep2), (3, keep3)):
                options = Options(**SUBSET_OPTIONS)
                options.flavor = "woff2"
                font = TTFont(merged_path)
                subsetter = Subsetter(options=options)
                subsetter.populate(unicodes=keep)
                subsetter.subset(font)
                # nameID 16/17 keep the family selectable in editors; 1/4 are
                # what the browser matches, so they carry the tier.
                name_table = font["name"]
                family = f"FJU Sans {index}"
                for name_id, value in (
                    (1, family),
                    (4, f"{family} {weight}"),
                    (6, f"FJUSans{index}-{weight}"),
                    (16, family),
                ):
                    name_table.setName(value, name_id, 3, 1, 0x409)
                out = OUT_DIR / f"fju-sans-{index}-{weight}.woff2"
                font.flavor = "woff2"
                font.flavorData = None
                font.save(out)
                font.close()
                written.append(out.name)
                totals[out.name] = out.stat().st_size
                print(f"  {out.name}: {len(keep)} cp, {out.stat().st_size:,} B")


    MANIFEST.write_text(
        json.dumps({"fingerprint": stamp, "files": sorted(written)}, indent=2) + "\n",
        "utf-8",
    )
    print(f"build-fonts: {len(written)} woff2, {sum(totals.values()):,} B total")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
