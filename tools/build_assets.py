#!/usr/bin/env python
"""Build Dusk Circuit assets with Blender as a Python module (bpy).

    python tools/build_assets.py               # generate .blend sources, validate, export .glb
    python tools/build_assets.py --from-blend  # skip generation: open committed .blend, validate, export
    python tools/build_assets.py --only track  # track | karts | scenery

Generation is deterministic (seeded). Re-running from an edited .blend never
overwrites the .blend, so hand edits survive. See SPEC.md "Blender contract".
"""
import argparse
import math
import os
import random
import sys

import bpy
import bmesh
import numpy as np
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import blender_export as C  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BLEND_DIR = os.path.join(ROOT, "blender")
ASSET_DIR = os.path.join(ROOT, "assets")
SEED = 7

KART_NAMES = ["ember", "tideglass", "ironmoth", "nightjar"]
SCENERY_KINDS = ["tree_pine", "tree_round", "rock", "crystal", "lamp", "banner", "stand"]


# =============================================================================
# Generic helpers
# =============================================================================
def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    return scene


def link(ob):
    bpy.context.scene.collection.objects.link(ob)
    return ob


_mat_cache = {}


def material(name, rgb, rough=0.75, metal=0.0, emit=None, strength=1.0):
    """Principled material; emissive when `emit` (rgb) is given."""
    if name in _mat_cache and _mat_cache[name].name in bpy.data.materials:
        return _mat_cache[name]
    mat = bpy.data.materials.new(name)
    if mat.node_tree is None:
        mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*rgb, 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if emit is not None:
        bsdf.inputs["Emission Color"].default_value = (*emit, 1.0)
        bsdf.inputs["Emission Strength"].default_value = strength
    mat.use_backface_culling = False  # exported as doubleSided
    _mat_cache[name] = mat
    return mat


def mesh_object(name, verts, faces, mats=(), edges=(), mat_indices=None, flat=True):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], list(edges), list(faces))
    for m in mats:
        me.materials.append(m)
    if mat_indices is not None:
        for p, mi in zip(me.polygons, mat_indices):
            p.material_index = mi
    if flat:
        for p in me.polygons:
            p.use_smooth = False
    me.validate()
    me.update()
    return link(bpy.data.objects.new(name, me))


def add_empty(name, loc, yaw=0.0, props=None, size=1.0):
    ob = bpy.data.objects.new(name, None)
    ob.empty_display_type = "ARROWS"
    ob.empty_display_size = size
    ob.location = loc
    ob.rotation_euler = (0.0, 0.0, yaw)
    for k, v in (props or {}).items():
        ob[k] = v
    return link(ob)


def yaw_facing(dx, dy):
    """Rotation about Z that points an object's local -Y (its front) along (dx, dy)."""
    return math.atan2(dx, -dy)


def smoothstep(a, b, x):
    t = min(1.0, max(0.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


class Builder:
    """Accumulates primitives into one bmesh with material slots."""

    def __init__(self, name):
        self.name = name
        self.bm = bmesh.new()
        self.mats = []

    def slot(self, mat):
        if mat not in self.mats:
            self.mats.append(mat)
        return self.mats.index(mat)

    def _finish(self, verts, mat, matrix, bevel=0.0, mat_fn=None):
        """Assign materials, optionally bevel, then transform the new geometry."""
        bm = self.bm
        faces = {f for v in verts for f in v.link_faces}
        if bevel > 0:
            edges = list({e for f in faces for e in f.edges})
            r = bmesh.ops.bevel(bm, geom=edges, offset=bevel, segments=1, affect="EDGES", clamp_overlap=True)
            faces = {f for f in faces if f.is_valid} | set(r["faces"])
            faces |= {f for v in r["verts"] for f in v.link_faces}
        verts = list({v for f in faces for v in f.verts})
        mi = self.slot(mat)
        for f in faces:
            f.normal_update()
            f.material_index = mi if mat_fn is None else self.slot(mat_fn(f))
            f.smooth = False
        bmesh.ops.transform(bm, matrix=matrix, verts=verts)
        return list(faces)

    def box(self, center, size, mat, bevel=0.0, rot=None):
        r = bmesh.ops.create_cube(self.bm, size=1.0)
        m = Matrix.Translation(Vector(center)) @ (rot or Matrix.Identity(4)) @ Matrix.Diagonal((*size, 1.0))
        return self._finish(r["verts"], mat, m, bevel)

    def cylinder(self, center, radius, depth, mat, axis="Z", segments=16, r2=None, rot=None, cap_mat=None):
        r = bmesh.ops.create_cone(self.bm, cap_ends=True, cap_tris=False, segments=segments, radius1=radius, radius2=radius if r2 is None else r2, depth=depth)
        ax = {"Z": Matrix.Identity(4), "X": Matrix.Rotation(math.radians(90), 4, "Y"), "Y": Matrix.Rotation(math.radians(90), 4, "X")}[axis]
        m = Matrix.Translation(Vector(center)) @ (rot or Matrix.Identity(4)) @ ax
        mat_fn = None
        if cap_mat is not None:
            def mat_fn(f, cap_mat=cap_mat, mat=mat):
                return cap_mat if abs(f.normal.z) > 0.9 else mat
        return self._finish(r["verts"], mat, m, 0.0, mat_fn)

    def sphere(self, center, radius, mat, scale=(1, 1, 1), segments=16, rings=10):
        r = bmesh.ops.create_uvsphere(self.bm, u_segments=segments, v_segments=rings, radius=radius)
        m = Matrix.Translation(Vector(center)) @ Matrix.Diagonal((*scale, 1.0))
        return self._finish(r["verts"], mat, m)

    def ico(self, center, radius, mat, subdiv=1, scale=(1, 1, 1), jitter=0.0, rng=None):
        r = bmesh.ops.create_icosphere(self.bm, subdivisions=subdiv, radius=radius)
        faces = self._finish(r["verts"], mat, Matrix.Translation(Vector(center)) @ Matrix.Diagonal((*scale, 1.0)))
        if jitter > 0 and rng is not None:
            for v in {v for f in faces for v in f.verts}:
                d = (v.co - Vector(center))
                d.normalize()
                v.co += d * rng.uniform(-jitter, jitter) * radius
        return faces

    def cone(self, center, radius, height, mat, segments=8):
        return self.cylinder((center[0], center[1], center[2] + height / 2), radius, height, mat, r2=0.0, segments=segments)

    def build(self, name=None):
        name = name or self.name
        me = bpy.data.meshes.new(name)
        self.bm.to_mesh(me)
        self.bm.free()
        for m in self.mats:
            me.materials.append(m)
        me.validate()
        me.update()
        return link(bpy.data.objects.new(name, me))


# =============================================================================
# Track
# =============================================================================
# Blender XYZ, metres. Race direction = list order (counter-clockwise from above).
TRACK_CONTROL_POINTS = [
    (0, -100, 0.0),      # start/finish straight, heading +X
    (75, -104, 1.5),
    (140, -70, 5.0),
    (128, -5, 9.5),      # climb to the high point
    (160, 62, 7.0),
    (108, 112, 3.0),
    (38, 84, 0.0),
    (-22, 126, -2.5),    # dip
    (-98, 98, 1.0),
    (-140, 30, 4.5),
    (-118, -48, 7.5),
    (-62, -92, 3.0),
]
SAMPLE_SPACING = 2.0
CURB_WIDTH = 1.0


def make_track_curve(name="TRACK_CURVE"):
    cd = bpy.data.curves.new(name, "CURVE")
    cd.dimensions = "3D"
    cd.resolution_u = 48
    sp = cd.splines.new("BEZIER")
    sp.bezier_points.add(len(TRACK_CONTROL_POINTS) - 1)
    sp.use_cyclic_u = True
    for bp, p in zip(sp.bezier_points, TRACK_CONTROL_POINTS):
        bp.co = p
        bp.handle_left_type = "AUTO"
        bp.handle_right_type = "AUTO"
    ob = link(bpy.data.objects.new(name, cd))
    ob.hide_render = True
    return ob


def sample_curve(curve_ob, spacing=SAMPLE_SPACING):
    """Uniformly resampled closed polyline along the Bezier, plus the true curve length."""
    dg = bpy.context.evaluated_depsgraph_get()
    ev = curve_ob.evaluated_get(dg)
    me = ev.to_mesh()
    verts = [v.co.copy() for v in me.vertices]
    adj = {i: [] for i in range(len(verts))}
    for e in me.edges:
        a, b = e.vertices
        adj[a].append(b)
        adj[b].append(a)
    ev.to_mesh_clear()
    order = [0]
    prev, cur = 0, adj[0][0]
    while cur != 0:
        order.append(cur)
        nb = adj[cur]
        nxt = nb[0] if nb[0] != prev else nb[1]
        prev, cur = cur, nxt
    dense = [verts[i] for i in order]
    n = len(dense)
    cum = [0.0]
    for i in range(n):
        cum.append(cum[-1] + (dense[(i + 1) % n] - dense[i]).length)
    total = cum[-1]
    count = int(round(total / spacing))
    out = []
    j = 0
    for k in range(count):
        s = total * k / count
        while cum[j + 1] < s:
            j += 1
        seg = cum[j + 1] - cum[j]
        t = (s - cum[j]) / seg if seg > 0 else 0.0
        out.append(dense[j].lerp(dense[(j + 1) % n], t))
    curve_length = curve_ob.data.splines[0].calc_length(resolution=512)
    return out, curve_length


def track_frames(samples):
    """Tangent (unit XY), left normal, signed curvature and half-width per sample."""
    n = len(samples)
    tangents, normals, curv, hw = [], [], [], []
    for i in range(n):
        a = samples[(i - 1) % n]
        b = samples[(i + 1) % n]
        t = Vector((b.x - a.x, b.y - a.y, 0.0))
        t.normalize()
        tangents.append(t)
        normals.append(Vector((-t.y, t.x, 0.0)))
    for i in range(n):
        h0 = math.atan2(tangents[(i - 3) % n].y, tangents[(i - 3) % n].x)
        h1 = math.atan2(tangents[(i + 3) % n].y, tangents[(i + 3) % n].x)
        d = h1 - h0
        while d > math.pi:
            d -= 2 * math.pi
        while d < -math.pi:
            d += 2 * math.pi
        curv.append(d / (6 * SAMPLE_SPACING))
    cum = 0.0
    total = n * SAMPLE_SPACING
    for i in range(n):
        s = i * SAMPLE_SPACING
        w = 6.6 + 1.4 * math.sin(2 * math.pi * s / total * 3 + 0.8) + 1.2 * smoothstep(0.92, 1.0, s / total) + 1.2 * smoothstep(0.08, 0.0, s / total)
        hw.append(w)
    return tangents, normals, curv, hw


def build_track_surface(samples, tangents, normals, curv, hw):
    """Asphalt + curbs as one mesh with three material slots (drivable)."""
    asphalt = material("asphalt", (0.16, 0.16, 0.19), rough=0.9)
    curb_a = material("curb_red", (0.75, 0.16, 0.14), rough=0.6)
    curb_b = material("curb_pale", (0.92, 0.88, 0.80), rough=0.6)
    n = len(samples)
    verts, faces, mi = [], [], []
    for i in range(n):
        p, nrm = samples[i], normals[i]
        bank = max(-1.0, min(1.0, curv[i] * 28.0))
        w = hw[i]
        zl = p.z - bank * 0.5
        zr = p.z + bank * 0.5
        rl = p + nrm * w
        rr = p - nrm * w
        cl = p + nrm * (w + CURB_WIDTH)
        cr = p - nrm * (w + CURB_WIDTH)
        verts += [
            (cl.x, cl.y, zl + 0.08), (rl.x, rl.y, zl), (rr.x, rr.y, zr), (cr.x, cr.y, zr + 0.08),
        ]
    for i in range(n):
        a = i * 4
        b = ((i + 1) % n) * 4
        curb = 1 if (i // 2) % 2 == 0 else 2
        faces.append((a + 1, a + 2, b + 2, b + 1)); mi.append(0)
        faces.append((a + 0, a + 1, b + 1, b + 0)); mi.append(curb)
        faces.append((a + 2, a + 3, b + 3, b + 2)); mi.append(curb)
    return mesh_object(C.TRACK_SURFACE, verts, faces, [asphalt, curb_a, curb_b], mat_indices=mi)


def build_centerline(samples, curve_length):
    n = len(samples)
    edges = [(i, (i + 1) % n) for i in range(n)]
    ob = mesh_object(C.TRACK_CENTERLINE, [(p.x, p.y, p.z) for p in samples], [], edges=edges)
    ob[C.CURVE_LENGTH_PROP] = float(curve_length)
    ob.hide_render = True
    return ob


class Island:
    """Floating landmass under the track. Height is a function of distance to the track."""

    def __init__(self, samples, hw, rng):
        self.S = np.array([(p.x, p.y) for p in samples])
        self.SZ = np.array([p.z for p in samples])
        self.HW = np.array(hw)
        self.center = self.S.mean(axis=0)
        d = np.linalg.norm(self.S - self.center, axis=1)
        self.radius = float(d.max()) + 48.0
        self.rng = rng

    def nearest(self, pts):
        pts = np.asarray(pts, dtype=float)
        d2 = ((pts[:, None, :] - self.S[None, :, :]) ** 2).sum(-1)
        idx = d2.argmin(axis=1)
        return np.sqrt(d2[np.arange(len(pts)), idx]), idx

    def rim_radius(self, a):
        return self.radius * (1 + 0.07 * math.sin(3 * a + 0.4) + 0.04 * math.sin(7 * a + 1.9) + 0.03 * math.cos(11 * a))

    def height(self, pts):
        pts = np.asarray(pts, dtype=float)
        d, idx = self.nearest(pts)
        zt = self.SZ[idx]
        e = d - (self.HW[idx] + CURB_WIDTH)
        x, y = pts[:, 0], pts[:, 1]
        noise = 0.45 * np.sin(x * 0.11 + 1.3) * np.cos(y * 0.09) + 0.25 * np.sin(x * 0.31 + y * 0.27)
        out = np.empty(len(pts))
        for i in range(len(pts)):
            ei = e[i]
            if ei < -CURB_WIDTH:
                out[i] = zt[i] - 0.5
            elif ei < 0:
                out[i] = zt[i] - 0.5 + 0.42 * (ei + CURB_WIDTH) / CURB_WIDTH
            else:
                berm = 2.2 * smoothstep(0, 22, ei)
                fall = 9.0 * smoothstep(28, 75, ei)
                out[i] = zt[i] - 0.08 + berm - fall + noise[i] * smoothstep(0, 8, ei)
        return out

    def build(self):
        grass = material("grass_dusk", (0.20, 0.36, 0.22), rough=1.0)
        moss = material("moss", (0.26, 0.42, 0.20), rough=1.0)
        rock = material("rock_under", (0.28, 0.22, 0.27), rough=0.95)
        A, R = 96, 26
        cx, cy = self.center
        verts = [(cx, cy, 0.0)]
        for r in range(1, R + 1):
            for a in range(A):
                ang = 2 * math.pi * a / A
                rad = self.rim_radius(ang) * (r / R) ** 0.9
                verts.append((cx + rad * math.cos(ang), cy + rad * math.sin(ang), 0.0))
        hz = self.height([(v[0], v[1]) for v in verts])
        verts = [(v[0], v[1], float(h)) for v, h in zip(verts, hz)]
        faces, mi = [], []

        def vid(r, a):
            return 1 + (r - 1) * A + (a % A)

        for a in range(A):
            faces.append((0, vid(1, a), vid(1, a + 1))); mi.append(0)
        for r in range(1, R):
            for a in range(A):
                faces.append((vid(r, a), vid(r + 1, a), vid(r + 1, a + 1), vid(r, a + 1)))
                mi.append(1 if (a * 7 + r * 3) % 5 == 0 else 0)
        # Rock underside: rim -> three shrinking rings -> apex
        rim_z = min(v[2] for v in verts[vid(R, 0):]) - 1.0
        rings = [(1.02, -14), (0.86, -34), (0.55, -58)]
        base = len(verts)
        for k, (fr, dz) in enumerate(rings):
            for a in range(A):
                ang = 2 * math.pi * a / A
                rad = self.rim_radius(ang) * fr * (1 + 0.05 * math.sin(5 * ang + k))
                verts.append((cx + rad * math.cos(ang), cy + rad * math.sin(ang), rim_z + dz + 2.0 * math.sin(3 * ang + k * 1.7)))
        apex = len(verts)
        verts.append((cx, cy, rim_z - 78))

        def rid(k, a):
            return base + k * A + (a % A)

        for a in range(A):
            faces.append((vid(R, a), rid(0, a), rid(0, a + 1), vid(R, a + 1))); mi.append(2)
        for k in range(len(rings) - 1):
            for a in range(A):
                faces.append((rid(k, a), rid(k + 1, a), rid(k + 1, a + 1), rid(k, a + 1))); mi.append(2)
        last = len(rings) - 1
        for a in range(A):
            faces.append((rid(last, a), apex, rid(last, a + 1))); mi.append(2)
        return mesh_object("ISLAND", verts, faces, [grass, moss, rock], mat_indices=mi)


def build_walls_and_barriers(samples, tangents, normals, curv, hw):
    """Invisible WALL_* prisms on the outside of the three sharpest bends, plus visible fences."""
    n = len(samples)
    total = n * SAMPLE_SPACING
    sm = [sum(abs(curv[(i + k) % n]) for k in range(-6, 7)) / 13 for i in range(n)]
    apexes = []
    for i in sorted(range(n), key=lambda i: -sm[i]):
        s = i * SAMPLE_SPACING
        if all(min(abs(s - a * SAMPLE_SPACING), total - abs(s - a * SAMPLE_SPACING)) > 130 for a in apexes):
            apexes.append(i)
        if len(apexes) == 3:
            break
    apexes.sort()
    steel = material("barrier_steel", (0.55, 0.57, 0.60), rough=0.4, metal=0.6)
    stripe = material("barrier_stripe", (0.95, 0.60, 0.10), rough=0.5)
    ghost = material("wall_collision", (1.0, 0.0, 1.0), rough=1.0)
    walls = []
    span = int(32 / SAMPLE_SPACING)
    for wi, ai in enumerate(apexes, start=1):
        side = -1.0 if curv[ai] > 0 else 1.0  # outside of a left turn is the right (-normal)
        idxs = [(ai + k) % n for k in range(-span, span + 1)]
        verts, faces = [], []
        for j, i in enumerate(idxs):
            p, nrm = samples[i], normals[i]
            inner = p + nrm * side * (hw[i] + CURB_WIDTH + 0.6)
            outer = p + nrm * side * (hw[i] + CURB_WIDTH + 1.4)
            z0 = p.z - 0.4
            verts += [(inner.x, inner.y, z0), (inner.x, inner.y, z0 + 1.6), (outer.x, outer.y, z0 + 1.6), (outer.x, outer.y, z0)]
            if j > 0:
                a, b = (j - 1) * 4, j * 4
                faces += [(a, a + 1, b + 1, b), (a + 1, a + 2, b + 2, b + 1), (a + 2, a + 3, b + 3, b + 2), (a + 3, a, b, b + 3)]
        faces += [(0, 3, 2, 1), (len(verts) - 4, len(verts) - 3, len(verts) - 2, len(verts) - 1)]
        wall = mesh_object(f"{C.WALL_PREFIX}BEND_{wi}", verts, faces, [ghost])
        wall.display_type = "WIRE"
        walls.append(wall)
        # Visible fence (scenery): posts every 4 m and two rails.
        b = Builder(f"BARRIER_BEND_{wi}")
        for j, i in enumerate(idxs):
            p, nrm, t = samples[i], normals[i], tangents[i]
            c = p + nrm * side * (hw[i] + CURB_WIDTH + 1.0)
            if j % 2 == 0:
                b.box((c.x, c.y, p.z + 0.3), (0.14, 0.14, 1.5), steel)
            if j < len(idxs) - 1:
                q = samples[idxs[j + 1]] + normals[idxs[j + 1]] * side * (hw[idxs[j + 1]] + CURB_WIDTH + 1.0)
                mid = (c + q) / 2
                seg = (q - c)
                length = seg.length
                yaw = math.atan2(seg.y, seg.x)
                rot = Matrix.Rotation(yaw, 4, "Z")
                for zz, mat in ((0.45, stripe), (0.95, steel)):
                    b.box((mid.x, mid.y, (p.z + samples[idxs[j + 1]].z) / 2 + zz), (length, 0.08, 0.16), mat, rot=rot)
        b.build()
    return walls, apexes


def build_pads(samples, tangents, normals, curve_len):
    n = len(samples)
    amber = material("pad_glow", (1.0, 0.55, 0.1), rough=0.3, emit=(1.0, 0.45, 0.05), strength=3.0)
    dark = material("pad_base", (0.08, 0.07, 0.10), rough=0.8)
    pads = []
    for k, frac in enumerate([0.24, 0.53, 0.79], start=1):
        i = int(frac * n) % n
        p, t, nrm = samples[i], tangents[i], normals[i]
        add_empty(f"{C.PAD_PREFIX}{k}", (p.x, p.y, p.z + 0.05), yaw=yaw_facing(t.x, t.y), props={"radius": 3.0, "s": i * SAMPLE_SPACING}, size=3.0)
        b = Builder(f"MARK_PAD_{k}")
        rot = Matrix.Rotation(math.atan2(t.y, t.x), 4, "Z")
        b.box((p.x, p.y, p.z + 0.02), (5.0, 4.4, 0.04), dark, rot=rot)
        for dx in (-1.4, 0.0, 1.4):
            for sgn in (1, -1):
                arm = Matrix.Rotation(math.atan2(t.y, t.x), 4, "Z") @ Matrix.Rotation(sgn * math.radians(35), 4, "Z")
                cc = p + t * dx + nrm * sgn * 0.75
                b.box((cc.x, cc.y, p.z + 0.06), (2.0, 0.45, 0.04), amber, rot=arm)
        b.build()
        pads.append(k)
    return pads


def build_start_gate_and_line(samples, tangents, normals, hw):
    p, t, nrm = samples[0], tangents[0], normals[0]
    w = hw[0] + CURB_WIDTH + 2.2
    steel = material("gate_steel", (0.20, 0.21, 0.26), rough=0.5, metal=0.7)
    sign = material("gate_sign", (0.95, 0.40, 0.12), rough=0.4, emit=(1.0, 0.35, 0.08), strength=2.0)
    rot = Matrix.Rotation(math.atan2(t.y, t.x), 4, "Z")
    g = Builder("START_GATE")
    for sgn in (1, -1):
        c = p + nrm * sgn * w
        g.box((c.x, c.y, p.z + 3.5), (0.6, 0.6, 7.0), steel, bevel=0.05)
    g.box((p.x, p.y, p.z + 7.2), (0.7, 2 * w + 0.6, 0.8), steel, rot=rot)
    g.box((p.x, p.y, p.z + 8.4), (0.5, 2 * w * 0.7, 1.6), sign, rot=rot)
    g.build()
    white = material("line_white", (0.95, 0.95, 0.92), rough=0.7)
    black = material("line_black", (0.05, 0.05, 0.06), rough=0.7)
    verts, faces, mi = [], [], []
    segs = 10
    W = hw[0]
    for k in range(segs):
        f0 = -W + 2 * W * k / segs
        f1 = -W + 2 * W * (k + 1) / segs
        for r, off in ((0, -0.6), (1, 0.0), (2, 0.6)):
            a = p + nrm * f0 + t * off
            b = p + nrm * f1 + t * off
            verts += [(a.x, a.y, p.z + 0.015), (b.x, b.y, p.z + 0.015)]
        base = k * 6
        faces.append((base, base + 1, base + 3, base + 2)); mi.append(k % 2)
        faces.append((base + 2, base + 3, base + 5, base + 4)); mi.append((k + 1) % 2)
    mesh_object("START_LINE", verts, faces, [white, black], mat_indices=mi)
    add_empty(C.TRACK_START, (p.x, p.y, p.z), yaw=yaw_facing(t.x, t.y), props={"heading_deg": math.degrees(math.atan2(t.y, t.x))}, size=4.0)


# =============================================================================
# Scenery library
# =============================================================================
def scenery_prototype(kind, rng):
    b = Builder(f"SCN_{kind}")
    if kind == "tree_pine":
        bark = material("bark", (0.30, 0.20, 0.16), rough=0.95)
        leaf = material("pine_dusk", (0.12, 0.30, 0.34), rough=0.9)
        leaf2 = material("pine_dusk_dark", (0.09, 0.22, 0.30), rough=0.9)
        b.cylinder((0, 0, 1.2), 0.22, 2.4, bark, segments=7)
        b.cone((0, 0, 1.6), 2.4, 3.2, leaf, segments=7)
        b.cone((0, 0, 3.6), 1.9, 3.0, leaf2, segments=7)
        b.cone((0, 0, 5.4), 1.3, 2.8, leaf, segments=7)
    elif kind == "tree_round":
        bark = material("bark", (0.30, 0.20, 0.16), rough=0.95)
        leaf = material("mauve_canopy", (0.52, 0.30, 0.42), rough=0.9)
        b.cylinder((0, 0, 1.4), 0.25, 2.8, bark, segments=7)
        b.ico((0, 0, 4.4), 2.4, leaf, subdiv=1, scale=(1.0, 1.0, 0.85), jitter=0.12, rng=rng)
        b.ico((1.2, 0.6, 3.4), 1.4, leaf, subdiv=1, jitter=0.1, rng=rng)
    elif kind == "rock":
        stone = material("stone", (0.36, 0.33, 0.38), rough=0.95)
        b.ico((0, 0, 0.9), 1.4, stone, subdiv=1, scale=(1.3, 1.0, 0.75), jitter=0.22, rng=rng)
        b.ico((1.1, -0.4, 0.5), 0.8, stone, subdiv=1, jitter=0.2, rng=rng)
    elif kind == "crystal":
        crys = material("crystal_glow", (0.45, 0.75, 0.95), rough=0.15, emit=(0.35, 0.65, 1.0), strength=2.5)
        base = material("stone", (0.36, 0.33, 0.38), rough=0.95)
        b.ico((0, 0, 0.4), 1.0, base, subdiv=1, scale=(1.2, 1.2, 0.5), jitter=0.15, rng=rng)
        for (x, y, h, r, tilt) in ((0, 0, 5.0, 0.7, 0), (0.8, 0.5, 3.2, 0.45, 0.35), (-0.7, 0.4, 2.6, 0.4, -0.3)):
            rot = Matrix.Rotation(tilt, 4, "X")
            b.cylinder((x, y, h * 0.5), r, h, crys, segments=6, r2=0.05, rot=rot)
    elif kind == "lamp":
        post = material("lamp_post", (0.15, 0.15, 0.18), rough=0.5, metal=0.6)
        glow = material("lamp_glow", (1.0, 0.85, 0.55), rough=0.3, emit=(1.0, 0.75, 0.40), strength=4.0)
        b.cylinder((0, 0, 2.0), 0.08, 4.0, post, segments=8)
        b.box((0, 0, 0.1), (0.5, 0.5, 0.2), post)
        b.box((0, -0.35, 4.0), (0.08, 0.7, 0.08), post)
        b.sphere((0, -0.7, 3.9), 0.28, glow, segments=10, rings=6)
    elif kind == "banner":
        post = material("lamp_post", (0.15, 0.15, 0.18), rough=0.5, metal=0.6)
        cloth = material("banner_cloth", (0.85, 0.30, 0.20), rough=0.8)
        cloth2 = material("banner_cloth_2", (0.95, 0.75, 0.25), rough=0.8)
        b.cylinder((0, 0, 2.5), 0.06, 5.0, post, segments=6)
        b.box((0.55, 0, 3.9), (1.1, 0.04, 1.6), cloth)
        b.box((0.55, 0, 3.05), (1.1, 0.045, 0.3), cloth2)
    elif kind == "stand":
        conc = material("stand_concrete", (0.55, 0.53, 0.56), rough=0.9)
        seat = material("stand_seats", (0.20, 0.45, 0.55), rough=0.7)
        roof = material("stand_roof", (0.35, 0.18, 0.30), rough=0.6)
        for i in range(4):
            b.box((0, 0.9 + i * 1.3, 0.45 + i * 0.7), (12.0, 1.3, 0.9 + i * 1.4), conc)
            b.box((0, 0.5 + i * 1.3, 0.95 + i * 0.7), (11.6, 0.6, 0.25), seat)
        for x in (-5.5, 5.5):
            b.cylinder((x, 5.4, 4.0), 0.12, 8.0, conc, segments=6)
        b.box((0, 2.9, 8.0), (13.0, 6.5, 0.25), roof)
    else:
        raise ValueError(kind)
    return b.build()


def build_scenery_library(out_blend, out_dir):
    reset_scene()
    _mat_cache.clear()
    rng = random.Random(SEED + 100)
    protos = []
    for k, kind in enumerate(SCENERY_KINDS):
        ob = scenery_prototype(kind, rng)
        ob.location = (k * 18.0, 0.0, 0.0)  # lay the library out in a row for browsing
        protos.append(ob)
    bpy.ops.wm.save_as_mainfile(filepath=out_blend, compress=True)
    # Export each prototype standalone (at origin) to assets/scenery/<kind>.glb
    sizes = {}
    for ob in protos:
        loc = ob.location.copy()
        ob.location = (0, 0, 0)
        for o in bpy.context.scene.objects:
            o.select_set(o is ob)
        bpy.context.view_layer.objects.active = ob
        path = os.path.join(out_dir, "scenery", ob.name[4:] + ".glb")
        sizes[ob.name] = C.export_glb(path, use_selection=True)
        ob.location = loc
    return sizes


def build_track(out_blend, scenery_blend):
    reset_scene()
    _mat_cache.clear()
    rng = random.Random(SEED)
    curve = make_track_curve()
    samples, curve_len = sample_curve(curve)
    tangents, normals, curv, hw = track_frames(samples)
    n = len(samples)
    # Guard against a self-intersecting layout: far-apart samples must be far apart in XY.
    S = np.array([(p.x, p.y) for p in samples])
    d = np.sqrt(((S[:, None, :] - S[None, :, :]) ** 2).sum(-1))
    sep = np.abs(np.arange(n)[:, None] - np.arange(n)[None, :])
    sep = np.minimum(sep, n - sep) * SAMPLE_SPACING
    mask = sep > 60
    min_gap = float(d[mask].min())
    need = 2 * (max(hw) + CURB_WIDTH + 2.0) + 4.0
    if min_gap < need:
        raise RuntimeError(f"track layout overlaps itself: min gap {min_gap:.1f} m < {need:.1f} m")

    build_track_surface(samples, tangents, normals, curv, hw)
    build_centerline(samples, curve_len)
    build_start_gate_and_line(samples, tangents, normals, hw)
    pads = build_pads(samples, tangents, normals, curve_len)
    walls, apexes = build_walls_and_barriers(samples, tangents, normals, curv, hw)
    island = Island(samples, hw, rng)
    island.build()

    # Scenery: append the library meshes and place linked duplicates.
    with bpy.data.libraries.load(scenery_blend, link=False) as (src, dst):
        dst.meshes = [m for m in src.meshes if m.startswith("SCN_")]
    proto = {m.name: m for m in dst.meshes}
    counters = {k: 0 for k in SCENERY_KINDS}

    def place(kind, x, y, yaw, scale=1.0, z=None):
        counters[kind] += 1
        ob = bpy.data.objects.new(f"SCN_{kind}_{counters[kind]:03d}", proto[f"SCN_{kind}"])
        if z is None:
            z = float(island.height([(x, y)])[0])
        ob.location = (x, y, z - 0.05)
        ob.rotation_euler = (0, 0, yaw)
        ob.scale = (scale, scale, scale)
        return link(ob)

    placed = []
    total = n * SAMPLE_SPACING
    # Lamps along the track, alternating sides.
    s = 20.0
    k = 0
    while s < total - 20:
        i = int(s / SAMPLE_SPACING) % n
        side = 1.0 if k % 2 == 0 else -1.0
        p, nrm, t = samples[i], normals[i], tangents[i]
        c = p + nrm * side * (hw[i] + CURB_WIDTH + 2.4)
        place("lamp", c.x, c.y, yaw_facing(-nrm.x * side, -nrm.y * side), z=p.z + 0.05)
        placed.append((c.x, c.y))
        s += 44.0
        k += 1
    # Banners on the inside of each walled bend.
    for ai in apexes:
        side = 1.0 if curv[ai] > 0 else -1.0
        for off in (-10, 0, 10):
            i = (ai + int(off / SAMPLE_SPACING)) % n
            p, nrm, t = samples[i], normals[i], tangents[i]
            c = p + nrm * side * (hw[i] + CURB_WIDTH + 2.6)
            place("banner", c.x, c.y, math.atan2(t.y, t.x), z=p.z + 0.05)
            placed.append((c.x, c.y))
    # Grandstands on the left of the start straight, facing the track.
    for s in (26.0, 42.0):
        i = int(s / SAMPLE_SPACING)
        p, nrm, t = samples[i], normals[i], tangents[i]
        c = p + nrm * (hw[i] + CURB_WIDTH + 9.0)
        place("stand", c.x, c.y, yaw_facing(-nrm.x, -nrm.y), z=p.z + 0.02)
        placed.append((c.x, c.y))
    # Random scatter on the island.
    kinds = ["tree_pine"] * 32 + ["tree_round"] * 26 + ["rock"] * 22 + ["crystal"] * 12
    tries = 0
    count = 0
    while count < 110 and tries < 3000:
        tries += 1
        ang = rng.uniform(0, 2 * math.pi)
        rad = island.rim_radius(ang) * math.sqrt(rng.uniform(0.02, 0.86))
        x = island.center[0] + rad * math.cos(ang)
        y = island.center[1] + rad * math.sin(ang)
        dist, idx = island.nearest([(x, y)])
        if dist[0] < hw[idx[0]] + CURB_WIDTH + 4.5:
            continue
        if any((x - px) ** 2 + (y - py) ** 2 < 7.0 ** 2 for px, py in placed):
            continue
        kind = rng.choice(kinds)
        place(kind, x, y, rng.uniform(0, 2 * math.pi), scale=rng.uniform(0.8, 1.35))
        placed.append((x, y))
        count += 1

    C.apply_transforms([o for o in bpy.context.scene.objects if o.type == "MESH" and o.data.users == 1])
    info = C.validate_track_scene(bpy.context.scene)
    bpy.ops.wm.save_as_mainfile(filepath=out_blend, compress=True)
    return info


# =============================================================================
# Karts (original designs; long axis = Y, forward = -Y, wheels on z=0)
# =============================================================================
def kart_wheels(b, positions, radius, width, tire, rim):
    """Wheels are separate objects so the loader can spin/steer them."""
    b.build()
    objs = []
    for name, (x, y) in positions.items():
        w = Builder(name)
        w.cylinder((0, 0, 0), radius, width, tire, axis="X", segments=14, cap_mat=rim)
        w.cylinder((0, 0, 0), radius * 0.55, width * 1.05, rim, axis="X", segments=8)
        ob = w.build()
        ob.location = (x, y, radius)
        objs.append(ob)
    return objs


def kart_driver(b, color, z=0.62, y=0.15):
    suit = material("driver_suit", color, rough=0.8)
    visor = material("visor", (0.1, 0.1, 0.12), rough=0.2, metal=0.3)
    b.box((0, y, z + 0.25), (0.42, 0.34, 0.45), suit, bevel=0.05)
    b.sphere((0, y, z + 0.7), 0.21, suit, segments=12, rings=8)
    b.box((0, y - 0.16, z + 0.7), (0.26, 0.10, 0.12), visor)


def kart_ember():
    body = material("ember_orange", (0.92, 0.36, 0.08), rough=0.45)
    dark = material("ember_charcoal", (0.10, 0.10, 0.12), rough=0.6)
    tire = material("tire", (0.05, 0.05, 0.05), rough=0.95)
    rim = material("rim_light", (0.80, 0.80, 0.82), rough=0.3, metal=0.8)
    b = Builder("EMBER_BODY")
    faces = b.box((0, 0.15, 0.36), (1.25, 2.35, 0.34), body, bevel=0.06)
    for v in {v for f in faces for v in f.verts}:
        if v.co.y < -0.6:  # taper the nose
            v.co.x *= 0.55
            v.co.z -= 0.06 * (-0.6 - v.co.y)
    b.box((0, 0.35, 0.58), (0.7, 0.9, 0.25), dark, bevel=0.04)  # cockpit surround
    b.box((0, 1.05, 0.58), (0.6, 0.3, 0.25), dark)
    for x in (-0.5, 0.5):
        b.box((x, 1.1, 0.75), (0.06, 0.25, 0.4), dark)
    b.box((0, 1.15, 0.97), (1.45, 0.38, 0.05), body)  # rear wing
    for x in (-0.25, 0.25):
        b.cylinder((x, 1.38, 0.35), 0.06, 0.3, rim, axis="Y", segments=8)
    kart_driver(b, (0.12, 0.12, 0.14))
    return kart_wheels(b, {"WHEEL_FL": (-0.66, -0.78), "WHEEL_FR": (0.66, -0.78), "WHEEL_RL": (-0.70, 0.82), "WHEEL_RR": (0.70, 0.82)}, 0.29, 0.26, tire, rim)


def kart_tideglass():
    body = material("tide_teal", (0.05, 0.52, 0.55), rough=0.35)
    cream = material("tide_cream", (0.95, 0.92, 0.82), rough=0.5)
    glass = material("tide_glass", (0.65, 0.90, 0.95), rough=0.08, metal=0.1)
    tire = material("tire", (0.05, 0.05, 0.05), rough=0.95)
    rim = material("rim_cream", (0.95, 0.92, 0.82), rough=0.3, metal=0.5)
    b = Builder("TIDEGLASS_BODY")
    b.sphere((0, 0.05, 0.5), 0.72, body, scale=(0.95, 1.55, 0.55), segments=18, rings=10)
    b.box((0, 0.05, 0.28), (1.2, 2.0, 0.16), cream, bevel=0.05)
    b.sphere((0, -0.05, 0.78), 0.5, glass, scale=(0.8, 1.0, 0.55), segments=14, rings=8)
    for x in (-0.62, 0.62):
        b.box((x, 0.85, 0.7), (0.06, 0.5, 0.3), cream)
    b.box((0, 0.95, 0.55), (0.5, 0.35, 0.2), cream, bevel=0.03)
    kart_driver(b, (0.95, 0.92, 0.82), z=0.55, y=0.05)
    return kart_wheels(b, {"WHEEL_FL": (-0.58, -0.72), "WHEEL_FR": (0.58, -0.72), "WHEEL_RL": (-0.58, 0.72), "WHEEL_RR": (0.58, 0.72)}, 0.30, 0.28, tire, rim)


def kart_ironmoth():
    olive = material("moth_olive", (0.35, 0.42, 0.18), rough=0.8)
    rust = material("moth_rust", (0.55, 0.25, 0.12), rough=0.85)
    steel = material("moth_steel", (0.45, 0.45, 0.47), rough=0.5, metal=0.7)
    tire = material("tire_chunky", (0.06, 0.06, 0.06), rough=1.0)
    rim = material("rim_rust", (0.55, 0.25, 0.12), rough=0.6, metal=0.3)
    b = Builder("IRONMOTH_BODY")
    b.box((0, 0.1, 0.62), (1.15, 2.0, 0.55), olive, bevel=0.04)
    b.box((0, -0.85, 0.75), (1.0, 0.5, 0.35), rust, bevel=0.03)  # hood block
    b.box((0, -1.2, 0.45), (1.35, 0.12, 0.12), steel)  # bumper
    for x, y in ((-0.5, -0.5), (0.5, -0.5), (-0.5, 0.7), (0.5, 0.7)):
        b.cylinder((x, y, 1.15), 0.045, 0.9, steel, segments=6)
    for y in (-0.5, 0.7):
        b.cylinder((0, y, 1.6), 0.045, 1.0, steel, axis="X", segments=6)
    for x in (-0.5, 0.5):
        b.cylinder((x, 0.1, 1.6), 0.045, 1.2, steel, axis="Y", segments=6)
    b.cylinder((0, 1.2, 0.85), 0.32, 0.25, tire, axis="Y", segments=12, cap_mat=rim)  # spare
    b.cylinder((0.45, 0.9, 1.4), 0.02, 1.2, steel, segments=4)  # antenna
    kart_driver(b, (0.55, 0.25, 0.12), z=0.8, y=0.15)
    return kart_wheels(b, {"WHEEL_FL": (-0.74, -0.75), "WHEEL_FR": (0.74, -0.75), "WHEEL_RL": (-0.74, 0.75), "WHEEL_RR": (0.74, 0.75)}, 0.40, 0.36, tire, rim)


def kart_nightjar():
    purple = material("jar_purple", (0.30, 0.08, 0.45), rough=0.4)
    gold = material("jar_gold", (0.90, 0.72, 0.20), rough=0.3, metal=0.8)
    tire = material("tire", (0.05, 0.05, 0.05), rough=0.95)
    rim = material("rim_gold", (0.90, 0.72, 0.20), rough=0.3, metal=0.8)
    b = Builder("NIGHTJAR_BODY")
    faces = b.box((0, 0.1, 0.32), (0.62, 3.1, 0.3), purple, bevel=0.05)
    for v in {v for f in faces for v in f.verts}:
        if v.co.y < -0.9:
            v.co.x *= 0.45
            v.co.z -= 0.05 * (-0.9 - v.co.y)
    b.box((0, 0.55, 0.55), (0.55, 0.9, 0.25), gold, bevel=0.03)
    b.cylinder((0, 1.1, 0.55), 0.22, 0.6, gold, axis="Y", segments=10)  # engine cowl
    for x in (-0.3, 0.3):
        b.box((x, 1.35, 0.95), (0.05, 0.2, 0.7), purple)
    b.box((0, 1.4, 1.3), (1.5, 0.35, 0.05), gold)  # tall rear wing
    b.box((0, -1.55, 0.2), (1.2, 0.25, 0.04), gold)  # front wing
    kart_driver(b, (0.90, 0.72, 0.20), z=0.45, y=0.25)
    return kart_wheels(b, {"WHEEL_FL": (-0.55, -1.2), "WHEEL_FR": (0.55, -1.2), "WHEEL_RL": (-0.68, 0.95), "WHEEL_RR": (0.68, 0.95)}, 0.30, 0.22, tire, rim) and None


KART_BUILDERS = {"ember": kart_ember, "tideglass": kart_tideglass, "ironmoth": kart_ironmoth, "nightjar": kart_nightjar}


def build_kart(name, out_blend):
    reset_scene()
    _mat_cache.clear()
    KART_BUILDERS[name]()
    # Nightjar: front wheels are smaller than the rear (dragster stance).
    if name == "nightjar":
        for wn in ("WHEEL_FL", "WHEEL_FR"):
            ob = bpy.data.objects[wn]
            ob.scale = (0.8, 0.7, 0.7)
            ob.location.z = 0.30 * 0.7
    C.apply_transforms([o for o in bpy.context.scene.objects if o.type == "MESH"], location=False)
    info = C.validate_kart_scene(bpy.context.scene)
    bpy.ops.wm.save_as_mainfile(filepath=out_blend, compress=True)
    return info


# =============================================================================
# Export from .blend (used by both modes)
# =============================================================================
def export_from_blend(blend_path, glb_path, kind):
    bpy.ops.wm.open_mainfile(filepath=blend_path)
    scene = bpy.context.scene
    if kind == "track":
        info = C.validate_track_scene(scene)
    elif kind == "kart":
        info = C.validate_kart_scene(scene)
    else:
        info = {"objects": len(scene.objects)}
    size = C.export_glb(glb_path)
    info["glb_bytes"] = size
    return info


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--from-blend", action="store_true", help="skip generation; validate and export the committed .blend files")
    ap.add_argument("--only", choices=["track", "karts", "scenery"], help="build a subset")
    ap.add_argument("--blend-dir", default=BLEND_DIR)
    ap.add_argument("--out", default=ASSET_DIR, help="asset output root")
    args = ap.parse_args(argv)
    os.makedirs(args.blend_dir, exist_ok=True)
    os.makedirs(os.path.join(args.out, "karts"), exist_ok=True)
    os.makedirs(os.path.join(args.out, "scenery"), exist_ok=True)
    want = lambda k: args.only is None or args.only == k  # noqa: E731

    scenery_blend = os.path.join(args.blend_dir, "scenery.blend")
    track_blend = os.path.join(args.blend_dir, "track.blend")
    report = {}
    try:
        if want("scenery"):
            if args.from_blend:
                bpy.ops.wm.open_mainfile(filepath=scenery_blend)
                sizes = {}
                for ob in [o for o in bpy.context.scene.objects if o.name.startswith("SCN_")]:
                    loc = ob.location.copy()
                    ob.location = (0, 0, 0)
                    for o in bpy.context.scene.objects:
                        o.select_set(o is ob)
                    bpy.context.view_layer.objects.active = ob
                    sizes[ob.name] = C.export_glb(os.path.join(args.out, "scenery", ob.name[4:] + ".glb"), use_selection=True)
                    ob.location = loc
                report["scenery"] = sizes
            else:
                report["scenery"] = build_scenery_library(scenery_blend, args.out)
        if want("track"):
            if not args.from_blend:
                if not os.path.exists(scenery_blend):
                    build_scenery_library(scenery_blend, args.out)
                report["track_build"] = build_track(track_blend, scenery_blend)
            report["track"] = export_from_blend(track_blend, os.path.join(args.out, "track.glb"), "track")
        if want("karts"):
            for name in KART_NAMES:
                kb = os.path.join(args.blend_dir, f"kart_{name}.blend")
                if not args.from_blend:
                    build_kart(name, kb)
                report[f"kart_{name}"] = export_from_blend(kb, os.path.join(args.out, "karts", f"{name}.glb"), "kart")
    except C.ContractError as e:
        print(f"CONTRACT ERROR: {e}", file=sys.stderr)
        return 2
    for k, v in report.items():
        print(f"{k}: {v}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
