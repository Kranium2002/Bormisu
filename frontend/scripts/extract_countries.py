"""Build the compact country-outline asset for the Bormisu map focus from Natural Earth admin-0.

Usage: python3 -I extract_countries.py <ne_50m_admin_0_countries.geojson> <output.json> [tolerance_deg] [decimals]
                                        [<ne_10m_admin_0_countries.geojson>]

The input is untrusted data: only numbers (coordinates) and a few short string properties (ISO codes,
names) are read; strings are validated before they are written. Nothing from the file is executed.

Output (compact JSON):
  {
    "source": ..., "license": "Public domain", "simplification": ...,
    "countries": [
      { "code": "DE", "name": "Germany",
        "bbox": [[S, W], [N, E]],        all polygons
        "view": [[S, W], [N, E]],        main cluster (largest polygon + polygons within 2 deg of it)
        "polygons": [ [ ring, ...holes ], ... ] }   rings delta-encoded, see "encoding"
    ]
  }

Simplification is topology-aware: every vertex where the set of rings sharing it changes is kept, and
Douglas-Peucker runs on the arcs between such vertices in a canonical direction, so a border shared by
two countries is simplified identically in both (no slivers or overlaps along borders).
"""
import json
import math
import re
import sys

CODE_RE = re.compile(r"^[A-Z]{2}$")
NAME_RE = re.compile(r"^[\w .,'()&/-]{2,60}$", re.UNICODE)
CLUSTER_GAP_DEG = 2.0
DETAIL_MAX_DEG = 1.0
DETAIL_TOLERANCE_DEG = 0.002


def num(v):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        raise ValueError(f"not a finite number: {v!r}")
    return float(v)


def read_ring(ring):
    """GeoJSON [lng, lat] ring -> list of (lat, lng) floats, consecutive duplicates and closing point dropped."""
    out = []
    for pt in ring:
        if not isinstance(pt, list) or len(pt) < 2:
            raise ValueError("bad point")
        lng, lat = num(pt[0]), num(pt[1])
        if not (-180 <= lng <= 180 and -90 <= lat <= 90):
            raise ValueError("point out of range")
        p = (lat, lng)
        if not out or out[-1] != p:
            out.append(p)
    if len(out) > 1 and out[0] == out[-1]:
        out.pop()
    return out if len(out) >= 3 else None


def key(p):
    # Vertices shared by two countries are bit-identical in Natural Earth; 7 decimals guard against noise.
    return (round(p[0], 7), round(p[1], 7))


def seg_dist(p, a, b):
    """Distance in degrees from p to segment a-b (planar lat/lng, enough for simplification)."""
    (py, px), (ay, ax), (by, bx) = p, a, b
    dx, dy = bx - ax, by - ay
    l2 = dx * dx + dy * dy
    if l2 == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / l2))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def dp(points, tol):
    """Douglas-Peucker on an open polyline; endpoints kept. Iterative."""
    n = len(points)
    if n <= 2:
        return list(points)
    keep = [False] * n
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        i, j = stack.pop()
        best, idx = -1.0, -1
        for k in range(i + 1, j):
            d = seg_dist(points[k], points[i], points[j])
            if d > best:
                best, idx = d, k
        if best > tol and idx > 0:
            keep[idx] = True
            stack.append((i, idx))
            stack.append((idx, j))
    return [p for p, k in zip(points, keep) if k]


def dp_canonical(arc, tol):
    """DP in a canonical direction, so the same arc seen from either side gives the same vertices."""
    if key(arc[0]) <= key(arc[-1]):
        return dp(arc, tol)
    return list(reversed(dp(list(reversed(arc)), tol)))


def simplify_ring(ring, rid, owners, tol):
    n = len(ring)
    sets = [owners[key(p)] for p in ring]
    breaks = [i for i in range(n) if sets[i] != sets[i - 1] or sets[i] != sets[(i + 1) % n]]
    if not breaks:
        # A ring shared with nobody (or entirely with the same rings): split at 0 and the farthest point.
        far = max(range(n), key=lambda i: (ring[i][0] - ring[0][0]) ** 2 + (ring[i][1] - ring[0][1]) ** 2)
        breaks = [0, far] if far != 0 else [0]
    out = []
    for bi, start in enumerate(breaks):
        end = breaks[(bi + 1) % len(breaks)]
        arc = [ring[start]]
        i = start
        while True:
            i = (i + 1) % n
            arc.append(ring[i])
            if i == end:
                break
        simplified = dp_canonical(arc, tol)
        out.extend(simplified[:-1])  # the end vertex starts the next arc
    return out


def ring_area(ring):
    """Approximate area in deg^2 (lng scaled by cos(lat)), shoelace."""
    lat0 = sum(p[0] for p in ring) / len(ring)
    k = math.cos(math.radians(lat0))
    s = 0.0
    for i in range(len(ring)):
        y1, x1 = ring[i - 1]
        y2, x2 = ring[i]
        s += (x1 * k) * y2 - (x2 * k) * y1
    return abs(s) / 2


def bbox_of(rings):
    lats = [p[0] for r in rings for p in r]
    lngs = [p[1] for r in rings for p in r]
    return [min(lats), min(lngs), max(lats), max(lngs)]


def box_gap(a, b):
    dy = max(0.0, max(a[0], b[0]) - min(a[2], b[2]))
    dx = max(0.0, max(a[1], b[1]) - min(a[3], b[3]))
    return max(dx, dy)


def union(a, b):
    return [min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])]


def encode_ring(ring, decimals):
    """[(lat, lng)] -> flat integer deltas in 1/10^decimals degree, first point absolute."""
    scale = 10**decimals
    out, py, px = [], 0, 0
    for lat, lng in ring:
        y, x = round(lat * scale), round(lng * scale)
        out += [y - py, x - px]
        py, px = y, x
    return out


def read_countries(src, skipped):
    """Features merged by ISO A2 code (ISO_A2, else ISO_A2_EH); features without a code are skipped."""
    with open(src, encoding="utf-8") as f:
        data = json.load(f)
    by_code = {}
    for ft in data.get("features", []):
        p = (ft or {}).get("properties") or {}
        code = p.get("ISO_A2")
        if not isinstance(code, str) or not CODE_RE.match(code):
            code = p.get("ISO_A2_EH")
        name = p.get("NAME")
        if isinstance(name, str) and "." in name and isinstance(p.get("NAME_LONG"), str):
            name = p.get("NAME_LONG")
        if not isinstance(code, str) or not CODE_RE.match(code):
            skipped.append(str(p.get("NAME"))[:40])
            continue
        if not isinstance(name, str) or not NAME_RE.match(name):
            raise SystemExit(f"unexpected name for {code}: {name!r}")
        g = ft.get("geometry") or {}
        if g.get("type") == "Polygon":
            polys = [g["coordinates"]]
        elif g.get("type") == "MultiPolygon":
            polys = g["coordinates"]
        else:
            raise SystemExit(f"unexpected geometry for {code}")
        polygons = []
        for poly in polys:
            rings = [r for r in (read_ring(r) for r in poly) if r]
            if rings:
                polygons.append(rings)
        entry = by_code.setdefault(code, {"code": code, "name": name, "polygons": [], "sovereign": False, "tol": None})
        # The sovereign feature names the merged entry (Australia, not "Indian Ocean Ter.").
        if p.get("TYPE") in ("Sovereign country", "Country") and not entry["sovereign"]:
            entry["name"], entry["sovereign"] = name, True
        entry["polygons"].extend(polygons)
    return by_code


def vertex_owners(by_code):
    """Vertex key -> frozenset of country codes whose rings contain it."""
    owners = {}
    for c in by_code.values():
        for poly in c["polygons"]:
            for ring in poly:
                for p in ring:
                    owners.setdefault(key(p), set()).add(c["code"])
    return {k: frozenset(v) for k, v in owners.items()}


def ring_owners(by_code):
    """Vertex key -> frozenset of ring ids containing it (for topology-aware simplification)."""
    owners = {}
    rid = 0
    for c in by_code.values():
        for poly in c["polygons"]:
            for ring in poly:
                for p in ring:
                    owners.setdefault(key(p), set()).add(rid)
                rid += 1
    return {k: frozenset(v) for k, v in owners.items()}


def main(src, dst, tol, decimals, detail_src=None):
    skipped = []
    by_code = read_countries(src, skipped)

    # 1b. Small island countries (no vertex shared with another country, outline under DETAIL_MAX_DEG)
    #     take the 1:10m outline instead: at 1:50m Singapore is an 8-point polygon. Countries with land
    #     borders keep 1:50m, so shared borders stay identical.
    detailed = []
    if detail_src:
        shared = vertex_owners(by_code)
        detail = read_countries(detail_src, [])
        for c in by_code.values():
            pts = [p for poly in c["polygons"] for ring in poly for p in ring]
            lat_span = max(p[0] for p in pts) - min(p[0] for p in pts)
            lng_span = max(p[1] for p in pts) - min(p[1] for p in pts)
            island = all(shared[key(p)] == {c["code"]} for p in pts)
            if island and max(lat_span, lng_span) <= DETAIL_MAX_DEG and c["code"] in detail:
                c["polygons"] = detail[c["code"]]["polygons"]
                c["tol"] = DETAIL_TOLERANCE_DEG
                detailed.append(c["code"])

    # 2. Which rings own each vertex.
    owners = ring_owners(by_code)

    # 3. Simplify, round, drop degenerate rings.
    r = lambda v: round(v, decimals)
    rid = 0
    total_in = total_out = 0
    countries = []
    for c in sorted(by_code.values(), key=lambda c: c["code"]):
        out_polys = []
        for poly in c["polygons"]:
            out_rings = []
            for ring in poly:
                total_in += len(ring)
                s = simplify_ring(ring, rid, owners, c["tol"] or tol)
                rid += 1
                rounded = []
                for lat, lng in s:
                    q = (r(lat), r(lng))
                    if not rounded or rounded[-1] != q:
                        rounded.append(q)
                if len(rounded) > 1 and rounded[0] == rounded[-1]:
                    rounded.pop()
                if len(rounded) < 3:
                    # Tiny island: keep the unsimplified ring (rounded) if it still has an area.
                    rounded = []
                    for lat, lng in ring:
                        q = (r(lat), r(lng))
                        if not rounded or rounded[-1] != q:
                            rounded.append(q)
                    if len(rounded) > 1 and rounded[0] == rounded[-1]:
                        rounded.pop()
                if len(rounded) < 3:
                    continue
                out_rings.append(rounded)
            if out_rings and len(out_rings[0]) >= 3:
                out_polys.append(out_rings)
        if not out_polys:
            skipped.append(c["name"] + " (degenerate)")
            continue
        out_polys.sort(key=lambda rs: -ring_area(rs[0]))
        total_out += sum(len(x) for rs in out_polys for x in rs)
        boxes = [bbox_of([rs[0]]) for rs in out_polys]
        full = boxes[0]
        for b in boxes[1:]:
            full = union(full, b)
        view = boxes[0]
        added = {0}
        grew = True
        while grew:
            grew = False
            for i, b in enumerate(boxes):
                if i not in added and box_gap(view, b) <= CLUSTER_GAP_DEG:
                    view = union(view, b)
                    added.add(i)
                    grew = True
        countries.append(
            {
                "code": c["code"],
                "name": c["name"],
                "bbox": [[full[0], full[1]], [full[2], full[3]]],
                "view": [[view[0], view[1]], [view[2], view[3]]],
                "polygons": [[encode_ring(ring, decimals) for ring in rs] for rs in out_polys],
            }
        )

    asset = {
        "source": "Natural Earth 1:50m Cultural Vectors, Admin 0 - Countries (ne_50m_admin_0_countries), "
        "https://www.naturalearthdata.com/ via https://github.com/nvkelso/natural-earth-vector",
        "license": "Public domain (Natural Earth)",
        "simplification": f"topology-preserving Douglas-Peucker, tolerance {tol} deg (small island countries: "
        f"1:10m outline, tolerance {DETAIL_TOLERANCE_DEG} deg: {', '.join(detailed) or 'none'}), coordinates rounded to "
        f"{decimals} decimals; polygons largest first; first ring of a polygon is the outline, further rings are "
        "holes; rings are open (the closing point is dropped)",
        "encoding": "bbox and view are [[south, west], [north, east]] in degrees. Each ring is a flat list of "
        "integers in 1/scale degree: lat, lng of the first point, then for every further point the difference "
        "to the previous one (dlat, dlng). Running sums divided by scale give the [lat, lng] points.",
        "scale": 10**decimals,
        "countries": countries,
    }
    text = json.dumps(asset, separators=(",", ":"), ensure_ascii=False)
    with open(dst, "w", encoding="utf-8") as f:
        f.write(text)
        f.write("\n")
    print(f"countries={len(countries)} points_in={total_in} points_out={total_out} bytes={len(text.encode('utf-8'))}")
    print("skipped:", skipped)
    print("1:10m outlines for:", detailed)


if __name__ == "__main__":
    if len(sys.argv) not in (3, 4, 5, 6):
        raise SystemExit(__doc__)
    main(
        sys.argv[1],
        sys.argv[2],
        float(sys.argv[3]) if len(sys.argv) > 3 else 0.01,
        int(sys.argv[4]) if len(sys.argv) > 4 else 3,
        sys.argv[5] if len(sys.argv) > 5 else None,
    )
