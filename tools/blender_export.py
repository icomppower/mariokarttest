"""Blender contract for Dusk Circuit: object names, validation, and export.

This module is the single source of truth for the names the game expects in
assets/track.glb and assets/karts/*.glb (see SPEC.md "Blender contract").
It is imported by build_assets.py (which needs bpy) and by validate_glb.py
(which does not); only the functions that touch bpy import it lazily.
"""

import math

# --- Names ----------------------------------------------------------------
TRACK_SURFACE = "TRACK_SURFACE"
TRACK_CENTERLINE = "TRACK_CENTERLINE"
TRACK_START = "TRACK_START"
PAD_PREFIX = "PAD_"
WALL_PREFIX = "WALL_"
CURVE_LENGTH_PROP = "curve_length"
WHEEL_NAMES = ("WHEEL_FL", "WHEEL_FR", "WHEEL_RL", "WHEEL_RR")

# Kart contract: loader scales the longest horizontal dimension to this.
KART_LENGTH_M = 2.4

GLTF_EXPORT_SETTINGS = dict(
    export_format="GLB",
    export_apply=True,        # apply modifiers
    export_yup=True,          # Blender Z-up -> glTF Y-up (Blender -Y -> glTF +Z)
    export_extras=True,       # custom properties -> extras (curve_length, radius)
    use_mesh_edges=True,      # loose edges -> LINES primitives (TRACK_CENTERLINE)
    export_animations=False,
    export_skins=False,
    export_morph=False,
    export_lights=False,
    export_cameras=False,
    export_texcoords=True,
    export_normals=True,
    export_materials="EXPORT",
    export_image_format="NONE",
    export_vertex_color="NONE",
    export_draco_mesh_compression_enable=False,
)


class ContractError(Exception):
    """Raised with a message that names the offending object."""


# --- Validation against a live Blender scene ------------------------------
def _objects(scene):
    return {ob.name: ob for ob in scene.objects}


def _sync():
    import bpy

    bpy.context.view_layer.update()  # matrix_world is stale on freshly created objects


def validate_track_scene(scene):
    """Check the Blender scene honours the track contract. Raises ContractError."""
    _sync()
    obs = _objects(scene)

    surf = obs.get(TRACK_SURFACE)
    if surf is None:
        raise ContractError(f"missing object {TRACK_SURFACE}")
    if surf.type != "MESH" or len(surf.data.polygons) == 0:
        raise ContractError(f"{TRACK_SURFACE} must be a mesh with faces")

    cl = obs.get(TRACK_CENTERLINE)
    if cl is None:
        raise ContractError(f"missing object {TRACK_CENTERLINE}")
    if cl.type != "MESH":
        raise ContractError(f"{TRACK_CENTERLINE} must be a mesh (edges only), got {cl.type}")
    me = cl.data
    if len(me.polygons) != 0:
        raise ContractError(f"{TRACK_CENTERLINE} must have no faces (has {len(me.polygons)})")
    if len(me.vertices) < 3:
        raise ContractError(f"{TRACK_CENTERLINE} needs at least 3 vertices")
    degree = [0] * len(me.vertices)
    for e in me.edges:
        degree[e.vertices[0]] += 1
        degree[e.vertices[1]] += 1
    bad = [i for i, d in enumerate(degree) if d != 2]
    if bad:
        raise ContractError(f"{TRACK_CENTERLINE} is not a single closed loop (vertices with degree != 2: {bad[:5]})")
    if CURVE_LENGTH_PROP not in cl:
        raise ContractError(f"{TRACK_CENTERLINE} is missing custom property '{CURVE_LENGTH_PROP}'")
    poly_len = _polyline_length(cl)
    curve_len = float(cl[CURVE_LENGTH_PROP])
    if abs(poly_len - curve_len) / curve_len > 0.02:
        raise ContractError(
            f"{TRACK_CENTERLINE} polyline length {poly_len:.1f} m differs from {CURVE_LENGTH_PROP}={curve_len:.1f} m by more than 2%"
        )

    start = obs.get(TRACK_START)
    if start is None:
        raise ContractError(f"missing object {TRACK_START}")
    if start.type != "EMPTY":
        raise ContractError(f"{TRACK_START} must be an empty, got {start.type}")

    for name, ob in obs.items():
        if name.startswith(PAD_PREFIX) and ob.type != "EMPTY":
            raise ContractError(f"{name} must be an empty (boost pad), got {ob.type}")
        if name.startswith(WALL_PREFIX) and (ob.type != "MESH" or len(ob.data.polygons) == 0):
            raise ContractError(f"{name} must be a mesh with faces (collision wall)")
    for name, ob in obs.items():
        if ob.type == "MESH" and name not in (TRACK_CENTERLINE,) and ob.matrix_world.to_3x3().determinant() <= 0:
            raise ContractError(f"{name} has a negative-scale transform; apply transforms before export")
    return {
        "surface_faces": len(surf.data.polygons),
        "centerline_vertices": len(me.vertices),
        "curve_length": curve_len,
        "polyline_length": poly_len,
        "pads": sorted(n for n in obs if n.startswith(PAD_PREFIX)),
        "walls": sorted(n for n in obs if n.startswith(WALL_PREFIX)),
        "objects": len(obs),
    }


def _polyline_length(ob):
    me = ob.data
    mw = ob.matrix_world
    verts = [mw @ v.co for v in me.vertices]
    total = 0.0
    for e in me.edges:
        a, b = verts[e.vertices[0]], verts[e.vertices[1]]
        total += (a - b).length
    return total


def validate_kart_scene(scene, tol=0.02):
    """Wheels on the ground plane, long axis forward (-Y), at least one mesh."""
    _sync()
    meshes = [ob for ob in scene.objects if ob.type == "MESH"]
    if not meshes:
        raise ContractError("kart has no mesh objects")
    lo = [math.inf] * 3
    hi = [-math.inf] * 3
    for ob in meshes:
        mw = ob.matrix_world
        for v in ob.data.vertices:
            w = mw @ v.co
            for i in range(3):
                lo[i] = min(lo[i], w[i])
                hi[i] = max(hi[i], w[i])
    if abs(lo[2]) > tol:
        raise ContractError(f"kart lowest point z={lo[2]:.3f}; wheels must touch the ground plane z=0")
    if (hi[1] - lo[1]) < (hi[0] - lo[0]):
        raise ContractError("kart long axis must be Y (forward = -Y); it is wider than it is long")
    names = {ob.name for ob in scene.objects}
    wheels = [n for n in WHEEL_NAMES if n in names]
    return {"meshes": len(meshes), "size": [hi[i] - lo[i] for i in range(3)], "wheels": wheels}


# --- Export ---------------------------------------------------------------
def apply_transforms(objects, location=True):
    """Bake rotation/scale (and optionally location) into mesh data."""
    import bpy
    from mathutils import Matrix

    _sync()
    for ob in objects:
        if ob.type != "MESH" or ob.data.users > 1:
            continue  # linked duplicates keep their TRS (they share mesh data)
        mw = ob.matrix_world.copy()
        if location:
            ob.data.transform(mw)
            ob.matrix_world = Matrix.Identity(4)
        else:
            rs = mw.to_3x3().to_4x4()
            ob.data.transform(rs)
            ob.matrix_world = Matrix.Translation(mw.to_translation())
    _sync()


def export_glb(filepath, use_selection=False):
    import bpy, os

    os.makedirs(os.path.dirname(os.path.abspath(filepath)), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=filepath, use_selection=use_selection, **GLTF_EXPORT_SETTINGS)
    return os.path.getsize(filepath)
