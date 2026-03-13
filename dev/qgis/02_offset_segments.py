# =============================================================
# StreetForm India — Script 02: Offset Lines
# =============================================================
# Run AFTER Script 01. Requires sf_graph in builtins.
#
# WHAT IT DOES:
#   For each edge in the graph, takes the centreline and offsets
#   it once for every segment boundary in the road profile.
#   Produces only lines — no polygons.
#
#   For a 12m road with:
#     footpath 1.5m | carriageway 4.5m | CL | carriageway 4.5m | footpath 1.5m
#
#   You get 4 offset lines + the centreline itself:
#     +6.0m  — outer kerb left
#     +4.5m  — inner kerb left  (footpath/carriageway edge)
#      0.0m  — centreline
#     −4.5m  — inner kerb right
#     −6.0m  — outer kerb right
#
#   Also stores kerb rays for Script 03 (intersection solver).
#
# ADJUST:
#   PROFILE["offsets"] — add/remove lines to match your road section.
#   Positive = left of centreline, negative = right.
# =============================================================

from qgis.core import (
    QgsProject, QgsVectorLayer, QgsFeature, QgsGeometry,
    QgsPointXY, QgsField, QgsFields,
    QgsSingleSymbolRenderer, QgsCategorizedSymbolRenderer,
    QgsRendererCategory, QgsLineSymbol, QgsWkbTypes,
)
from qgis.PyQt.QtCore import QVariant
import math


# ──────────────────────────────────────────────────────────────
#  ROAD PROFILE
#  Each entry: (offset_m, label, line_type)
#  offset_m  : distance from centreline (+ = left, − = right)
#  label     : shown in attribute table
#  line_type : drives colour/weight styling
# ──────────────────────────────────────────────────────────────

PROFILE = {
    "name": "12m_symmetric",
    "offsets": [
        # offset_m   label                  line_type
        ( 6.0,      "Outer kerb left",      "outer_kerb"),
        ( 4.5,      "Inner kerb left",      "inner_kerb"),
        ( 0.0,      "Centreline",           "centreline"),
        (-4.5,      "Inner kerb right",     "inner_kerb"),
        (-6.0,      "Outer kerb right",     "outer_kerb"),
    ],
    "half_width": 6.0,   # outermost offset — used for ray extraction
}

LINE_STYLES = {
    "outer_kerb": {"color": "#212121", "width": "0.6"},
    "inner_kerb": {"color": "#555555", "width": "0.4"},
    "centreline": {"color": "#FFC107", "width": "0.3"},
    "lane_line":  {"color": "#FFFFFF", "width": "0.3"},
}

RAY_SAMPLE_DIST = 8.0   # metres from node to sample kerb ray direction


# ──────────────────────────────────────────────────────────────
#  OFFSET HELPER
# ──────────────────────────────────────────────────────────────

def offset_line(geom, offset_m):
    if abs(offset_m) < 1e-6:
        return QgsGeometry(geom)
    result = geom.offsetCurve(
        offset_m, 8,
        QgsGeometry.JoinStyle.Round,
        2.0,
    )
    return result if result and not result.isEmpty() else None


# ──────────────────────────────────────────────────────────────
#  KERB RAY EXTRACTION
# ──────────────────────────────────────────────────────────────

def interpolate_along(vertices, dist):
    remaining = dist
    for i in range(len(vertices) - 1):
        x1, y1 = vertices[i];  x2, y2 = vertices[i+1]
        seg = math.sqrt((x2-x1)**2 + (y2-y1)**2)
        if remaining <= seg:
            t = remaining / seg
            return (x1 + t*(x2-x1), y1 + t*(y2-y1))
        remaining -= seg
    return vertices[-1]


def kerb_ray_at_node(edge, node_id, offset_m):
    """
    Origin and direction of the offset kerb line at RAY_SAMPLE_DIST
    from the given node end of this edge.
    """
    verts = edge.vertices
    seq   = verts if node_id == edge.node_start_id else list(reversed(verts))
    if len(seq) < 2:
        return None

    dx = seq[1][0] - seq[0][0]
    dy = seq[1][1] - seq[0][1]
    L  = math.sqrt(dx*dx + dy*dy)
    if L < 1e-10:
        return None

    ux, uy = dx/L, dy/L   # unit vector away from node
    px, py = -uy, ux      # left perpendicular

    sample = interpolate_along(seq, RAY_SAMPLE_DIST)
    origin = (sample[0] + px*offset_m, sample[1] + py*offset_m)
    return origin, (ux, uy)


# ──────────────────────────────────────────────────────────────
#  BUILD
# ──────────────────────────────────────────────────────────────

def build_offset_lines(graph):
    line_feats = []   # (geom, label, line_type, edge_id, offset_m)
    all_rays   = {}   # (edge_id, node_id, side) → ray dict

    for edge in graph.edges.values():
        qpts = [QgsPointXY(x, y) for x, y in edge.vertices]
        cl   = QgsGeometry.fromPolylineXY(qpts)

        # One offset line per profile entry
        for offset_m, label, line_type in PROFILE["offsets"]:
            geom = offset_line(cl, offset_m)
            if geom:
                line_feats.append((geom, label, line_type,
                                   edge.id, offset_m))

        # Outer kerb rays at each node end for the intersection solver
        half = PROFILE["half_width"]
        for node_id in [edge.node_start_id, edge.node_end_id]:
            for side, off in [("left", half), ("right", -half)]:
                result = kerb_ray_at_node(edge, node_id, off)
                if result is None:
                    continue
                origin, direction = result
                all_rays[(edge.id, node_id, side)] = {
                    "origin":    origin,
                    "direction": direction,
                    "edge_id":   edge.id,
                    "node_id":   node_id,
                    "side":      side,
                    "speed":     edge.design_speed,
                }

    return line_feats, all_rays


# ──────────────────────────────────────────────────────────────
#  ADD LAYER
# ──────────────────────────────────────────────────────────────

def add_offset_line_layer(line_feats, crs_wkt):
    fields = QgsFields()
    fields.append(QgsField("label",     QVariant.String))
    fields.append(QgsField("line_type", QVariant.String))
    fields.append(QgsField("edge_id",   QVariant.String))
    fields.append(QgsField("offset_m",  QVariant.Double))

    lyr = QgsVectorLayer(f"LineString?crs={crs_wkt}",
                         "SF_offset_lines", "memory")
    pr  = lyr.dataProvider()
    pr.addAttributes(fields)
    lyr.updateFields()

    feats = []
    for geom, label, ltype, eid, off in line_feats:
        feat = QgsFeature(lyr.fields())
        feat.setGeometry(geom)
        feat.setAttribute("label",     label)
        feat.setAttribute("line_type", ltype)
        feat.setAttribute("edge_id",   eid)
        feat.setAttribute("offset_m",  off)
        feats.append(feat)
    pr.addFeatures(feats)
    lyr.updateExtents()

    categories = []
    for ltype, style in LINE_STYLES.items():
        sym = QgsLineSymbol.createSimple({
            "line_color": style["color"],
            "line_width": style["width"],
        })
        categories.append(QgsRendererCategory(ltype, sym, ltype))
    lyr.setRenderer(QgsCategorizedSymbolRenderer("line_type", categories))

    QgsProject.instance().addMapLayer(lyr)
    print(f"  ✓ SF_offset_lines  ({len(feats)} lines)")
    return lyr


# ──────────────────────────────────────────────────────────────
#  MAIN
# ──────────────────────────────────────────────────────────────

import builtins

if not hasattr(builtins, "sf_graph"):
    print("✗  sf_graph not found. Run Script 01 first.")
else:
    graph = builtins.sf_graph
    layer = iface.activeLayer()
    crs   = layer.crs().toWkt()

    print(f"\n  Profile: {PROFILE['name']}  "
          f"ROW={PROFILE['half_width']*2:.0f}m")
    print(f"  Offsets: {[o for o,_,_ in PROFILE['offsets']]}")

    line_feats, all_rays = build_offset_lines(graph)
    add_offset_line_layer(line_feats, crs)

    # Summary per junction node
    junction_nodes = [n for n in graph.nodes.values()
                      if len(n.edge_ids) >= 3]
    print(f"\n  Junction nodes: {len(junction_nodes)}")
    for n in junction_nodes:
        print(f"  Node {n.id} ({n.node_type})  ({n.x:.1f}, {n.y:.1f})")
        for key, ray in sorted(all_rays.items()):
            if ray["node_id"] == n.id:
                print(f"    {ray['edge_id']}/{ray['side']:5s}"
                      f"  origin=({ray['origin'][0]:.2f}, {ray['origin'][1]:.2f})"
                      f"  dir=({ray['direction'][0]:.3f}, {ray['direction'][1]:.3f})")

    builtins.sf_rays       = all_rays
    builtins.sf_line_feats = line_feats
    print("\n  Stored: sf_rays, sf_line_feats — run Script 03 next.")
