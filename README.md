# Discrete Viewer

A local viewer and editor for the netCDF discrete-geometry models (vegetation, vehicles, …) used by the
thermal solver and rendering pipeline. It lets you view a model in 3D, inspect the full schema, and
reassign boundary conditions, materials, thicknesses, groups and attributes. Edits are saved back to netCDF.

## Running

```
pip install -r requirements.txt
python discrete_viewer.py YellowPoplar_w6.98m_h14.28m.nc      # python3 on Linux
```

On Windows you can also drag a `.nc` file onto `discrete_viewer.bat`.

### Linux

```
python3 -m venv ~/.venvs/discrete-viewer        # or use a conda env
~/.venvs/discrete-viewer/bin/pip install -r requirements.txt
~/.venvs/discrete-viewer/bin/python discrete_viewer.py model.nc
```

`./discrete_viewer.sh model.nc` also works. It runs `python3` from your PATH, so activate the
environment first; run `chmod +x discrete_viewer.sh` once if it isn't executable.
Tested on Ubuntu 24.04 with Python 3.12, using the pip `netCDF4` wheel, which bundles its own
HDF5. No system packages are needed.

- **Running on a remote / headless machine:** the server only listens on `127.0.0.1`, so tunnel
  the port over SSH and open the page in your local browser. Use `--no-browser` on the remote
  machine:
  ```
  ssh -L 8765:127.0.0.1:8765 user@workstation
  python3 discrete_viewer.py model.nc --no-browser
  # then browse to http://127.0.0.1:8765/ locally
  ```
- **Network filesystems (NFS, Lustre, GPFS):** if opening a file fails with an HDF5 "unable to
  lock file" error, run with `HDF5_USE_FILE_LOCKING=FALSE python3 discrete_viewer.py …`.
- **Permissions:** saving keeps the replaced file's permission bits. New files get your normal
  umask permissions, so other accounts (e.g. the solver's) can read them. You need write access
  to the destination directory, because the file is written there first as a temp file.
- **Browser:** any current Firefox or Chrome/Chromium works. It needs WebGL; over X forwarding
  or VNC, use the SSH tunnel and a local browser instead.

The command starts a small server on `127.0.0.1` (local only) and opens the UI in your browser.
Options: `--port N` and `--no-browser`. three.js is vendored in `static/vendor`, so no internet is needed.

## What it understands

The layout is detected from the file, not hard-coded:

| Role | Detected from (example file) |
|---|---|
| vertices | `x`, `y`, `z` on the vertex dimension (or a single `(n,3)` `xyz`/`vertices` variable) |
| elements | integer `(nElem, 3 or 4)` connectivity, e.g. `tri`. Honours `start_index`. Quads are split for display. |
| element → group | `groupId` (also `group`, `partId`, `region`, …) |
| group names | `groupNames` (vlen string or char array) |
| per-element properties | every other 1-D numeric variable on the element dimension (`thickness`, `bndCond`, …) |
| per-group properties | every 1-D numeric variable on the group dimension (`material`, `articulate`, …) |

So when a file adds a new per-element or per-group variable, it shows up automatically as an editable
property and a colour-by option. Anything else, such as subgroups or multi-dimensional variables, appears in the
Schema tab, where it can be inspected and its attributes edited.

## Using it

**Viewport.** Left-drag rotates, right-drag pans, and the wheel zooms. Hovering shows the element under
the cursor.

**Selecting.**
- Click picks an element. Shift-click adds and Ctrl-click removes.
- *Pick* mode (toolbar, or keys `1`/`2`/`3`) picks a single element, a **connected part** (such as one
  leaf) or a **whole group**.
- **Box** (`B`) selects with a rectangle. With *visible only* ticked it takes only what you can see;
  unticked, it selects through the model.
- Clicking a row in the Groups table, or an entry in the legend, selects by group or by value.
- `L` grows the selection to everything connected to it. `A` selects all, `Esc` clears and Ctrl+I inverts.

**Editing.**
- **Groups tab:** rename groups and edit per-group values (material, articulate) in place.
  Per-element columns (*italic*) show the group's value, or its range when it is mixed. Typing a
  value applies it to every element in the group.
- **Selection tab:** assign any per-element value (bndCond, thickness, …) to the current selection.
  You can also move the selection into an existing group or into a **new group**, which grows the
  group dimension and copies per-group properties from a template group.
- **Schema tab:** browse dimensions, variables (dtype, shape, compression, value range, preview) and
  attributes. You can edit, add or delete global and variable attributes, and rename or delete
  property variables. Coordinates, connectivity, `groupId` and `groupNames` are protected from
  rename and delete.
- **New variables:** use **＋ New property** (Groups tab) or **＋ variable** (Schema tab). You choose:
  - the name,
  - per group or per element,
  - the data type,
  - initial values: a constant, or a copy of an existing variable,
  - an optional description (stored as `long_name`),
  - the value that means *unassigned* (stored as the attribute `unassigned_value`; default 0).

  The new variable appears immediately as a Groups table column and a colour-by option.
- Every edit can be undone with Ctrl+Z and redone with Ctrl+Y.

### Unassigned values

When a variable has an `unassigned_value` attribute, groups or elements still holding that value
are flagged:
- the Groups column header shows a count (e.g. `17 unassigned`),
- the cells are dimmed,
- they are drawn grey when colouring by that variable,
- legend and hover show `(unassigned)`,
- Save warns how many are left.

Example: per-group surface materials for the renderer, alongside the thermal `material`:

1. ＋ New property → name `surfaceMaterial`, per group, uint16, constant 0, unassigned = 0.
2. Colour by `surfaceMaterial` and type IDs into the column until the unassigned count reaches zero.
3. Save. The file gains `surfaceMaterial(nGroups)` with `long_name` and `unassigned_value`
   attributes. Every other variable is unchanged.
**Visibility.** `H` hides the selection, `I` isolates it and `Alt+H` shows everything. Each group row
also has an eye toggle. `F` frames the selection, `W` toggles the wireframe, and there are preset
views and a PNG screenshot button.

**Saving.**
- **Save As** writes a new file.
- **Save** overwrites the current file. By default it first keeps a `.bak` copy of the file being
  replaced.
- The file is always rewritten as a full copy through the netCDF4 library. Untouched variables,
  attributes, dtypes, fill values, chunking and compression are reproduced as they were.
- The copy is written to a temporary file, checked, and then moved into place, so a failed save
  never corrupts the original.

## Optional value labels

To show names next to codes (for example, material IDs), put a `labels.json` next to the model or
next to `discrete_viewer.py`:

```json
{
  "material":        { "1344": "Bark", "1176": "Leaf", "1105": "Twig" },
  "surfaceMaterial": { "12": "Poplar leaf (render)" },
  "bndCond":         { "0": "Default", "2": "Fixed temperature" }
}
```

Labels appear in the legend, hover info and tooltips, and you can type a label in place of a number
when assigning values. The values above are placeholders; use your solver's actual codes.

## Files

- `discrete_viewer.py`: HTTP server, layout detection, netCDF read/write (Python + netCDF4 + numpy)
- `static/app.js`: UI state, editing and undo, panels, save
- `static/viewer.js`: three.js viewport, GPU ID-buffer picking, box selection
- `static/colors.js`: palettes
