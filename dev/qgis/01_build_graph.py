# =============================================================
# StreetForm India — Script 01: Build Graph
# =============================================================
# Paste into QGIS Python Console (Plugins → Python Console → Show Editor)
#
# WHAT IT DOES:
#   Reads the currently selected LineString layer,
#   builds a topological node-edge graph,
#   prints a full summary to the console,
#   adds a point layer showing detected nodes (coloured by type).
#
# HOW TO USE:
#   1. Draw 2–3 connected lines in a new LineString layer
#      (snapping ON so endpoints touch)
#   2. Select that layer in the Layers panel
#   3. Paste this script into the editor and click Run
# =============================================================

import math
from collections import defaultdict
from qgis.core import (
    QgsProject, QgsVectorLayer, QgsFeature, QgsGeometry,
    QgsPointXY, QgsField, QgsFields, QgsSingleSymbolRenderer,
    QgsCategorizedSymbolRenderer, QgsRendererCategory,
    QgsMarkerSymbol, QgsWkbTypes,
)
from qgis.PyQt.QtCore import QVariant
from qgis.PyQt.QtGui import QColor

SNAP_TOLERANCE = 0.5   # metres — increase if endpoints aren't snapping


# ──────────────────────────────────────────────────────────────
#  DATA STRUCTURES
# ──────────────────────────────────────────────────────────────

NODE_TYPE = {1: "dead_end", 2: "bend", 3: "t_junction",
             4: "crossroads"}

class Node:
    def __init__(self, nid, x, y):
        self.id       = nid
        self.x        = x
        self.y        = y
        self.edge_ids = []

    @property
    def node_type(self):
        return NODE_TYPE.get(len(self.edge_ids), "complex")

    @property
    def point(self):
        return QgsPointXY(self.x, self.y)

    def __repr__(self):
        return f"Node({self.id}, {self.node_type}, edges={self.edge_ids})"


class Edge:
    def __init__(self, eid, fid, start_nid, end_nid, vertices):
        self.id            = eid
        self.feature_id    = fid
        self.node_start_id = start_nid
        self.node_end_id   = end_nid
        self.vertices      = vertices  # list of (x, y)
        # Attributes (populated from layer fields if present)
        self.profile_id    = ""
        self.name          = ""
        self.design_speed  = 40  # default km/h

    def bearing_from_node(self, node_id):
        """Bearing (CW from North) leaving this edge from the given node."""
        if node_id == self.node_start_id:
            p1, p2 = self.vertices[0], self.vertices[1]
        else:
            p1, p2 = self.vertices[-1], self.vertices[-2]
        dx = p2[0] - p1[0]
        dy = p2[1] - p1[1]
        return math.degrees(math.atan2(dx, dy)) % 360

    def __repr__(self):
        return f"Edge({self.id}: {self.node_start_id}→{self.node_end_id} '{self.name}')"


class Graph:
    def __init__(self):
        self.nodes = {}   # id → Node
        self.edges = {}   # id → Edge

    def edges_at_node(self, node_id):
        return [self.edges[eid] for eid in self.nodes[node_id].edge_ids]

    def edges_at_node_sorted_cw(self, node_id):
        return sorted(self.edges_at_node(node_id),
                      key=lambda e: e.bearing_from_node(node_id))


# ──────────────────────────────────────────────────────────────
#  GRAPH BUILDER
# ──────────────────────────────────────────────────────────────

def snap_key(x, y, tol=SNAP_TOLERANCE):
    f = 1.0 / tol
    return (int(round(x * f)), int(round(y * f)))


def build_graph(layer, snap_tol=SNAP_TOLERANCE):
    graph         = Graph()
    coord_to_node = {}
    node_counter  = 0
    edge_counter  = 0

    def get_or_create_node(x, y):
        nonlocal node_counter
        key = snap_key(x, y, snap_tol)
        if key not in coord_to_node:
            node_counter += 1
            nid = f"n{node_counter:03d}"
            coord_to_node[key] = nid
            # Use snapped coordinates as node position
            f  = 1.0 / snap_tol
            sx = round(x * f) / f
            sy = round(y * f) / f
            graph.nodes[nid] = Node(nid, sx, sy)
        return coord_to_node[key]

    field_names = [f.name() for f in layer.fields()]

    for feat in layer.getFeatures():
        geom = feat.geometry()

        # Handle both LineString and MultiLineString
        wkb = geom.wkbType()
        from qgis.core import QgsWkbTypes
        if QgsWkbTypes.isMultiType(wkb):
            parts = geom.asMultiPolyline()
        else:
            single = geom.asPolyline()
            parts  = [single] if single else []

        for pts in parts:
            if not pts or len(pts) < 2:
                continue

            verts = [(p.x(), p.y()) for p in pts]
            snid  = get_or_create_node(*verts[0])
            enid  = get_or_create_node(*verts[-1])

            edge_counter += 1
            eid  = f"e{edge_counter:03d}"
            edge = Edge(eid, feat.id(), snid, enid, verts)

            if "name"       in field_names: edge.name       = feat["name"] or ""
            if "profile_id" in field_names: edge.profile_id = feat["profile_id"] or ""
            if "design_speed_kmph" in field_names and feat["design_speed_kmph"]:
                edge.design_speed = int(feat["design_speed_kmph"])

            graph.edges[eid] = edge
            graph.nodes[snid].edge_ids.append(eid)
            graph.nodes[enid].edge_ids.append(eid)

    return graph


# ──────────────────────────────────────────────────────────────
#  PRINT SUMMARY
# ──────────────────────────────────────────────────────────────

def print_graph(graph):
    print("\n" + "="*55)
    print(f"  STREETFORM GRAPH")
    print(f"  {len(graph.nodes)} nodes   {len(graph.edges)} edges")
    print("="*55)

    print("\n  NODES:")
    type_counts = defaultdict(int)
    for n in graph.nodes.values():
        type_counts[n.node_type] += 1
        bearings = []
        for e in graph.edges_at_node_sorted_cw(n.id):
            b = e.bearing_from_node(n.id)
            bearings.append(f"{b:.0f}°")
        print(f"    {n.id}  {n.node_type:12s}  ({n.x:.1f}, {n.y:.1f})"
              f"  edges={n.edge_ids}  bearings=[{', '.join(bearings)}]")

    print("\n  NODE TYPE SUMMARY:")
    for t, c in sorted(type_counts.items()):
        print(f"    {t:15s}  {c}")

    print("\n  EDGES:")
    for e in graph.edges.values():
        sn = graph.nodes[e.node_start_id]
        en = graph.nodes[e.node_end_id]
        length = sum(
            math.sqrt((graph.edges[eid].vertices[i+1][0]-graph.edges[eid].vertices[i][0])**2 +
                      (graph.edges[eid].vertices[i+1][1]-graph.edges[eid].vertices[i][1])**2)
            for eid in [e.id]
            for i in range(len(e.vertices)-1)
        )
        print(f"    {e.id}  {sn.id}→{en.id}  len={length:.1f}m"
              f"  profile='{e.profile_id}'  name='{e.name}'")

    print("="*55 + "\n")


# ──────────────────────────────────────────────────────────────
#  ADD NODE LAYER TO QGIS
# ──────────────────────────────────────────────────────────────

NODE_COLOURS = {
    "dead_end":   "#4CAF50",   # green
    "bend":       "#2196F3",   # blue
    "t_junction": "#FF9800",   # orange
    "crossroads": "#F44336",   # red
    "complex":    "#9C27B0",   # purple
}

def add_node_layer(graph, crs_wkt):
    fields = QgsFields()
    fields.append(QgsField("id",         QVariant.String))
    fields.append(QgsField("node_type",  QVariant.String))
    fields.append(QgsField("edge_count", QVariant.Int))
    fields.append(QgsField("edge_ids",   QVariant.String))
    fields.append(QgsField("bearings",   QVariant.String))

    lyr = QgsVectorLayer(f"Point?crs={crs_wkt}", "SF_nodes", "memory")
    pr  = lyr.dataProvider()
    pr.addAttributes(fields)
    lyr.updateFields()

    features = []
    for n in graph.nodes.values():
        bearings = [f"{e.bearing_from_node(n.id):.0f}°"
                    for e in graph.edges_at_node_sorted_cw(n.id)]
        feat = QgsFeature(lyr.fields())
        feat.setGeometry(QgsGeometry.fromPointXY(n.point))
        feat.setAttribute("id",         n.id)
        feat.setAttribute("node_type",  n.node_type)
        feat.setAttribute("edge_count", len(n.edge_ids))
        feat.setAttribute("edge_ids",   ",".join(n.edge_ids))
        feat.setAttribute("bearings",   ",".join(bearings))
        features.append(feat)
    pr.addFeatures(features)
    lyr.updateExtents()

    # Categorised renderer — colour by node type
    categories = []
    for ntype, colour in NODE_COLOURS.items():
        sym = QgsMarkerSymbol.createSimple({
            "color":        colour,
            "size":         "3",
            "outline_color": "#000000",
            "outline_width": "0.3",
        })
        categories.append(QgsRendererCategory(ntype, sym, ntype))

    lyr.setRenderer(QgsCategorizedSymbolRenderer("node_type", categories))
    QgsProject.instance().addMapLayer(lyr)
    print(f"  ✓ Added layer: SF_nodes ({len(graph.nodes)} features)")
    return lyr


# ──────────────────────────────────────────────────────────────
#  MAIN — runs when script is executed
# ──────────────────────────────────────────────────────────────

layer = iface.activeLayer()

if layer is None:
    print("✗  No active layer. Select your LineString layer first.")
elif layer.geometryType() != QgsWkbTypes.LineGeometry:
    print(f"✗  Active layer is not a line layer. Got: {layer.geometryType()}")
else:
    print(f"  Active layer: '{layer.name()}'  ({layer.featureCount()} features)")
    print(f"  CRS: {layer.crs().authid()}")
    print(f"  Snap tolerance: {SNAP_TOLERANCE}m")

    graph  = build_graph(layer, SNAP_TOLERANCE)
    print_graph(graph)
    add_node_layer(graph, layer.crs().toWkt())

    # Store graph globally so script 02 can access it
    import builtins
    builtins.sf_graph = graph
    print("  Graph stored as 'sf_graph' — run Script 02 next.")
