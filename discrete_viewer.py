#!/usr/bin/env python3
"""
Discrete Viewer — view, inspect and edit discrete-geometry netCDF models
(vegetation, vehicles, ...) used by the thermal solver / rendering pipeline.

Usage:
    python discrete_viewer.py [model.nc] [--port 8765] [--no-browser]

The server binds to 127.0.0.1 only. All netCDF reading and writing happens
here (netCDF4 library) so files are reproduced faithfully on save; the browser
UI only ever sends back the variables/attributes that were edited.
"""
from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import re
import shutil
import sys
import tempfile
import threading
import traceback
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

import numpy as np
import netCDF4

APP_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(APP_DIR, "static")

# Names tried (case-insensitive) when auto-detecting the model layout.
COORD_NAMES = (("x", "y", "z"), ("px", "py", "pz"), ("vx", "vy", "vz"))
XYZ_NAMES = ("xyz", "vertices", "verts", "coords", "coordinates", "nodes", "points")
CONN_NAMES = ("tri", "tris", "triangles", "elements", "elem", "elems", "connectivity",
              "conn", "faces", "facets", "quads", "cells")
GROUPID_NAMES = ("groupid", "group_id", "group", "groups", "partid", "part_id", "part",
                 "region", "regionid")
GROUPNAME_NAMES = ("groupnames", "group_names", "groupname", "partnames", "part_names", "names")


# --------------------------------------------------------------------------- helpers
def to_jsonable(v):
    """Convert attribute values / numpy scalars to JSON-friendly python values."""
    if isinstance(v, bytes):
        return v.decode("utf-8", "replace")
    if isinstance(v, np.ndarray):
        if v.dtype.kind == "S":
            return [x.decode("utf-8", "replace") for x in v.tolist()]
        return [to_jsonable(x) for x in v.tolist()]
    if isinstance(v, (list, tuple)):
        return [to_jsonable(x) for x in v]
    if isinstance(v, np.generic):
        v = v.item()
    if isinstance(v, float) and not np.isfinite(v):
        return str(v)
    return v


def attr_dtype(v) -> str:
    if isinstance(v, str):
        return "str"
    if isinstance(v, bytes):
        return "bytes"
    a = np.asarray(v)
    return a.dtype.str


def var_kind(var) -> str:
    dt = var.datatype
    if var.dtype is str:
        return "str"
    if isinstance(dt, netCDF4.CompoundType):
        return "compound"
    if isinstance(dt, netCDF4.VLType):
        return "vlen"
    if isinstance(dt, netCDF4.EnumType):
        return "enum"
    if np.dtype(var.dtype).kind == "S":
        return "char"
    return "num"


def dtype_label(var) -> str:
    k = var_kind(var)
    if k == "str":
        return "string"
    if k in ("compound", "vlen", "enum"):
        return f"{k}:{var.datatype.name}"
    return np.dtype(var.dtype).name if k == "num" else "char"


def read_raw(var):
    var.set_auto_maskandscale(False)
    if var.dtype is not str and np.dtype(var.dtype).kind != "S":
        var.set_always_mask(False)
    return var[...]


def read_strings(var) -> list[str]:
    """Return a 1-D list of python strings from a vlen-string or char variable."""
    data = read_raw(var)
    if var.dtype is str:
        return [str(s) for s in np.asarray(data, dtype=object).ravel().tolist()]
    arr = netCDF4.chartostring(np.asarray(data))
    return [s.decode("utf-8", "replace") if isinstance(s, bytes) else str(s)
            for s in np.atleast_1d(arr).tolist()]


def wire_dtype(dt: np.dtype) -> np.dtype:
    """Dtype used to ship numeric data to the browser (JS has no 64-bit int typed arrays we want)."""
    dt = np.dtype(dt)
    if dt.kind in "iu" and dt.itemsize == 8:
        return np.dtype("<f8")
    if dt.kind == "b":
        return np.dtype("u1")
    return dt.newbyteorder("<")


def find_var(group, name):
    """Resolve '/sub/group/var' or 'var' relative to root."""
    parts = [p for p in name.split("/") if p]
    g = group
    for p in parts[:-1]:
        g = g.groups[p]
    return g.variables[parts[-1]]


def find_group(root, path):
    parts = [p for p in path.split("/") if p]
    g = root
    for p in parts:
        g = g.groups[p]
    return g


def ci_lookup(variables, names):
    low = {k.lower(): k for k in variables}
    for n in names:
        if n in low:
            return low[n]
    return None


# --------------------------------------------------------------------------- schema
def describe_group(g, stats=True):
    out = {
        "name": g.name if g.path != "/" else "/",
        "path": g.path,
        "attrs": [{"name": k, "value": to_jsonable(g.getncattr(k)), "dtype": attr_dtype(g.getncattr(k))}
                  for k in g.ncattrs()],
        "dims": [{"name": k, "size": len(d), "unlimited": d.isunlimited()} for k, d in g.dimensions.items()],
        "vars": [],
        "groups": [],
    }
    for name, v in g.variables.items():
        vd = {
            "name": name,
            "path": (g.path.rstrip("/") + "/" + name),
            "dtype": dtype_label(v),
            "kind": var_kind(v),
            "dims": list(v.dimensions),
            "shape": list(v.shape),
            "attrs": [{"name": k, "value": to_jsonable(v.getncattr(k)), "dtype": attr_dtype(v.getncattr(k))}
                      for k in v.ncattrs()],
        }
        try:
            f = v.filters() or {}
            vd["compression"] = {k: to_jsonable(val) for k, val in f.items() if val}
            vd["chunking"] = to_jsonable(v.chunking())
        except Exception:
            pass
        if stats and vd["kind"] == "num" and v.size and v.size <= 20_000_000:
            try:
                a = np.asarray(read_raw(v))
                vd["stats"] = {"min": to_jsonable(a.min()), "max": to_jsonable(a.max())}
                if a.dtype.kind in "iub" and a.size <= 5_000_000:
                    vd["stats"]["nunique"] = int(np.unique(a).size)
            except Exception:
                pass
        out["vars"].append(vd)
    for sub in g.groups.values():
        out["groups"].append(describe_group(sub, stats))
    return out


def detect_mapping(ds):
    """Work out which variables hold coordinates, connectivity, groups, per-element and per-group data."""
    V = ds.variables
    m = {"coords": None, "xyz": None, "conn": None, "vertDim": None, "elemDim": None,
         "nodesPerElement": None, "startIndex": 0, "groupId": None, "groupDim": None,
         "groupNames": None, "elemVars": [], "groupVars": [], "warnings": []}

    for names in COORD_NAMES:
        found = [ci_lookup(V, [n]) for n in names]
        if all(found) and all(V[f].ndim == 1 for f in found):
            m["coords"] = found
            m["vertDim"] = V[found[0]].dimensions[0]
            break
    if not m["coords"]:
        n = ci_lookup(V, XYZ_NAMES)
        if n and V[n].ndim == 2 and V[n].shape[1] == 3:
            m["xyz"] = n
            m["vertDim"] = V[n].dimensions[0]
    if not m["vertDim"]:
        m["warnings"].append("Could not find vertex coordinates (x/y/z).")
        return m
    nverts = len(ds.dimensions[m["vertDim"]])

    def is_int(v):
        return v.dtype is not str and np.dtype(v.dtype).kind in "iu"

    cn = ci_lookup(V, CONN_NAMES)
    if not (cn and V[cn].ndim == 2 and is_int(V[cn]) and V[cn].shape[1] in (3, 4)):
        cn = None
        for name, v in V.items():
            if v.ndim == 2 and is_int(v) and v.shape[1] in (3, 4) and v.dimensions[0] != m["vertDim"]:
                cn = name
                break
    if not cn:
        m["warnings"].append("Could not find element connectivity (e.g. 'tri').")
        return m
    c = V[cn]
    m["conn"] = cn
    m["elemDim"] = c.dimensions[0]
    m["nodesPerElement"] = int(c.shape[1])
    if "start_index" in c.ncattrs():
        try:
            m["startIndex"] = int(str(to_jsonable(c.getncattr("start_index"))).strip())
        except ValueError:
            pass

    edim = m["elemDim"]
    gid = ci_lookup(V, GROUPID_NAMES)
    if gid and not (V[gid].ndim == 1 and V[gid].dimensions[0] == edim and is_int(V[gid])):
        gid = None
    m["groupId"] = gid

    gname = ci_lookup(V, GROUPNAME_NAMES)
    if gname and var_kind(V[gname]) in ("str", "char"):
        m["groupNames"] = gname
        m["groupDim"] = V[gname].dimensions[0]
    if gid and not m["groupDim"]:
        gmax = int(np.asarray(read_raw(V[gid])).max()) if V[gid].size else 0
        cands = [d for d, dim in ds.dimensions.items()
                 if d not in (edim, m["vertDim"]) and len(dim) >= gmax + 1
                 and any(v.ndim == 1 and v.dimensions[0] == d for v in V.values())]
        cands.sort(key=lambda d: (0 if "group" in d.lower() or "part" in d.lower() else 1, len(ds.dimensions[d])))
        if cands:
            m["groupDim"] = cands[0]

    skip = set(m["coords"] or []) | {m["xyz"], cn, gid, m["groupNames"]}
    for name, v in V.items():
        if name in skip or v.ndim != 1 or var_kind(v) != "num":
            continue
        if v.dimensions[0] == edim:
            m["elemVars"].append(name)
        elif m["groupDim"] and v.dimensions[0] == m["groupDim"]:
            m["groupVars"].append(name)
    return m


def load_labels(nc_path):
    """Optional value labels: labels.json next to the model and/or next to this script.
    Format: {"material": {"1344": "Bark", ...}, "bndCond": {"0": "Convective", ...}}"""
    labels = {}
    for d in (APP_DIR, os.path.dirname(os.path.abspath(nc_path))):
        p = os.path.join(d, "labels.json")
        if os.path.isfile(p):
            try:
                with open(p, "r", encoding="utf-8") as fh:
                    for var, mp in json.load(fh).items():
                        labels.setdefault(var, {}).update({str(k): str(v) for k, v in mp.items()})
            except Exception as e:  # noqa: BLE001
                print(f"warning: could not read {p}: {e}", file=sys.stderr)
    return labels


# --------------------------------------------------------------------------- saving
def _cast_attr(value, dtype):
    """Cast an edited attribute back to its original type ('1, 2, 3' -> array for numeric attrs)."""
    if dtype in ("str", "bytes", None):
        return str(value)
    dt = np.dtype(dtype)
    if isinstance(value, str):
        value = [float(p) for p in value.replace(",", " ").split()]
    arr = np.atleast_1d(np.asarray(value, dtype=np.float64 if dt.kind == "f" else None))
    if dt.kind in "iu":
        arr = np.rint(arr.astype(np.float64))
    arr = arr.astype(dt)
    return arr[0] if arr.size == 1 else arr


def _copy_types(src, dst, typemap):
    for name, t in src.cmptypes.items():
        typemap[("cmp", src.path, name)] = dst.createCompoundType(t.dtype, name)
    for name, t in src.vltypes.items():
        if t.dtype is not str:
            typemap[("vl", src.path, name)] = dst.createVLType(t.dtype, name)
    for name, t in src.enumtypes.items():
        typemap[("enum", src.path, name)] = dst.createEnumType(t.dtype, name, t.enum_dict)


def _resolve_type(var, typemap):
    dt = var.datatype
    if var.dtype is str:
        return str
    for kind, cls in (("cmp", netCDF4.CompoundType), ("vl", netCDF4.VLType), ("enum", netCDF4.EnumType)):
        if isinstance(dt, cls):
            for (k, _, name), t in typemap.items():
                if k == kind and name == dt.name:
                    return t
            raise ValueError(f"user type {dt.name} not found")
    return var.dtype


NC_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_.@+\-]*$")


def copy_dataset(src_path, dst_path, var_overrides, attr_edits, new_vars=None, deleted=(), renames=None):
    """Write a full copy of src to dst with edited variable data and attributes.

    var_overrides: {var_path: np.ndarray | list[str]}
    attr_edits:   {obj_path: {attr_name: (value, dtype) | None}}   (obj_path '/' = global, or a var path)
    new_vars:     {"/id": {"name": str, "dims": [dim], "dtype": numpy dtype str, "data": np.ndarray}}
                  (root group only; their attributes come from attr_edits["/id"])
    deleted:      root variable paths to drop
    renames:      {"/old": "new"} root variables to rename
    Variable paths always refer to the *source* name (or the new-variable id); renames are applied on write.
    """
    new_vars = new_vars or {}
    renames = renames or {}
    deleted = set(deleted)
    with netCDF4.Dataset(src_path, "r") as src:
        fmt = src.data_model

        # ---- validate structural edits (root group)
        for p in list(deleted) + list(renames):
            if p.strip("/") not in src.variables:
                raise ValueError(f"no variable {p} to delete/rename")
        final = [renames.get("/" + n, n) for n in src.variables if "/" + n not in deleted]
        for vid, spec in new_vars.items():
            if not NC_NAME_RE.match(spec["name"]):
                raise ValueError(f"invalid variable name {spec['name']!r}")
            for d in spec["dims"]:
                if d not in src.dimensions:
                    raise ValueError(f"unknown dimension {d} for new variable {spec['name']}")
            final.append(spec["name"])
        for n in renames.values():
            if not NC_NAME_RE.match(n):
                raise ValueError(f"invalid variable name {n!r}")
        dupes = {n for n in final if final.count(n) > 1}
        if dupes:
            raise ValueError(f"duplicate variable name(s): {', '.join(sorted(dupes))}")

        # Determine resized dimensions from overrides of 1-D variables.
        new_sizes = {}
        for vpath, data in var_overrides.items():
            if vpath in deleted:
                continue
            v = find_var(src, vpath)
            n = len(data)
            dpath = (v.group().path.rstrip("/") + "/" + v.dimensions[0])
            if n != v.shape[0]:
                if v.ndim != 1:
                    raise ValueError(f"cannot resize multi-dimensional variable {vpath}")
                prev = new_sizes.get(dpath)
                if prev is not None and prev != n:
                    raise ValueError(f"inconsistent new sizes for dimension {v.dimensions[0]}")
                new_sizes[dpath] = n
        if new_sizes:
            # Every variable that uses a resized dimension must be supplied.
            def check(g):
                for name, v in g.variables.items():
                    p = g.path.rstrip("/") + "/" + name
                    if p in deleted:
                        continue
                    for d in v.dimensions:
                        dp = _dim_owner_path(v, d)
                        if dp in new_sizes and p not in var_overrides:
                            raise ValueError(f"variable {p} uses resized dimension {d} but was not supplied")
                for sub in g.groups.values():
                    check(sub)
            check(src)

        # New variables must match their (possibly resized) dimensions.
        for vid, spec in new_vars.items():
            want = [new_sizes.get("/" + d, len(src.dimensions[d])) for d in spec["dims"]]
            if int(np.prod(want)) != spec["data"].size:
                raise ValueError(f"new variable {spec['name']}: {spec['data'].size} values for shape {want}")

        struct = {"new": new_vars, "deleted": deleted, "renames": renames}
        with netCDF4.Dataset(dst_path, "w", format=fmt) as dst:
            typemap = {}
            _copy_group(src, dst, var_overrides, attr_edits, new_sizes, typemap, fmt, struct)


def _dim_owner_path(var, dname):
    g = var.group()
    while g is not None:
        if dname in g.dimensions:
            return g.path.rstrip("/") + "/" + dname
        g = g.parent
    return "/" + dname


def _apply_attrs(obj, src_attrs, edits, skip=("_FillValue",)):
    attrs = {k: src_attrs[k] for k in src_attrs if k not in skip}
    for name, ed in (edits or {}).items():
        if ed is None:
            attrs.pop(name, None)
        else:
            value, dtype = ed
            attrs[name] = _cast_attr(value, dtype)
    for k, v in attrs.items():
        obj.setncattr(k, v)


def _copy_group(src, dst, overrides, attr_edits, new_sizes, typemap, fmt, struct=None):
    struct = struct if (struct and src.path == "/") else {"new": {}, "deleted": set(), "renames": {}}
    is4 = fmt.startswith("NETCDF4") and fmt != "NETCDF4_CLASSIC"
    if is4:
        _copy_types(src, dst, typemap)
    gpath = src.path
    _apply_attrs(dst, {k: src.getncattr(k) for k in src.ncattrs()}, attr_edits.get(gpath), skip=())
    for name, d in src.dimensions.items():
        dp = gpath.rstrip("/") + "/" + name
        dst.createDimension(name, None if d.isunlimited() else new_sizes.get(dp, len(d)))

    for name, v in src.variables.items():
        vpath = gpath.rstrip("/") + "/" + name
        if vpath in struct["deleted"]:
            continue
        out_name = struct["renames"].get(vpath, name)
        kw = {}
        if "_FillValue" in v.ncattrs():
            kw["fill_value"] = v.getncattr("_FillValue")
        else:
            kw["fill_value"] = False
        try:
            f = v.filters() or {}
            if f.get("zlib"):
                kw.update(zlib=True, complevel=f.get("complevel", 4))
            kw["shuffle"] = bool(f.get("shuffle"))  # netCDF4 defaults this to True
            if f.get("fletcher32"):
                kw["fletcher32"] = True
            ch = v.chunking()
            if ch == "contiguous":
                kw["contiguous"] = True if not kw.get("zlib") else False
            elif ch:
                sizes = []
                for dname, c in zip(v.dimensions, ch):
                    dlen = len(dst.dimensions[dname]) if dname in dst.dimensions else c
                    sizes.append(max(1, min(c, dlen)) if dlen else c)
                kw["chunksizes"] = sizes
            if v.endian() != "native":
                kw["endian"] = v.endian()
        except Exception:
            pass
        if v.dtype is str:
            kw.pop("fill_value", None)
            kw.pop("contiguous", None)
        nv = dst.createVariable(out_name, _resolve_type(v, typemap), v.dimensions, **kw)
        _apply_attrs(nv, {k: v.getncattr(k) for k in v.ncattrs()}, attr_edits.get(vpath))
        nv.set_auto_maskandscale(False)

        if vpath in overrides:
            data = overrides[vpath]
            if v.dtype is str:
                nv[:] = np.array(list(data), dtype=object)
            elif var_kind(v) == "char":
                strlen = v.shape[-1]
                fixed = np.array([s.encode("utf-8")[:strlen] for s in data], dtype=f"S{strlen}")
                nv[:] = netCDF4.stringtochar(fixed)
            else:
                nv[:] = np.asarray(data).astype(v.dtype, copy=False)
        elif v.size:
            data = read_raw(v)
            if v.dtype is str:
                flat = np.asarray(data, dtype=object)
                nv[...] = flat
            else:
                nv[...] = data

    for vid, spec in struct["new"].items():
        dt = np.dtype(spec["dtype"])
        kw = {"fill_value": False}
        if is4:
            kw.update(zlib=True, complevel=1, shuffle=False)  # matches how the pipeline writes per-element data
        nv = dst.createVariable(spec["name"], dt, tuple(spec["dims"]), **kw)
        _apply_attrs(nv, {}, attr_edits.get(vid))
        nv.set_auto_maskandscale(False)
        nv[...] = spec["data"].astype(dt, copy=False).reshape(nv.shape)

    for gname, sub in src.groups.items():
        _copy_group(sub, dst.createGroup(gname), overrides, attr_edits, new_sizes, typemap, fmt)


# --------------------------------------------------------------------------- HTTP
class State:
    path: str | None = None
    # The HDF5/netCDF C library is not thread-safe: every API request that touches a
    # file is serialized through this lock (static files are still served concurrently).
    lock = threading.RLock()


def decode_var_payload(item):
    if "strings" in item:
        return [str(s) for s in item["strings"]]
    raw = base64.b64decode(item["b64"])
    return np.frombuffer(raw, dtype=np.dtype(item["dtype"])).copy()


class Handler(BaseHTTPRequestHandler):
    server_version = "DiscreteViewer/1.0"

    def log_message(self, fmt, *args):  # quieter console
        if not self.path.startswith("/api/var"):
            sys.stderr.write("%s - %s\n" % (self.log_date_time_string(), fmt % args))

    # ---- responses
    def _send(self, code, body: bytes, ctype="application/json", headers=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj).encode("utf-8"))

    def _error(self, msg, code=400):
        self._json({"error": msg}, code)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    # ---- routing
    def do_GET(self):
        u = urlparse(self.path)
        if not u.path.startswith("/api/"):
            return self._static(u.path)
        with State.lock:
            return self._do_get_api(u)

    def _do_get_api(self, u):
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        try:
            if u.path == "/api/state":
                return self._json({"path": State.path, "cwd": os.getcwd()})
            if u.path == "/api/files":
                return self._files(q.get("dir"))
            if u.path == "/api/schema":
                return self._schema()
            if u.path == "/api/var":
                return self._var(q["name"])
            if u.path == "/api/preview":
                return self._preview(q["name"], int(q.get("start", 0)), int(q.get("count", 200)))
            if u.path == "/api/geometry":
                return self._geometry(q.get("part", "positions"))
            return self._error("not found", 404)
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            return self._error(f"{type(e).__name__}: {e}", 500)

    def do_POST(self):
        with State.lock:
            return self._do_post()

    def _do_post(self):
        u = urlparse(self.path)
        try:
            body = self._body()
            if u.path == "/api/open":
                return self._open(body["path"])
            if u.path == "/api/save":
                return self._save(body)
            return self._error("not found", 404)
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            return self._error(f"{type(e).__name__}: {e}", 500)

    # ---- static files
    def _static(self, path):
        path = unquote(path)
        if path in ("", "/"):
            path = "/index.html"
        full = os.path.normpath(os.path.join(STATIC_DIR, path.lstrip("/")))
        if not full.startswith(STATIC_DIR) or not os.path.isfile(full):
            return self._error("not found", 404)
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if full.endswith(".js"):
            ctype = "text/javascript"
        with open(full, "rb") as fh:
            self._send(200, fh.read(), ctype)

    # ---- API
    def _require(self):
        if not State.path:
            raise RuntimeError("no file open")
        return State.path

    def _files(self, d):
        d = os.path.abspath(d or (os.path.dirname(State.path) if State.path else os.getcwd()))
        if not os.path.isdir(d):
            return self._error(f"not a directory: {d}")
        entries = []
        for name in sorted(os.listdir(d), key=str.lower):
            p = os.path.join(d, name)
            if os.path.isdir(p) and not name.startswith("."):
                entries.append({"name": name, "path": p, "dir": True})
            elif name.lower().endswith((".nc", ".nc4", ".netcdf", ".cdf")):
                entries.append({"name": name, "path": p, "dir": False, "size": os.path.getsize(p)})
        self._json({"dir": d, "parent": os.path.dirname(d), "entries": entries})

    def _open(self, path):
        path = os.path.abspath(os.path.expanduser(path))
        if not os.path.isfile(path):
            return self._error(f"file not found: {path}")
        with netCDF4.Dataset(path, "r"):
            pass
        State.path = path
        return self._schema()

    def _schema(self):
        path = self._require()
        with netCDF4.Dataset(path, "r") as ds:
            schema = describe_group(ds)
            mapping = detect_mapping(ds)
            fmt = ds.data_model
        self._json({"path": path, "format": fmt, "size": os.path.getsize(path),
                    "schema": schema, "mapping": mapping, "labels": load_labels(path)})

    def _var(self, name):
        path = self._require()
        with netCDF4.Dataset(path, "r") as ds:
            v = find_var(ds, name)
            k = var_kind(v)
            if k in ("str", "char"):
                return self._json({"strings": read_strings(v)})
            if k != "num":
                return self._error(f"variable {name} of kind {k} cannot be transferred")
            a = np.ascontiguousarray(np.asarray(read_raw(v)))
            wd = wire_dtype(a.dtype)
            out = a.astype(wd, copy=False)
            self._send(200, out.tobytes(), "application/octet-stream",
                       {"X-Dtype": wd.str, "X-Orig-Dtype": np.dtype(v.dtype).str,
                        "X-Shape": json.dumps(list(a.shape))})

    def _preview(self, name, start, count):
        path = self._require()
        with netCDF4.Dataset(path, "r") as ds:
            v = find_var(ds, name)
            v.set_auto_maskandscale(False)
            n = v.shape[0] if v.ndim else 1
            stop = min(n, start + count)
            if v.ndim == 0:
                vals = v[...]
            elif var_kind(v) == "char" and v.ndim >= 2:
                vals = netCDF4.chartostring(np.asarray(v[start:stop]))
            else:
                vals = v[start:stop]
            self._json({"start": start, "stop": stop, "total": n, "values": to_jsonable(np.asarray(vals, dtype=object) if v.dtype is str else np.asarray(vals))})

    def _geometry(self, part):
        """positions: float32 [N*3];  elements: uint32 [E*k], zero-based."""
        path = self._require()
        with netCDF4.Dataset(path, "r") as ds:
            m = detect_mapping(ds)
            if part == "positions":
                if m["coords"]:
                    pts = np.stack([np.asarray(read_raw(ds[c]), dtype=np.float32) for c in m["coords"]], axis=1)
                else:
                    pts = np.asarray(read_raw(ds[m["xyz"]]), dtype=np.float32)
                return self._send(200, np.ascontiguousarray(pts, dtype="<f4").tobytes(),
                                  "application/octet-stream", {"X-Shape": json.dumps(list(pts.shape))})
            conn = np.asarray(read_raw(ds[m["conn"]])).astype(np.int64) - m["startIndex"]
            conn[conn < 0] = 0xFFFFFFFF  # invalid / padding node marker
            return self._send(200, np.ascontiguousarray(conn, dtype="<u4").tobytes(),
                              "application/octet-stream", {"X-Shape": json.dumps(list(conn.shape))})

    def _save(self, body):
        src = self._require()
        target = os.path.abspath(os.path.expanduser(body.get("path") or src))
        overwrite = bool(body.get("overwrite"))
        backup = bool(body.get("backup", True))
        if os.path.exists(target) and not overwrite:
            return self._json({"error": f"{target} exists", "exists": True}, 409)
        overrides = {k: decode_var_payload(v) for k, v in (body.get("vars") or {}).items()}
        attr_edits = {}
        for obj, edits in (body.get("attrs") or {}).items():
            attr_edits[obj] = {n: (None if e is None else (e["value"], e.get("dtype"))) for n, e in edits.items()}
        new_vars = {}
        for vid, spec in (body.get("newVars") or {}).items():
            new_vars[vid] = {"name": spec["name"], "dims": list(spec["dims"]), "dtype": spec["dtype"],
                             "data": decode_var_payload(spec)}
        deleted = list(body.get("deleted") or [])
        renames = dict(body.get("renames") or {})

        d = os.path.dirname(target)
        fd, tmp = tempfile.mkstemp(suffix=".nc.tmp", dir=d)
        os.close(fd)
        try:
            copy_dataset(src, tmp, overrides, attr_edits, new_vars, deleted, renames)
            # sanity check: re-open the result
            with netCDF4.Dataset(tmp, "r"):
                pass
            # mkstemp creates 0600 files; give the result the replaced file's permissions, or the
            # normal umask-based ones, so other users / the solver account can still read it.
            if os.name == "posix":
                if os.path.exists(target):
                    os.chmod(tmp, os.stat(target).st_mode & 0o7777)
                else:
                    um = os.umask(0)
                    os.umask(um)
                    os.chmod(tmp, 0o666 & ~um)
            bak = None
            if os.path.exists(target) and backup:
                bak = target + ".bak"
                shutil.copy2(target, bak)
            os.replace(tmp, target)
        except Exception:
            if os.path.exists(tmp):
                os.remove(tmp)
            raise
        State.path = target
        self._json({"ok": True, "path": target, "backup": bak, "size": os.path.getsize(target)})


class Server(ThreadingHTTPServer):
    # On Windows SO_REUSEADDR lets a second process bind a port that is already in use, so two
    # viewers could silently share 8765. Bind exclusively there and fall through to the next port.
    allow_reuse_address = sys.platform != "win32"
    daemon_threads = True


def main():
    ap = argparse.ArgumentParser(description="Discrete model netCDF viewer / editor")
    ap.add_argument("file", nargs="?", help="netCDF model to open")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()
    if args.file:
        p = os.path.abspath(args.file)
        if not os.path.isfile(p):
            sys.exit(f"file not found: {p}")
        State.path = p

    srv = None
    for port in range(args.port, args.port + 20):
        try:
            srv = Server(("127.0.0.1", port), Handler)
            break
        except OSError:
            continue
    if srv is None:
        sys.exit("could not bind a local port")
    url = f"http://127.0.0.1:{srv.server_address[1]}/"
    print(f"Discrete Viewer running at {url}  (Ctrl+C to stop)")
    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
