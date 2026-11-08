"""Compact text renderings of operation results, read by the chat agent."""

import json
from typing import Any, Mapping


def format_inspection(report: Mapping[str, Any]) -> str:
    """Render an inspect_mesh report as compact text for the model."""
    def yes_no(value) -> str:
        return "unknown" if value is None else ("yes" if value else "no")

    dims = " × ".join(f"{d:.4g}" for d in report.get("dimensions", []))
    volume = report.get("volume")
    self_hits = report.get("self_intersecting_face_count")
    lines = [
        f"Printable: {yes_no(report.get('printable'))}",
        f"Faces: {report.get('face_count', '?'):,}, vertices: {report.get('vertex_count', '?'):,}, parts: {report.get('component_count', '?')}",
        f"Watertight: {yes_no(report.get('is_watertight'))}, manifold: {yes_no(report.get('is_manifold'))}, consistent winding: {yes_no(report.get('is_winding_consistent'))}",
        f"Holes: {report.get('hole_count', 0)} ({report.get('boundary_edge_count', 0)} open edges), non-manifold edges: {report.get('non_manifold_edge_count', 0)}, degenerate faces: {report.get('degenerate_face_count', 0)}",
        f"Self-intersecting faces: {'not checked' if self_hits is None else self_hits}",
        f"Dimensions: {dims}, surface area: {report.get('surface_area', 0):.4g}, volume: {'n/a (not closed)' if volume is None else f'{volume:.4g}'}",
        f"UVs: {yes_no(report.get('has_uvs'))}, normals: {yes_no(report.get('has_normals'))}",
    ]
    issues = report.get("issues") or []
    if issues:
        lines.append("Issues: " + "; ".join(issues))
    return "\n".join(lines)


def format_fixes(data: Mapping[str, Any]) -> str:
    """Render a suggest_fixes result as compact text for the model."""
    fixes = data.get("fixes") or []
    notes = data.get("notes") or []
    if not fixes and not notes:
        return "No fixes needed — the mesh has no detected problems."
    lines = ["Suggested operations:"] if fixes else ["No operation can fix the detected problems."]
    for fix in fixes:
        lines.append(f"- {fix['op']} {json.dumps(fix.get('params', {}))}: {fix.get('reason', '')}")
    lines.extend(f"Note: {note}" for note in notes)
    return "\n".join(lines)


def format_repair(data: Mapping[str, Any]) -> str:
    """Render a repair_mesh result as compact text for the model."""
    remaining = data.get("remaining_issues") or []
    if not data.get("repaired"):
        if remaining:
            return "Nothing was repaired. Remaining: " + "; ".join(remaining) + "."
        return "Nothing to repair: the mesh is already closed and manifold."

    steps = ", ".join(data.get("steps") or [])
    lines = [
        f"Repaired in {data.get('passes', '?')} pass(es) ({steps}).",
        ("Still remaining: " + "; ".join(remaining) + ".") if remaining
        else "The mesh is now closed (watertight) and manifold.",
        f"New mesh path: {data['path']} ({data.get('face_count', '?'):,} faces).",
    ]
    if data.get("textures_dropped"):
        lines.append("The textures and UVs were dropped: the repaired mesh is geometry only.")
    return "\n".join(lines)
