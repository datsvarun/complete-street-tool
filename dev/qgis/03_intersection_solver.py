# =============================================================
# StreetForm India — Script 03: Intersection Solver
# =============================================================
# Run AFTER Scripts 01 and 02.
# Requires: sf_graph, sf_rays in builtins.
#
# This version is PRINT ONLY — no QGIS layer creation.
# Verify the console output looks correct before running 03b
# which adds the visual layers.
# =============================================================

import math
import builtins

# ──────────────────────────────────────────────────────────────
#  MATH PRIMITIVES
# ──────────────────────────────────────────────────────────────

def v_len(a):
    return math.sqrt(a[0]**2 + a[1]**2)

def v_norm(a):
    l = v_len(a)
    return (a[0]/l, a[1]/l) if l > 1e-10 else (0.0, 0.0)

def v_dot(a, b):
    return a[0]*b[0] + a[1]*b[1]

def v_sub(a, b):
    return (a[0]-b[0], a[1]-b[1])

def v_add(a, b):
    return (a[0]+b[0], a[1]+b[1])

def v_scale(a, s):
    return (a[0]*s, a[1]*s)

def v_perp(a):
    return (-a[1], a[0])

def angle_cw_north(origin, pt):
    dx = pt[0] - origin[0]
    dy = pt[1] - origin[1]
    return math.degrees(math.atan2(dx, dy)) % 360

def ray_circle_intersect(origin, direction, centre, radius):
    ox = origin[0] - centre[0]
    oy = origin[1] - centre[1]
    dx, dy = direction
    a = dx*dx + dy*dy
    if a < 1e-12:
        return None
    b = 2*(ox*dx + oy*dy)
    c = ox*ox + oy*oy - radius*radius
    disc = b*b - 4*a*c
    if disc < 0:
        return None
    sq = math.sqrt(disc)
    for t in sorted([(-b-sq)/(2*a), (-b+sq)/(2*a)]):
        if t > 1e-6:
            return (origin[0]+t*dx, origin[1]+t*dy)
    return None

def line_intersect(p1, d1, p2, d2):
    cross = d1[0]*d2[1] - d1[1]*d2[0]
    if abs(cross) < 1e-10:
        return None
    dx = p2[0]-p1[0]; dy = p2[1]-p1[1]
    t  = (dx*d2[1] - dy*d2[0]) / cross
    return (p1[0]+t*d1[0], p1[1]+t*d1[1])

def pt_line_dist(p, lp, ld):
    d = v_norm(ld)
    v = v_sub(p, lp)
    proj = v_dot(v, d)
    foot = v_add(lp, v_scale(d, proj))
    return v_len(v_sub(p, foot))

def foot_perp(p, lp, ld):
    d = v_norm(ld)
    v = v_sub(p, lp)
    return v_add(lp, v_scale(d, v_dot(v, d)))

def arc_pts(centre, radius, a_start, a_end, n=16):
    a0 = a_start % 360
    a1 = a_end   % 360
    if a1 <= a0:
        a1 += 360
    pts = []
    for i in range(n+1):
        t   = i/n
        deg = a0 + t*(a1-a0)
        r   = math.radians(deg)
        pts.append((centre[0] + radius*math.sin(r),
                    centre[1] + radius*math.cos(r)))
    return pts

def convex_hull(points):
    pts = sorted(set(points))
    if len(pts) < 3:
        return pts
    def cross(O, A, B):
        return (A[0]-O[0])*(B[1]-O[1]) - (A[1]-O[1])*(B[0]-O[0])
    lo = []
    for p in pts:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], p) <= 0:
            lo.pop()
        lo.append(p)
    hi = []
    for p in reversed(pts):
        while len(hi) >= 2 and cross(hi[-2], hi[-1], p) <= 0:
            hi.pop()
        hi.append(p)
    return lo[:-1] + hi[:-1]


# ──────────────────────────────────────────────────────────────
#  FILLET ARC
# ──────────────────────────────────────────────────────────────

RADIUS_BY_SPEED = {30: 3.0, 40: 5.0, 50: 7.0, 60: 9.0}
MAX_R = 9.0
MIN_R = 1.5

def fillet_radius(speed_a, speed_b):
    speed = min(speed_a, speed_b)
    R = RADIUS_BY_SPEED[30]
    for k in sorted(RADIUS_BY_SPEED):
        if speed >= k:
            R = RADIUS_BY_SPEED[k]
    return max(MIN_R, min(MAX_R, R))

def compute_fillet(p1, d1, p2, d2, R):
    d1n = v_norm(d1)
    d2n = v_norm(d2)
    # Reject parallel / antiparallel
    if abs(v_dot(d1n, d2n)) > 0.98:
        return None
    perp1  = v_perp(d1n);  perp1r = (-perp1[0],  -perp1[1])
    perp2  = v_perp(d2n);  perp2r = (-perp2[0],  -perp2[1])
    best   = None
    best_e = float('inf')
    for pp1 in [perp1, perp1r]:
        for pp2 in [perp2, perp2r]:
            op1 = v_add(p1, v_scale(pp1, R))
            op2 = v_add(p2, v_scale(pp2, R))
            c   = line_intersect(op1, d1n, op2, d2n)
            if c is None:
                continue
            err = abs(pt_line_dist(c, p1, d1n) - R) + \
                  abs(pt_line_dist(c, p2, d2n) - R)
            if err < best_e:
                best_e = err
                best   = c
    if best is None or best_e > R * 0.1:
        return None
    centre = best
    tp1    = foot_perp(centre, p1, d1n)
    tp2    = foot_perp(centre, p2, d2n)
    # Validate tangent points are real numbers
    for val in [*tp1, *tp2, *centre]:
        if math.isnan(val) or math.isinf(val):
            return None
    a1 = angle_cw_north(centre, tp1)
    a2 = angle_cw_north(centre, tp2)
    return {
        "centre":  centre,
        "radius":  R,
        "tp1":     tp1,
        "tp2":     tp2,
        "a1":      a1,
        "a2":      a2,
        "arc_pts": arc_pts(centre, R, a1, a2, n=16),
    }


# ──────────────────────────────────────────────────────────────
#  SOLVER
# ──────────────────────────────────────────────────────────────

def solve_node(node, all_rays):
    npos = (node.x, node.y)

    # Collect rays for this node
    rays = [r for r in all_rays.values() if r["node_id"] == node.id]
    if len(rays) < 2:
        print(f"  ✗ Node {node.id}: only {len(rays)} rays — skipping")
        return None

    # Sweep radius
    dists = [v_len(v_sub(r["origin"], npos)) for r in rays]
    X     = max(9.0, min(min(dists) * 2.5, 60.0))

    # Intersect rays with sweep circle
    sweep_pts = []
    for ray in rays:
        pt = ray_circle_intersect(ray["origin"], ray["direction"], npos, X)
        if pt is None:
            rev = (-ray["direction"][0], -ray["direction"][1])
            pt  = ray_circle_intersect(ray["origin"], rev, npos, X)
        if pt is not None:
            # Validate point
            if any(math.isnan(v) or math.isinf(v) for v in pt):
                print(f"  ✗ Bad sweep point for {ray['edge_id']}/{ray['side']}")
                continue
            sweep_pts.append({
                "pt":      pt,
                "angle":   angle_cw_north(npos, pt),
                "edge_id": ray["edge_id"],
                "side":    ray["side"],
                "ray":     ray,
            })

    if len(sweep_pts) < 2:
        print(f"  ✗ Node {node.id}: only {len(sweep_pts)} valid sweep points")
        return None

    # Sort CW
    sweep_pts.sort(key=lambda p: p["angle"])

    # Pair sequentially — with a hard iteration cap to prevent infinite loop
    pts    = list(sweep_pts)
    pairs  = []
    i      = 0
    safety = 0
    while i < len(pts) - 1 and safety < 50:
        safety += 1
        a, b = pts[i], pts[i+1]
        if a["edge_id"] == b["edge_id"] and len(pts) > 2:
            pts.append(pts.pop(i+1))
            continue
        pairs.append((a, b))
        i += 2
    if len(pts) % 2 == 1 and len(pairs) > 0:
        pairs.append((pts[-1], sweep_pts[0]))

    # Compute fillets
    fillets    = []
    all_apts   = [npos]
    for a, b in pairs:
        R   = fillet_radius(a["ray"]["speed"], b["ray"]["speed"])
        arc = compute_fillet(
            a["ray"]["origin"], a["ray"]["direction"],
            b["ray"]["origin"], b["ray"]["direction"],
            R
        )
        fillets.append({"pt_a": a, "pt_b": b, "arc": arc, "R": R})
        if arc:
            all_apts.extend(arc["arc_pts"])
            all_apts.append(arc["tp1"])
            all_apts.append(arc["tp2"])

    # Conflict zone
    valid_apts = [(x,y) for x,y in all_apts
                  if not math.isnan(x) and not math.isnan(y)]
    conflict   = convex_hull(valid_apts) if len(valid_apts) >= 3 else []

    return {
        "node":         node,
        "node_pos":     npos,
        "sweep_radius": X,
        "sweep_pts":    sweep_pts,
        "pairs":        pairs,
        "fillets":      fillets,
        "conflict_zone": conflict,
    }


# ──────────────────────────────────────────────────────────────
#  PRINT RESULTS
# ──────────────────────────────────────────────────────────────

def print_results(results):
    for res in results:
        n = res["node"]
        print(f"\n  ═══ Node {n.id} ({n.node_type}) ═══")
        print(f"  Position:      ({res['node_pos'][0]:.2f}, {res['node_pos'][1]:.2f})")
        print(f"  Sweep radius:  {res['sweep_radius']:.2f}m")
        print(f"  Sweep points:  {len(res['sweep_pts'])}")
        for sp in res["sweep_pts"]:
            print(f"    {sp['edge_id']}/{sp['side']:5s}  "
                  f"angle={sp['angle']:.1f}°  "
                  f"pt=({sp['pt'][0]:.2f}, {sp['pt'][1]:.2f})")
        print(f"  Pairs:         {len(res['pairs'])}")
        for i, (a, b) in enumerate(res["pairs"]):
            print(f"    [{i}] {a['edge_id']}/{a['side']}  ↔  "
                  f"{b['edge_id']}/{b['side']}")
        print(f"  Fillets:       {len(res['fillets'])}")
        for i, f in enumerate(res["fillets"]):
            if f["arc"]:
                c = f["arc"]["centre"]
                print(f"    [{i}] R={f['R']}m  "
                      f"centre=({c[0]:.2f},{c[1]:.2f})  "
                      f"arc_pts={len(f['arc']['arc_pts'])}")
            else:
                print(f"    [{i}] road mouth (no arc)  R={f['R']}m")
        print(f"  Conflict zone: {len(res['conflict_zone'])} pts")


# ──────────────────────────────────────────────────────────────
#  MAIN
# ──────────────────────────────────────────────────────────────

if not hasattr(builtins, "sf_graph") or not hasattr(builtins, "sf_rays"):
    print("✗  Run Scripts 01 and 02 first.")
else:
    graph    = builtins.sf_graph
    all_rays = builtins.sf_rays

    junction_nodes = [n for n in graph.nodes.values()
                      if len(n.edge_ids) >= 3]

    if not junction_nodes:
        print("  No junction nodes found (need 3+ edges meeting at one point).")
        print("  Check Script 01 output — are any nodes shown as t_junction?")
        print(f"  Node types: {[n.node_type for n in graph.nodes.values()]}")
    else:
        print(f"\n  Solving {len(junction_nodes)} junction(s) ...\n")
        results = []
        for node in junction_nodes:
            res = solve_node(node, all_rays)
            if res:
                results.append(res)

        print_results(results)

        builtins.sf_results = results
        print(f"\n  ✓ {len(results)} result(s) stored as sf_results")
        print("  If output looks correct, run Script 03b to add QGIS layers.")
