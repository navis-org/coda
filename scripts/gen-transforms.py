#!/usr/bin/env python3
"""Generate Coda's landmark transform files from navis + flybrains.

Coda cannot run CMTK, Elastix or the Saalfeld H5 registrations — those are
native libraries and multi-gigabyte files. What it *can* run is a thin-plate
spline, because navis-fastcore's `TpsTransform` is in the wheel Pyodide already
loads for NBLAST. So every transform Coda offers is a landmark set, and this
script is where those landmark sets come from: it drives the full navis
transform stack once, on a machine that has it, and writes down the answer.

Two kinds are produced:

  <SPACE>_mirror.csv     x_flip,y_flip,z_flip -> x_mirr,y_mirr,z_mirr
                         Copied from navis-flybrains, which already registers a
                         direct mirror landmark set for each of these spaces.
                         The *source* side is already affine-flipped, so Coda
                         does the flip itself and the spline only corrects the
                         left/right asymmetry.

  <SPACE>_JRC2018U.csv   x,y,z -> jrc2018u_x,jrc2018u_y,jrc2018u_z
                         Generated here, by sampling inside the space's own
                         shell mesh and pushing every sample through the long
                         route. One direct edge per dataset to the common
                         template; no bridging graph in the browser.

Plus `manifest.json`, which carries the numbers Coda would otherwise hard-code:
the flip constant per space, the landmark counts, and the units each column is
in. **Nothing about a transform is typed by hand on the TypeScript side** — a
mirror whose flip constant disagrees with the one the landmarks were built
against is wrong in a way that looks plausible.

Usage
-----
    python3 scripts/gen-transforms.py
    python3 scripts/gen-transforms.py --only JRCFIB2018F --res 40000

Writes the CSVs to `public/transforms/` (served, fetched lazily) and the manifest to
`src/data/transforms/manifest.json` (imported statically, because edit-time code has to
know what exists and may not fetch).

Requires navis, flybrains, and the Saalfeld H5 registrations
(`flybrains.download_jrc_transforms()`); check with `flybrains.report()`.
The mirror half needs only flybrains.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

# --------------------------------------------------------------------------
# What to generate
# --------------------------------------------------------------------------

# JRC2018U is a *brain* template: it has no nerve cord in it. The VNC is placed
# beside it by a hand-fitted affine rather than registered, which is what makes
# a whole-CNS dataset drawable in one frame. Lifted verbatim from
# navis-flybrains' `maleCNS_JRC2018U_landmarks.ipynb` so the two agree; changing
# it here moves every VNC dataset relative to every brain one.
JRCVNC2018U_TO_JRC2018U = np.array(
    [
        [1.0, 0.0, 0.0, 181.8800000000192],
        [0.0, -0.15529250097017266, -0.9878685333293872, 412.1948791269284],
        [0.0, 0.9878685333293872, -0.15529250097017266, 269.643813347511],
        [0.0, 0.0, 0.0, 1.0],
    ]
)

#: Where the placed-VNC space is registered. Not a real template; a waypoint.
VNC_IN_BRAIN_FRAME = "JRC2018Uvnc"


@dataclass
class Space:
    """One coordinate space Coda has datasets in."""

    #: flybrains template name. Also Coda's space id.
    id: str
    #: What a reader calls it.
    label: str
    #: Which axis a mirror flips about.
    mirror_axis: str = "x"
    #: Mirror landmark file in navis-flybrains' data directory, if one exists.
    mirror_file: str | None = None
    #: Column names in that file: source triple then target triple.
    mirror_columns: tuple[str, ...] = (
        "x_flip",
        "y_flip",
        "z_flip",
        "x_mirr",
        "y_mirr",
        "z_mirr",
    )
    #: Sample spacing in nanometres for the JRC2018U landmark set.
    res: int = 20_000
    #: How far outside the shell a sample may sit, in nanometres. Points a
    #: little outside are what keep a neuron's most peripheral arbor inside the
    #: landmark hull, where the spline interpolates rather than extrapolates.
    pad: int = 10_000
    #: Which shell(s) to sample, and where each goes. `brain` targets JRC2018U
    #: directly; `vnc` goes via JRCVNC2018U and the affine above.
    regions: tuple[str, ...] = ("brain",)
    #: Skip the JRC2018U half (no route, or not wanted).
    to_common: bool = True
    notes: list[str] = field(default_factory=list)


SPACES: list[Space] = [
    Space(
        id="JRCFIB2018F",
        label="Hemibrain",
        mirror_file="JRCFIB2018F_mirror_landmarks.csv",
        res=20_000,
    ),
    Space(
        id="JRCFIB2022M",
        label="MaleCNS",
        mirror_file="maleCNS_mirror_landmarks_nm.csv",
        # Whole central nervous system: both shells, and they go to the common
        # frame by different routes.
        regions=("brain", "vnc"),
        res=30_000,
    ),
    Space(
        id="FLYWIRE",
        label="FlyWire (FAFB v14.1)",
        mirror_file="FLYWIRE_mirror_landmarks.csv",
        res=20_000,
    ),
    Space(
        id="FAFB14",
        label="FAFB v14",
        mirror_file="FAFB14_mirror_landmarks.csv",
        res=20_000,
    ),
    Space(
        id="MANC",
        label="MANC",
        mirror_file="MANC_mirror_landmarks.csv",
        regions=("vnc",),
        res=20_000,
    ),
]


# --------------------------------------------------------------------------
# Sampling
# --------------------------------------------------------------------------


def shells(space: Space, flybrains):
    """The mesh(es) to sample inside, keyed by region.

    A template that spans the whole CNS publishes its two shells separately
    (`mesh_brain` / `mesh_vnc`); everything else has one `mesh` and the region
    it belongs to is declared rather than discovered.
    """
    tb = getattr(flybrains, space.id)
    if space.regions == ("brain",):
        return {"brain": tb.mesh}
    if space.regions == ("vnc",):
        return {"vnc": tb.mesh}
    return {"brain": tb.mesh_brain, "vnc": tb.mesh_vnc}


def sample_inside(mesh, res: int, pad: int, navis) -> np.ndarray:
    """An even grid over the mesh's bounding box, keeping what is inside it.

    A grid rather than the bounding box corners because a thin-plate spline is
    only trustworthy inside the hull of its landmarks — outside it degenerates
    to the affine part, silently. Padding the box and keeping points a little
    beyond the surface is what stops a neuron's outermost branch falling off
    that edge.
    """
    verts = np.asarray(mesh.vertices)
    lo = verts.min(axis=0).astype(int) - pad
    hi = verts.max(axis=0).astype(int) + pad
    grid = (
        np.mgrid[lo[0] : hi[0] : res, lo[1] : hi[1] : res, lo[2] : hi[2] : res]
        .reshape(3, -1)
        .T
    ).astype(float)
    return grid[np.asarray(navis.in_volume(grid, mesh), dtype=bool)]


# --------------------------------------------------------------------------
# The long route, run once
# --------------------------------------------------------------------------


def to_common(points: np.ndarray, space_id: str, region: str, navis) -> np.ndarray:
    """Push samples into the common frame, in micrometres.

    The brain route is whatever navis' registry finds. The nerve cord goes to
    `JRCVNC2018U` — the unisex VNC template, which is the honest target for a
    nerve cord — and is then *placed* into the brain's frame by the affine
    above. That second step is a layout, not a registration, and it is the only
    reason a VNC and a brain can be drawn in one scene.
    """
    if region == "brain":
        return navis.xform_brain(points, source=space_id, target="JRC2018U")
    xf = navis.xform_brain(points, source=space_id, target="JRCVNC2018U")
    return navis.xform_brain(xf, source="JRCVNC2018U", target=VNC_IN_BRAIN_FRAME)


def register_vnc_placement(navis) -> None:
    tr = navis.transforms.AffineTransform(JRCVNC2018U_TO_JRC2018U)
    navis.transforms.registry.register_transform(
        tr,
        source="JRCVNC2018U",
        target=VNC_IN_BRAIN_FRAME,
        transform_type="bridging",
    )


# --------------------------------------------------------------------------
# Flip constants
# --------------------------------------------------------------------------

AXIS_INDEX = {"x": 0, "y": 1, "z": 2}


def flip_constant(space_id: str, axis: str, flybrains) -> float:
    """`c` in `x' = c - x`, read off the same bounding box navis uses.

    navis calls this `mirror_axis_size` and derives it as `min + max` of the
    template's bounding box along the mirror axis — which is twice the midline,
    not the extent, whatever the name suggests. It is **not** a free parameter:
    the mirror landmark files were built against exactly this number, so a
    different one hands the spline a pre-image it was never fitted for. Read
    rather than typed for that reason.
    """
    tb = getattr(flybrains, space_id)
    bbox = np.asarray(tb.boundingbox)
    bbox = bbox.reshape(3, 2) if bbox.ndim == 1 else bbox
    if bbox.shape == (2, 3):
        bbox = bbox.T
    return float(bbox[AXIS_INDEX[axis], :].sum())


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out",
        default="public/transforms",
        type=Path,
        help="Where the CSVs go. Served, fetched lazily, never in the bundle.",
    )
    parser.add_argument(
        "--manifest",
        default="src/data/transforms/manifest.json",
        type=Path,
        help=(
            "Where the manifest goes — under src/, not beside the CSVs, and imported "
            "statically. `inferOutputs` and `validate` need to know whether a space has a "
            "mirror, and neither may fetch (invariant 2). One copy: a second one under "
            "public/ would be the same fact in two places, and the one nothing imports is "
            "the one that goes stale."
        ),
    )
    parser.add_argument("--only", action="append", help="Space id; repeatable.")
    parser.add_argument("--res", type=int, help="Override sample spacing (nm).")
    parser.add_argument(
        "--skip-common",
        action="store_true",
        help="Copy the mirror files only. Needs no H5 registrations.",
    )
    args = parser.parse_args()

    try:
        import navis
        import flybrains
    except ImportError as exc:  # pragma: no cover - operator feedback
        print(f"needs navis and flybrains: {exc}", file=sys.stderr)
        print("  pip install navis flybrains", file=sys.stderr)
        return 1

    data_dir = Path(flybrains.__file__).parent / "data"
    out: Path = args.out
    out.mkdir(parents=True, exist_ok=True)

    if not args.skip_common:
        register_vnc_placement(navis)

    wanted = [s for s in SPACES if not args.only or s.id in args.only]
    manifest: dict = {
        "comment": (
            "Generated by scripts/gen-transforms.py. Do not edit by hand; every number "
            "here is read off navis/flybrains rather than typed, so a regeneration is "
            "the only way to change one."
        ),
        "commonSpace": {
            "id": "JRC2018U",
            "label": "JRC2018 unisex",
            "units": "um",
            "note": (
                "A brain template. Nerve cords are registered to JRCVNC2018U and then "
                "placed into this frame by a fixed affine, which is a layout rather "
                "than a registration."
            ),
        },
        "spaces": [],
    }

    for space in wanted:
        entry: dict = {
            "id": space.id,
            "label": space.label,
            "units": "nm",
            "mirror": None,
            "toCommon": None,
        }

        # --- mirror: copy what flybrains already ships -----------------------
        if space.mirror_file:
            src = data_dir / space.mirror_file
            if not src.exists():
                print(f"  ! {space.id}: no {space.mirror_file}", file=sys.stderr)
            else:
                dest = out / f"{space.id}_mirror.csv"
                shutil.copyfile(src, dest)
                rows = sum(1 for _ in dest.open()) - 1
                entry["mirror"] = {
                    "file": dest.name,
                    "landmarks": rows,
                    "axis": space.mirror_axis,
                    "flipAt": flip_constant(space.id, space.mirror_axis, flybrains),
                    "sourceColumns": list(space.mirror_columns[:3]),
                    "targetColumns": list(space.mirror_columns[3:]),
                    "sourceUnits": "nm",
                    "targetUnits": "nm",
                    "origin": f"navis-flybrains/{space.mirror_file}",
                }
                print(f"  {space.id} mirror: {rows} landmarks -> {dest.name}")

        # --- to the common frame: generate ----------------------------------
        if space.to_common and not args.skip_common:
            res = args.res or space.res
            pieces_src, pieces_tgt, per_region = [], [], {}
            for region, mesh in shells(space, flybrains).items():
                t0 = time.perf_counter()
                pts = sample_inside(mesh, res, space.pad, navis)
                xf = to_common(pts, space.id, region, navis)
                pieces_src.append(pts)
                pieces_tgt.append(np.asarray(xf))
                per_region[region] = len(pts)
                print(
                    f"  {space.id} -> JRC2018U [{region}]: {len(pts)} landmarks "
                    f"in {time.perf_counter() - t0:.1f}s"
                )

            source = np.vstack(pieces_src)
            target = np.vstack(pieces_tgt)
            dest = out / f"{space.id}_JRC2018U.csv"
            header = "x,y,z,jrc2018u_x,jrc2018u_y,jrc2018u_z"
            np.savetxt(
                dest,
                np.hstack([source, target]),
                delimiter=",",
                header=header,
                comments="",
                fmt=["%d", "%d", "%d", "%.4f", "%.4f", "%.4f"],
            )
            entry["toCommon"] = {
                "file": dest.name,
                "landmarks": int(len(source)),
                "regions": per_region,
                "resolutionNm": res,
                "sourceColumns": ["x", "y", "z"],
                "targetColumns": ["jrc2018u_x", "jrc2018u_y", "jrc2018u_z"],
                "sourceUnits": "nm",
                # JRC2018U is published in micrometres. Coda converts to nm on
                # load, which is exact: a 3-D thin-plate spline's kernel is
                # U(r) = r, homogeneous of degree one, so scaling either side
                # scales the result and nothing else.
                "targetUnits": "um",
            }

        manifest["spaces"].append(entry)

    args.manifest.parent.mkdir(parents=True, exist_ok=True)
    args.manifest.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"\nwrote {args.manifest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
