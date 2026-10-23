#!/usr/bin/env python3
"""Extract the second vocabulary column, "睡觉", from 《湖北省志·方言》.

The requested PDF pages 342-345 correspond to printed pages 333-336 and to
pages 359-362 in the Hubei Gazetteer official viewer. The official PDFs have
a text layer, but their custom font maps many glyphs to incorrect Unicode.
This script therefore:

1. downloads (or reuses) the four official single-page PDFs;
2. locates table rows by text-layer coordinates and validates row counts;
3. applies a cell-by-cell transcription checked against 300 dpi renders;
4. writes schema 1.1 UTF-8 JSON, including atomic display-value metadata.

Dependency: pdfplumber

Example:
    python scripts/extract_shuijiao_column.py
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

try:
    import pdfplumber
except ImportError as exc:  # pragma: no cover - environment-specific message
    raise SystemExit("Missing dependency: install pdfplumber first.") from exc


ROOT = Path(__file__).resolve().parents[1]
BOOK_ID = "257d4a18-b60e-4198-805c-a9715bc270ee"
SOURCE_ID = "hubei-province-gazetteer-dialect-1996"
PAGE_URL = (
    "http://zy.library.hb.cn:8090/dfz/onetable/browse/pdf.jsp"
    f"?id={BOOK_ID}&page={{viewer_page}}"
)


@dataclass(frozen=True)
class PageRef:
    pdf_page: int
    printed_page: int
    viewer_page: int


@dataclass(frozen=True)
class VerifiedRow:
    region: int
    place: str
    value: str


PAGES = (
    PageRef(pdf_page=342, printed_page=333, viewer_page=359),
    PageRef(pdf_page=343, printed_page=334, viewer_page=360),
    PageRef(pdf_page=344, printed_page=335, viewer_page=361),
    PageRef(pdf_page=345, printed_page=336, viewer_page=362),
)


# Values are faithful transcriptions from the scans. Slash-separated variants
# remain in source order and are not silently merged or normalized away.
VERIFIED_ROWS: dict[int, tuple[VerifiedRow, ...]] = {
    359: (
        VerifiedRow(1, "武汉", "睡瞌睡"),
        VerifiedRow(1, "汉川", "睡瞌睡"),
        VerifiedRow(1, "沔阳", "睡瞌睡"),
        VerifiedRow(1, "洪湖", "睡瞌睡"),
        VerifiedRow(1, "天门", "睡瞌睡"),
        VerifiedRow(1, "监利", "睡瞌睡"),
        VerifiedRow(1, "京山", "睡瞌睡"),
        VerifiedRow(1, "潜江", "睡觉"),
        VerifiedRow(1, "钟祥", "睡瞌睡"),
        VerifiedRow(1, "石首", "睡瞌睡"),
        VerifiedRow(1, "荆门", "睡瞌睡"),
        VerifiedRow(1, "沙市", "睡瞌睡"),
        VerifiedRow(1, "江陵", "睡瞌睡"),
        VerifiedRow(1, "公安", "睡瞌睡"),
        VerifiedRow(1, "松滋", "睡瞌睡"),
        VerifiedRow(1, "随州", "睡瞌睡"),
        VerifiedRow(1, "枣阳", "睡瞌睡"),
        VerifiedRow(1, "襄樊", "睡瞌睡"),
    ),
    360: (
        VerifiedRow(1, "宜城", "睡瞌睡"),
        VerifiedRow(1, "南漳", "睡瞌睡"),
        VerifiedRow(1, "老河口", "睡瞌睡"),
        VerifiedRow(1, "谷城", "睡瞌睡"),
        VerifiedRow(1, "保康", "睡"),
        VerifiedRow(1, "当阳", "睡瞌睡"),
        VerifiedRow(1, "远安", "睡觉/睡瞌睡"),
        VerifiedRow(1, "枝江", "睡瞌睡"),
        VerifiedRow(1, "宜昌", "睡瞌睡"),
        VerifiedRow(1, "宜都", "睡瞌睡"),
        VerifiedRow(1, "长阳", "睡瞌睡"),
        VerifiedRow(1, "兴山", "睡瞌睡"),
        VerifiedRow(1, "秭归", "睡瞌睡"),
        VerifiedRow(1, "五峰", "睡瞌睡"),
        VerifiedRow(1, "丹江口", "睡瞌睡"),
        VerifiedRow(1, "郧县", "睡瞌睡"),
        VerifiedRow(1, "十堰", "睡瞌睡"),
        VerifiedRow(1, "房县", "睡瞌睡"),
        VerifiedRow(1, "神农架", "睡瞌睡"),
        VerifiedRow(1, "郧西", "睡瞌睡"),
        VerifiedRow(1, "巴东", "睡瞌睡"),
    ),
    361: (
        VerifiedRow(1, "鹤峰", "睡瞌睡"),
        VerifiedRow(1, "建始", "睡瞌睡"),
        VerifiedRow(1, "恩施", "睡瞌睡"),
        VerifiedRow(1, "宣恩", "睡瞌睡"),
        VerifiedRow(1, "来凤", "睡瞌睡"),
        VerifiedRow(1, "咸丰", "睡瞌睡"),
        VerifiedRow(1, "利川", "睡瞌睡"),
        VerifiedRow(2, "黄梅", "困醒"),
        VerifiedRow(2, "英山", "困醒"),
        VerifiedRow(2, "蕲春", "睡瞌睡"),
        VerifiedRow(2, "武穴", "困醒"),
        VerifiedRow(2, "罗田", "睡觉"),
        VerifiedRow(2, "浠水", "困醒"),
        VerifiedRow(2, "黄石", "睡瞌睡"),
        VerifiedRow(2, "麻城", "睡瞌睡"),
        VerifiedRow(2, "黄冈", "困觉"),
        VerifiedRow(2, "鄂州", "睡觉"),
        VerifiedRow(2, "新洲", "纳福"),
        VerifiedRow(2, "红安", "睡瞌睡/困觉"),
    ),
    362: (
        VerifiedRow(2, "黄陂", "睡瞌睡"),
        VerifiedRow(2, "大悟", "睡瞌睡"),
        VerifiedRow(2, "孝感", "睡瞌睡"),
        VerifiedRow(2, "应山", "睡瞌睡"),
        VerifiedRow(2, "安陆", "睡瞌睡"),
        VerifiedRow(2, "云梦", "困觉"),
        VerifiedRow(2, "应城", "睡瞌睡"),
        VerifiedRow(2, "竹山", "睡瞌睡"),
        VerifiedRow(2, "竹溪", "睡觉"),
        VerifiedRow(3, "阳新", "困"),
        VerifiedRow(3, "大冶", "困醒"),
        VerifiedRow(3, "通山", "困醒"),
        VerifiedRow(3, "咸宁", "睡瞌睡"),
        VerifiedRow(3, "崇阳", "睡瞌睡"),
        VerifiedRow(3, "嘉鱼", "睡瞌睡"),
        VerifiedRow(3, "蒲圻", "睡瞌睡"),
        VerifiedRow(3, "通城", "困觉"),
    ),
}


# Atomic values are ordered by display priority, not by Unicode sorting.
DISPLAY_VALUES = ("睡瞌睡", "困醒", "睡觉", "困觉", "睡", "纳福", "困")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source-dir",
        type=Path,
        default=ROOT / "tmp" / "pdfs",
        help="Directory containing page-359.pdf through page-362.pdf.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ROOT / "data" / "extracted" / "shuijiao.json",
        help="UTF-8 JSON output path.",
    )
    parser.add_argument(
        "--refresh",
        action="store_true",
        help="Redownload the four official single-page PDFs.",
    )
    parser.add_argument(
        "--no-download",
        action="store_true",
        help="Fail instead of downloading a missing PDF.",
    )
    parser.add_argument(
        "--include-text-layer",
        action="store_true",
        help="Include the uncorrected text-layer observations for auditing.",
    )
    return parser.parse_args()


def download_page(page_ref: PageRef, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(
        PAGE_URL.format(viewer_page=page_ref.viewer_page),
        headers={"User-Agent": "hbdialect-data-extractor/1.1"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = response.read()
    if not payload.startswith(b"%PDF-"):
        raise RuntimeError(
            f"Official viewer page {page_ref.viewer_page} did not return a PDF."
        )
    destination.write_bytes(payload)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def get_source_pdf(
    page_ref: PageRef, source_dir: Path, refresh: bool, no_download: bool
) -> Path:
    path = source_dir / f"page-{page_ref.viewer_page}.pdf"
    if refresh or not path.exists():
        if no_download:
            raise FileNotFoundError(f"Missing source PDF: {path}")
        download_page(page_ref, path)
    if path.read_bytes()[:5] != b"%PDF-":
        raise RuntimeError(f"Invalid PDF header: {path}")
    return path


def nearest_word(
    words: Iterable[dict[str, Any]], target_top: float, tolerance: float = 4.0
) -> dict[str, Any] | None:
    candidates = [word for word in words if abs(float(word["top"]) - target_top) <= tolerance]
    if not candidates:
        return None
    return min(candidates, key=lambda word: abs(float(word["top"]) - target_top))


def extract_text_layer_rows(
    pdf_path: Path, *, minimum_top: float = 0.0
) -> list[dict[str, Any]]:
    """Locate place/value row pairs; text may contain incorrect Unicode."""
    with pdfplumber.open(pdf_path) as document:
        if len(document.pages) != 1:
            raise RuntimeError(f"Expected a single-page PDF: {pdf_path}")
        words = document.pages[0].extract_words(
            use_text_flow=False,
            keep_blank_chars=False,
        )

    left_words = [
        word
        for word in words
        if 55.0 <= float(word["x0"]) < 135.0
        and float(word["top"]) >= minimum_top
    ]
    value_words = [word for word in words if 190.0 <= float(word["x0"]) < 285.0]

    rows: list[dict[str, Any]] = []
    for place_word in sorted(left_words, key=lambda word: float(word["top"])):
        value_word = nearest_word(value_words, float(place_word["top"]))
        if value_word is None:
            continue
        rows.append(
            {
                "text_layer_place": str(place_word["text"]),
                "text_layer_value": str(value_word["text"]),
                "top": round(float(place_word["top"]), 3),
            }
        )
    return rows


def validate_manifest() -> None:
    all_rows = [row for page_rows in VERIFIED_ROWS.values() for row in page_rows]
    if len(all_rows) != 75:
        raise RuntimeError(f"Expected 75 verified rows, got {len(all_rows)}.")
    places = [row.place for row in all_rows]
    if len(set(places)) != 75:
        raise RuntimeError("Verified place names are not unique.")
    region_counts = {
        region: sum(row.region == region for row in all_rows) for region in (1, 2, 3)
    }
    if region_counts != {1: 46, 2: 21, 3: 8}:
        raise RuntimeError(f"Unexpected region counts: {region_counts}")

    atomic_values = {
        variant for row in all_rows for variant in row.value.split("/")
    }
    if atomic_values != set(DISPLAY_VALUES):
        raise RuntimeError(
            f"Display values do not cover the transcription: {sorted(atomic_values)}"
        )


def build_output(args: argparse.Namespace) -> dict[str, Any]:
    validate_manifest()
    records: list[dict[str, Any]] = []
    page_files: list[dict[str, Any]] = []
    source_order = 0

    for page_ref in PAGES:
        pdf_path = get_source_pdf(
            page_ref,
            args.source_dir,
            refresh=args.refresh,
            no_download=args.no_download,
        )
        observations = extract_text_layer_rows(
            pdf_path,
            minimum_top=150.0 if page_ref.viewer_page == 359 else 0.0,
        )
        verified_rows = VERIFIED_ROWS[page_ref.viewer_page]
        if len(observations) != len(verified_rows):
            raise RuntimeError(
                f"Row-count mismatch on viewer page {page_ref.viewer_page}: "
                f"text layer={len(observations)}, verified={len(verified_rows)}"
            )

        page_files.append(
            {
                "pdf_page": page_ref.pdf_page,
                "printed_page": page_ref.printed_page,
                "official_viewer_page": page_ref.viewer_page,
                "sha256": sha256_file(pdf_path),
            }
        )

        for verified, observation in zip(verified_rows, observations, strict=True):
            source_order += 1
            record: dict[str, Any] = {
                "record_id": f"shuijiao-hb-fy-{source_order:03d}",
                "concept_id": "shuijiao",
                "place_id": f"hb-fy-{source_order:03d}",
                "historical_name": verified.place,
                "dialect_region": verified.region,
                "raw_value": verified.value,
                "normalized_value": verified.value,
                "variants": verified.value.split("/"),
                "notation_type": "汉字",
                "source_id": SOURCE_ID,
                "printed_page": page_ref.printed_page,
                "pdf_page": page_ref.pdf_page,
                "official_viewer_page": page_ref.viewer_page,
                "review_status": "复核",
                "source_order": source_order,
            }
            if args.include_text_layer:
                record["text_layer_observation"] = observation
            records.append(record)

    value_counts: dict[str, int] = {}
    for record in records:
        value = str(record["raw_value"])
        value_counts[value] = value_counts.get(value, 0) + 1

    return {
        "schema_version": "1.1",
        "concept": {
            "id": "shuijiao",
            "mandarin_label": "睡觉",
            "source_column_index": 2,
            "source_column_scope": "普通话词语列（不含地点列）",
        },
        "visualization": {
            "palette_id": "hubei-administrative-pastel-v1",
            "color_assignments": [
                {"value": value, "family": index, "color_index": 2}
                for index, value in enumerate(DISPLAY_VALUES, start=1)
            ],
            "fallback": {"label": "其他", "family": 8, "color_index": 2},
        },
        "source": {
            "source_id": SOURCE_ID,
            "title": "《湖北省志·方言》",
            "publication_year": 1996,
            "official_book_id": BOOK_ID,
            "official_viewer_url": (
                "http://zy.library.hb.cn:8090/dfz/onetable/browse/main.jsp"
                f"?id={BOOK_ID}"
            ),
            "requested_pdf_pages": [page.pdf_page for page in PAGES],
            "printed_pages": [page.printed_page for page in PAGES],
            "official_viewer_pages": [page.viewer_page for page in PAGES],
            "page_files": page_files,
            "extraction_method": (
                "pdfplumber 坐标定位表格行；300 dpi 页面逐格复核并纠正自定义字体文字层错码"
            ),
            "verification": "75/75 个调查点已按 300 dpi 渲染图复核",
        },
        "record_count": len(records),
        "region_counts": {
            str(region): sum(record["dialect_region"] == region for record in records)
            for region in (1, 2, 3)
        },
        "value_counts": dict(sorted(value_counts.items())),
        "records": records,
    }


def main() -> int:
    args = parse_args()
    output = build_output(args)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(output, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {output['record_count']} records to {args.output}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
