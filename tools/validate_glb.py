#!/usr/bin/env python3
"""Validate exported .glb files against the Dusk Circuit contract, without bpy.

    python tools/validate_glb.py assets/track.glb            # track contract
    python tools/validate_glb.py --kart assets/karts/*.glb   # kart contract

Exit code 1 and a message naming the offending object on failure.
"""
import argparse
import json
import struct
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import blender_export as C  # noqa: E402


def read_glb(path):
    with open(path, "rb") as f:
        data = f.read()
    magic, version, length = struct.unpack_from("<III", data, 0)
    if magic != 0x46546C67:
        raise C.ContractError(f"{path}: not a GLB (bad magic)")
    off = 12
    js = None
    while off < length:
        clen, ctype = struct.unpack_from("<II", data, off)
        if ctype == 0x4E4F534A:
            js = json.loads(data[off + 8 : off + 8 + clen])
        off += 8 + clen
    if js is None:
        raise C.ContractError(f"{path}: no JSON chunk")
    return js


def _nodes(js):
    return {n.get("name", f"node{i}"): n for i, n in enumerate(js.get("nodes", []))}


def validate_track(path):
    js = read_glb(path)
    nodes = _nodes(js)
    meshes = js.get("meshes", [])

    def mesh_of(name):
        n = nodes.get(name)
        if n is None:
            raise C.ContractError(f"{path}: missing object {name}")
        if "mesh" not in n:
            raise C.ContractError(f"{path}: {name} must be a mesh node")
        return meshes[n["mesh"]], n

    surf, _ = mesh_of(C.TRACK_SURFACE)
    tri = [p for p in surf["primitives"] if p.get("mode", 4) == 4]
    if not tri:
        raise C.ContractError(f"{path}: {C.TRACK_SURFACE} has no triangle primitives")

    cl, cl_node = mesh_of(C.TRACK_CENTERLINE)
    if any(p.get("mode", 4) == 4 for p in cl["primitives"]):
        raise C.ContractError(f"{path}: {C.TRACK_CENTERLINE} must be edges only (found triangles)")
    if not any(p.get("mode", 4) == 1 for p in cl["primitives"]):
        raise C.ContractError(f"{path}: {C.TRACK_CENTERLINE} has no LINES primitive (export with use_mesh_edges)")
    extras = {**cl.get("extras", {}), **cl_node.get("extras", {})}
    if C.CURVE_LENGTH_PROP not in extras:
        raise C.ContractError(f"{path}: {C.TRACK_CENTERLINE} extras lack {C.CURVE_LENGTH_PROP}")
    n_verts = js["accessors"][cl["primitives"][0]["attributes"]["POSITION"]]["count"]

    st = nodes.get(C.TRACK_START)
    if st is None:
        raise C.ContractError(f"{path}: missing empty {C.TRACK_START}")
    if "mesh" in st:
        raise C.ContractError(f"{path}: {C.TRACK_START} must be an empty, not a mesh")

    pads = sorted(n for n in nodes if n.startswith(C.PAD_PREFIX))
    for p in pads:
        if "mesh" in nodes[p]:
            raise C.ContractError(f"{path}: {p} must be an empty")
    walls = sorted(n for n in nodes if n.startswith(C.WALL_PREFIX))
    for w in walls:
        if "mesh" not in nodes[w]:
            raise C.ContractError(f"{path}: {w} must be a mesh")
    return {
        "file": path,
        "bytes": os.path.getsize(path),
        "nodes": len(nodes),
        "meshes": len(meshes),
        "centerline_vertices": n_verts,
        "curve_length": extras[C.CURVE_LENGTH_PROP],
        "pads": pads,
        "walls": walls,
    }


def validate_kart(path, tol=0.03):
    js = read_glb(path)
    nodes = _nodes(js)
    meshes = js.get("meshes", [])
    acc = js["accessors"]
    lo = [1e9] * 3
    hi = [-1e9] * 3
    count = 0
    for name, n in nodes.items():
        if "mesh" not in n:
            continue
        t = n.get("translation", [0, 0, 0])
        s = n.get("scale", [1, 1, 1])
        for p in meshes[n["mesh"]]["primitives"]:
            a = acc[p["attributes"]["POSITION"]]
            count += 1
            for i in range(3):
                vals = sorted([a["min"][i] * s[i] + t[i], a["max"][i] * s[i] + t[i]])
                lo[i] = min(lo[i], vals[0])
                hi[i] = max(hi[i], vals[1])
    if count == 0:
        raise C.ContractError(f"{path}: kart has no meshes")
    if abs(lo[1]) > tol:
        raise C.ContractError(f"{path}: lowest point y={lo[1]:.3f}; wheels must touch y=0")
    if (hi[2] - lo[2]) < (hi[0] - lo[0]):
        raise C.ContractError(f"{path}: kart long axis must be Z (forward); it is wider than long")
    wheels = [w for w in C.WHEEL_NAMES if w in nodes]
    return {"file": path, "bytes": os.path.getsize(path), "meshes": count, "size": [round(hi[i] - lo[i], 2) for i in range(3)], "wheels": wheels}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("files", nargs="+")
    ap.add_argument("--kart", action="store_true", help="validate with the kart contract")
    args = ap.parse_args(argv)
    ok = True
    for f in args.files:
        try:
            info = validate_kart(f) if args.kart else validate_track(f)
            print("OK  ", json.dumps(info))
        except C.ContractError as e:
            ok = False
            print("FAIL", e)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
