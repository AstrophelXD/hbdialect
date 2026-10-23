#!/usr/bin/env python3
"""Build display polygons by dissolving configured current county-level areas."""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

from shapely.geometry import GeometryCollection, MultiPolygon, mapping, shape
from shapely.ops import unary_union
from shapely.validation import make_valid


ROOT = Path(__file__).resolve().parents[1]
SOURCE_PATH = ROOT / "hubei.geojson"
GEOGRAPHY_PATH = ROOT / "data" / "geography.json"
CONFIG_PATH = ROOT / "data" / "display-groups.json"
OUTPUT_PATH = ROOT / "data" / "display_areas.geojson"

PREFECTURE_NAMES = {
    "4201": "武汉市",
    "4202": "黄石市",
    "4203": "十堰市",
    "4205": "宜昌市",
    "4206": "襄阳市",
    "4207": "鄂州市",
    "4208": "荆门市",
    "4209": "孝感市",
    "4210": "荆州市",
    "4211": "黄冈市",
    "4212": "咸宁市",
    "4213": "随州市",
    "4228": "恩施土家族苗族自治州",
    "4290": "省直辖县级行政区",
}


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def polygonal_only(geometry):
    """Return only polygonal parts after validity repair or union."""
    if geometry.geom_type in {"Polygon", "MultiPolygon"}:
        return geometry
    if isinstance(geometry, GeometryCollection):
        polygons = []
        for part in geometry.geoms:
            if part.geom_type == "Polygon":
                polygons.append(part)
            elif part.geom_type == "MultiPolygon":
                polygons.extend(part.geoms)
        if not polygons:
            raise RuntimeError("Geometry repair produced no polygonal parts.")
        return MultiPolygon(polygons) if len(polygons) > 1 else polygons[0]
    raise RuntimeError(f"Unsupported geometry type after repair: {geometry.geom_type}")


def clean_geometry(raw_geometry: dict):
    geometry = shape(raw_geometry)
    if geometry.is_empty:
        raise RuntimeError("Encountered an empty source geometry.")
    if not geometry.is_valid:
        geometry = make_valid(geometry)
    geometry = polygonal_only(geometry)
    if not geometry.is_valid:
        raise RuntimeError("Geometry remains invalid after repair.")
    return geometry


def administrative_codes(gb: str) -> tuple[str, str]:
    """Derive Chinese province/city codes from the source's M49-prefixed gb code."""
    adcode = gb[3:] if len(gb) == 9 and gb.startswith("156") else gb
    if len(adcode) != 6 or not adcode.isdigit():
        raise RuntimeError(f"Cannot derive a six-digit administrative code from {gb!r}.")
    return adcode[:2], adcode[:4]


def main() -> None:
    source = load_json(SOURCE_PATH)
    geography = load_json(GEOGRAPHY_PATH)
    config = load_json(CONFIG_PATH)

    source_by_gb = {
        str(feature["properties"]["gb"]): feature for feature in source["features"]
    }
    area_by_gb = {str(area["gb"]): area for area in geography["areas"]}

    if set(source_by_gb) != set(area_by_gb):
        raise RuntimeError("GeoJSON and geography mapping do not contain the same gb codes.")

    member_to_group = {}
    display_ids = set()
    display_names = set()
    for group in config["groups"]:
        display_id = str(group["display_id"])
        display_name = str(group["display_name"])
        if display_id in display_ids:
            raise RuntimeError(f"Duplicate display_id: {display_id}")
        if display_name in display_names:
            raise RuntimeError(f"Duplicate display_name: {display_name}")
        display_ids.add(display_id)
        display_names.add(display_name)

        for member in group["members"]:
            gb = str(member["gb"])
            if gb in member_to_group:
                raise RuntimeError(f"Area {gb} appears in more than one display group.")
            if gb not in source_by_gb:
                raise RuntimeError(f"Configured area {gb} is missing from the source GeoJSON.")
            mapped_name = str(area_by_gb[gb]["name"])
            if mapped_name != str(member["name"]):
                raise RuntimeError(
                    f"Name mismatch for {gb}: config={member['name']!r}, mapping={mapped_name!r}"
                )
            member_to_group[gb] = group

    units = []
    emitted_custom_ids = set()
    for gb in sorted(source_by_gb):
        custom_group = member_to_group.get(gb)
        if custom_group is not None:
            display_id = str(custom_group["display_id"])
            if display_id in emitted_custom_ids:
                continue
            emitted_custom_ids.add(display_id)
            member_gbs = [str(member["gb"]) for member in custom_group["members"]]
            display_name = str(custom_group["display_name"])
            display_level = "custom"
        else:
            display_id = gb
            member_gbs = [gb]
            display_name = str(area_by_gb[gb]["name"])
            display_level = "county"

        member_names = [str(area_by_gb[member_gb]["name"]) for member_gb in member_gbs]
        group_ids = list(
            dict.fromkeys(str(area_by_gb[member_gb]["group_id"]) for member_gb in member_gbs)
        )
        code_pairs = {administrative_codes(member_gb) for member_gb in member_gbs}
        if len(code_pairs) != 1:
            raise RuntimeError(
                f"Display group {display_id} crosses province or prefecture boundaries: "
                f"{sorted(code_pairs)}"
            )
        province_code, city_code = code_pairs.pop()
        prefecture_name = PREFECTURE_NAMES.get(city_code)
        if prefecture_name is None:
            raise RuntimeError(f"No prefecture name configured for city code {city_code}.")
        geometries = [
            clean_geometry(source_by_gb[member_gb]["geometry"]) for member_gb in member_gbs
        ]
        dissolved = polygonal_only(unary_union(geometries))
        if dissolved.is_empty or not dissolved.is_valid:
            raise RuntimeError(f"Invalid dissolved geometry for {display_id}.")

        units.append(
            (
                min(member_gbs),
                {
                    "type": "Feature",
                    "properties": {
                        "display_id": display_id,
                        "display_name": display_name,
                        "display_level": display_level,
                        "province_code": province_code,
                        "city_code": city_code,
                        "prefecture_name": prefecture_name,
                        "member_gbs": member_gbs,
                        "member_names": member_names,
                        "group_ids": group_ids,
                    },
                    "geometry": mapping(dissolved),
                },
            )
        )

    units.sort(key=lambda item: item[0])
    features = [feature for _, feature in units]
    covered_gbs = [
        gb for feature in features for gb in feature["properties"]["member_gbs"]
    ]
    coverage_counts = Counter(covered_gbs)
    if set(coverage_counts) != set(source_by_gb):
        raise RuntimeError("Display features do not cover every source area.")
    duplicated = [gb for gb, count in coverage_counts.items() if count != 1]
    if duplicated:
        raise RuntimeError(f"Source areas are covered more than once: {duplicated}")

    expected_count = len(source_by_gb) - sum(
        len(group["members"]) - 1 for group in config["groups"]
    )
    if len(features) != expected_count:
        raise RuntimeError(
            f"Expected {expected_count} display areas, generated {len(features)}."
        )

    payload = {
        "type": "FeatureCollection",
        "name": "Hubei display areas",
        "schema_version": 1,
        "source": "../hubei.geojson",
        "merge_config": "display-groups.json",
        "coverage": {
            "source_features": len(source_by_gb),
            "display_features": len(features),
            "custom_groups": len(config["groups"]),
            "merged_source_features": len(member_to_group),
        },
        "features": features,
    }
    OUTPUT_PATH.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    print(
        f"Wrote {len(features)} display areas from {len(source_by_gb)} source features "
        f"({len(config['groups'])} custom groups) to {OUTPUT_PATH}"
    )


if __name__ == "__main__":
    main()
