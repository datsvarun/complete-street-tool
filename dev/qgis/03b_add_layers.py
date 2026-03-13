# =============================================================
# StreetForm India — Script 03b: Add Intersection Layers
# =============================================================
# Run AFTER Script 03 (print-only solver).
# Requires sf_results in builtins.
#
# Adds visual layers to QGIS:
#   SF_sweep_circle   — sweep circle per junction (debug)
#   SF_sweep_points   — hit points on circle (debug)
#   SF_fillet_arcs    — corner arc lines
#   SF_conflict_zone  — filled intersection polygon
# =============================================================

import math
import builtins
from qgis.core import (
    QgsProject, QgsVectorLayer, QgsFeature, QgsGeometry,
    QgsPointXY, QgsField, QgsFields,
    QgsSingleSymbolRenderer, QgsFillSymbol, QgsLineSymbol,
    QgsMarkerSymbol,
)
from qgis.PyQt.QtCore import QVariant


def circle_polygon(cx, cy, radius, n=48):
    pts = []
    for i in range(n):
        a = 2 * math.pi * i / n
        pts.append(QgsPointXY(cx + radius*math.cos(a),
                               cy + radius*math.sin(a)))
    pts.append(pts[0])
    return QgsGeometry.fromPolygonXY([pts])


def make_layer(geom_type, name, field_defs, crs_wkt):
    lyr = QgsVectorLayer(f"{geom_type}?crs={crs_wkt}", name, "memory")
    pr  = lyr.dataProvider()
    fields = QgsFields()
    for fname, ftype in field_defs:
        fields.append(QgsField(fname, ftype))
    pr.addAttributes(fields)
    lyr.updateFields()
    return lyr, pr


if not hasattr(builtins, "sf_results"):
    print("✗  sf_results not found. Run Script 03 first.")
else:
    results  = builtins.sf_results
    layer    = iface.activeLayer()
    crs      = layer.crs().toWkt()

    # ── Sweep circles ──────────────────────────────────────
    lyr_c, pr_c = make_layer("Polygon", "SF_sweep_circle",
        [("node_id", QVariant.String), ("radius_m", QVariant.Double)], crs)

    # ── Sweep points ───────────────────────────────────────
    lyr_sp, pr_sp = make_layer("Point", "SF_sweep_points",
        [("node_id", QVariant.String), ("edge_id", QVariant.String),
         ("side", QVariant.String), ("angle_cw", QVariant.Double)], crs)

    # ── Fillet arcs ────────────────────────────────────────
    lyr_fa, pr_fa = make_layer("LineString", "SF_fillet_arcs",
        [("node_id", QVariant.String), ("radius_m", QVariant.Double)], crs)

    # ── Conflict zone ──────────────────────────────────────
    lyr_cz, pr_cz = make_layer("Polygon", "SF_conflict_zone",
        [("node_id", QVariant.String)], crs)

    for res in results:
        nid  = res["node"].id
        nx, ny = res["node_pos"]
        X    = res["sweep_radius"]

        # Sweep circle
        feat = QgsFeature(lyr_c.fields())
        feat.setGeometry(circle_polygon(nx, ny, X))
        feat.setAttribute("node_id",  nid)
        feat.setAttribute("radius_m", X)
        pr_c.addFeature(feat)

        # Sweep points
        for sp in res["sweep_pts"]:
            feat = QgsFeature(lyr_sp.fields())
            feat.setGeometry(QgsGeometry.fromPointXY(
                QgsPointXY(*sp["pt"])))
            feat.setAttribute("node_id",  nid)
            feat.setAttribute("edge_id",  sp["edge_id"])
            feat.setAttribute("side",     sp["side"])
            feat.setAttribute("angle_cw", sp["angle"])
            pr_sp.addFeature(feat)

        # Fillet arcs
        for f in res["fillets"]:
            if f["arc"] is None:
                continue
            pts = [QgsPointXY(*p) for p in f["arc"]["arc_pts"]]
            if len(pts) < 2:
                continue
            feat = QgsFeature(lyr_fa.fields())
            feat.setGeometry(QgsGeometry.fromPolylineXY(pts))
            feat.setAttribute("node_id",  nid)
            feat.setAttribute("radius_m", f["R"])
            pr_fa.addFeature(feat)

        # Conflict zone
        cz = res["conflict_zone"]
        if len(cz) >= 3:
            ring = [QgsPointXY(*p) for p in cz] + \
                   [QgsPointXY(*cz[0])]
            feat = QgsFeature(lyr_cz.fields())
            feat.setGeometry(QgsGeometry.fromPolygonXY([ring]))
            feat.setAttribute("node_id", nid)
            pr_cz.addFeature(feat)

    # Style and add layers
    for lyr in [lyr_c, lyr_sp, lyr_fa, lyr_cz]:
        lyr.updateExtents()

    lyr_c.setRenderer(QgsSingleSymbolRenderer(
        QgsFillSymbol.createSimple({
            "color": "transparent",
            "outline_color": "#00BCD4",
            "outline_width": "0.4",
            "outline_style": "dash",
        })
    ))
    lyr_fa.setRenderer(QgsSingleSymbolRenderer(
        QgsLineSymbol.createSimple({
            "line_color": "#FF6B35",
            "line_width": "0.8",
        })
    ))
    lyr_cz.setRenderer(QgsSingleSymbolRenderer(
        QgsFillSymbol.createSimple({
            "color": "#90A4AE",
            "color_border": "#546E7A",
            "width_border": "0.5",
        })
    ))
    lyr_sp.setRenderer(QgsSingleSymbolRenderer(
        QgsMarkerSymbol.createSimple({
            "color": "#FFEB3B",
            "size":  "3",
            "outline_color": "#000000",
            "outline_width": "0.3",
        })
    ))

    for lyr in [lyr_cz, lyr_c, lyr_fa, lyr_sp]:
        QgsProject.instance().addMapLayer(lyr)
        print(f"  ✓ {lyr.name()}  ({lyr.featureCount()} features)")

    print("\n  Done. Check the map.")
    print("  Hide SF_sweep_circle and SF_sweep_points when satisfied.")
