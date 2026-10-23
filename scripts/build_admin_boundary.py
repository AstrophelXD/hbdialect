#!/usr/bin/env python3
"""Extract mutually exclusive province, city, and county lines from display areas."""

from __future__ import annotations

import json
from itertools import pairwise
from pathlib import Path

from shapely.geometry import GeometryCollection, LineString, MultiLineString, mapping, shape
from shapely.ops import linemerge, unary_union
from shapely.strtree import STRtree


ROOT = Path(__file__).resolve().parents[1]
SOURCE_PATH = ROOT / "data" / "display_areas_simplified.geojson"
OUTPUT_PATH = ROOT / "data" / "admin_boundary.geojson"
LEVELS = ("county", "city", "province")
REQUIRED_PROPERTIES = ("display_id", "province_code", "city_code")
LENGTH_TOLERANCE = 1e-10
OVERLAP_RATIO = 1 - 1e-7


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def polygon_parts(geometry):
    if geometry.geom_type == "Polygon":
        yield geometry
    elif geometry.geom_type == "MultiPolygon":
        yield from geometry.geoms
    elif isinstance(geometry, GeometryCollection):
        for part in geometry.geoms:
            yield from polygon_parts(part)


def line_parts(geometry):
    if geometry.geom_type == "LineString":
        if geometry.length > LENGTH_TOLERANCE:
            yield geometry
    elif geometry.geom_type in {"MultiLineString", "GeometryCollection"}:
        for part in geometry.geoms:
            yield from line_parts(part)


def atomic_segments(line_network):
    for line in line_parts(line_network):
        for start, end in pairwise(line.coords):
            segment = LineString((start, end))
            if segment.length > LENGTH_TOLERANCE:
                yield segment


def merge_lines(lines: list[LineString]):
    noded = unary_union(lines)
    if noded.geom_type == "LineString":
        return noded
    merged = linemerge(noded)
    if merged.geom_type not in {"LineString", "MultiLineString"}:
        raise RuntimeError(f"Unexpected merged line type: {merged.geom_type}")
    return merged


def main() -> None:
    payload = load_json(SOURCE_PATH)
    features = payload.get("features", [])
    if not features:
        raise RuntimeError("The simplified display-area file has no features.")

    properties = []
    geometries = []
    display_ids = set()
    for feature in features:
        props = feature.get("properties", {})
        missing = [key for key in REQUIRED_PROPERTIES if not props.get(key)]
        if missing:
            raise RuntimeError(
                f"Display feature is missing required properties {missing}: {props!r}"
            )
        display_id = str(props["display_id"])
        if display_id in display_ids:
            raise RuntimeError(f"Duplicate display_id in simplified areas: {display_id}")
        display_ids.add(display_id)

        geometry = shape(feature["geometry"])
        if geometry.is_empty or not geometry.is_valid:
            raise RuntimeError(f"Invalid simplified geometry for {display_id}.")
        if geometry.geom_type not in {"Polygon", "MultiPolygon"}:
            raise RuntimeError(f"Non-polygon display geometry for {display_id}.")
        properties.append(props)
        geometries.append(geometry)

    line_network = unary_union([geometry.boundary for geometry in geometries])
    if line_network.is_empty:
        raise RuntimeError("Failed to construct a boundary network.")

    province_geometry = unary_union(geometries)
    province_exteriors = unary_union(
        [LineString(polygon.exterior.coords) for polygon in polygon_parts(province_geometry)]
    )
    tree = STRtree(geometries)
    segments_by_level = {level: [] for level in LEVELS}
    excluded_hole_segments = []
    source_segment_count = 0

    for segment in atomic_segments(line_network):
        source_segment_count += 1
        adjacent_indices = []
        for index in tree.query(segment, predicate="intersects"):
            overlap_length = geometries[index].boundary.intersection(segment).length
            if overlap_length >= segment.length * OVERLAP_RATIO:
                adjacent_indices.append(int(index))

        adjacent_indices = sorted(set(adjacent_indices))
        if len(adjacent_indices) == 1:
            exterior_overlap = province_exteriors.intersection(segment).length
            if exterior_overlap >= segment.length * OVERLAP_RATIO:
                segments_by_level["province"].append(segment)
            else:
                excluded_hole_segments.append(segment)
            continue

        if len(adjacent_indices) != 2:
            raise RuntimeError(
                f"Boundary segment has {len(adjacent_indices)} adjacent display areas; "
                "the simplified polygons are not a clean planar partition."
            )

        left = properties[adjacent_indices[0]]
        right = properties[adjacent_indices[1]]
        if str(left["display_id"]) == str(right["display_id"]):
            continue
        if str(left["province_code"]) != str(right["province_code"]):
            level = "province"
        elif str(left["city_code"]) != str(right["city_code"]):
            level = "city"
        else:
            level = "county"
        segments_by_level[level].append(segment)

    if any(not segments_by_level[level] for level in LEVELS):
        empty_levels = [level for level in LEVELS if not segments_by_level[level]]
        raise RuntimeError(f"No boundary segments generated for levels: {empty_levels}")

    merged_by_level = {
        level: merge_lines(segments_by_level[level]) for level in LEVELS
    }
    for index, level in enumerate(LEVELS):
        for other_level in LEVELS[index + 1 :]:
            overlap = merged_by_level[level].intersection(merged_by_level[other_level]).length
            if overlap > LENGTH_TOLERANCE:
                raise RuntimeError(
                    f"Boundary levels {level} and {other_level} overlap by {overlap}."
                )

    output = {
        "type": "FeatureCollection",
        "name": "Hubei administrative boundaries",
        "schema_version": 1,
        "source": "display_areas_simplified.geojson",
        "coverage": {
            "display_features": len(features),
            "source_segments": source_segment_count,
            "rendered_segments": sum(len(value) for value in segments_by_level.values()),
            "excluded_hole_segments": len(excluded_hole_segments),
        },
        "features": [
            {
                "type": "Feature",
                "properties": {
                    "level": level,
                    "segment_count": len(segments_by_level[level]),
                },
                "geometry": mapping(merged_by_level[level]),
            }
            for level in LEVELS
        ],
    }
    OUTPUT_PATH.write_text(
        json.dumps(output, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    counts = ", ".join(
        f"{level}={len(segments_by_level[level])}" for level in LEVELS
    )
    print(
        f"Wrote mutually exclusive boundaries ({counts}; "
        f"excluded_holes={len(excluded_hole_segments)}) to {OUTPUT_PATH}"
    )


if __name__ == "__main__":
    main()
