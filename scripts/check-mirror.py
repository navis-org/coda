#!/usr/bin/env python3
"""Check Coda's mirror against `navis.mirror_brain`, the thing it re-implements.

The unit tests assert that `flipAt - x` is computed correctly and the probe asserts that the
spline reproduces its own landmarks. What neither can assert is that the *shipped files* say
what navis says — `flipAt` is generated from flybrains' bounding boxes and the landmark CSVs
are copies of flybrains' own, so a bug in `gen-transforms.py` produces a mirror that runs,
returns a plausible neuron, and puts it tens of micrometres from where navis would. Nothing in
the browser can see that; only navis can.

Two passes, matching the node's two halves:

1. **The flip**, against `mirror_brain(..., warp=False)`. Must agree *exactly*: both are a
   subtraction in float64 from the same constant, so anything but zero means the constant
   parted company with the template it was read from.

2. **The whole mirror**, against `mirror_brain(..., warp=True)` — the flip followed by a
   thin-plate spline through the CSV in `public/transforms/`. This is the one that checks the
   file: a column read in the wrong order, a row dropped, a stale copy. It compares against
   navis' *own* registered transform for the same space, so what is being checked is whether
   Coda's copy still matches its source.

    python3 scripts/check-mirror.py

Needs navis, flybrains and navis-fastcore, and skips with a notice where they are missing — the
same bargain `check-export.py` makes about its third pass. It needs no H5 registrations; a
landmark mirror consults none.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "src" / "data" / "transforms" / "manifest.json"
LANDMARKS = ROOT / "public" / "transforms"

#: Random points per space. Enough that a constant wrong in one axis cannot slip through.
SAMPLES = 500

AXIS_INDEX = {"x": 0, "y": 1, "z": 2}


def read_landmarks(spec: dict):
    """One of the shipped CSVs, in nanometres, exactly as `landmarks.ts` reads it."""
    import numpy as np

    path = LANDMARKS / spec["file"]
    rows = path.read_text().strip().split("\n")
    header = [name.strip() for name in rows[0].split(",")]
    si = [header.index(name) for name in spec["sourceColumns"]]
    ti = [header.index(name) for name in spec["targetColumns"]]
    scale = {"um": 1000.0, "nm": 1.0}

    values = np.array([[float(f) for f in row.split(",")] for row in rows[1:]])
    return (
        values[:, si] * scale[spec["sourceUnits"]],
        values[:, ti] * scale[spec["targetUnits"]],
    )


def main() -> int:
    try:
        import numpy as np
        import navis
        import navis_fastcore as fc
        import flybrains
    except ImportError as exc:
        print(f"skipped: needs navis and flybrains ({exc})")
        print("  pip install navis flybrains navis-fastcore")
        return 0

    manifest = json.loads(MANIFEST.read_text())
    rng = np.random.default_rng(11)
    failures = 0

    print(f"{'space':<14} {'flipAt':>12} {'flip only':>12} {'with spline':>14}")
    for space in manifest["spaces"]:
        sid = space["id"]
        mirror = space.get("mirror")
        if not mirror:
            continue

        template = getattr(flybrains, sid, None)
        if template is None:
            print(f"  FAIL  {sid}: flybrains has no template of that name")
            failures += 1
            continue

        # The space's own box, so every sample is somewhere a neuron could be. A flip is affine
        # and would agree anywhere, but a comparison over the wrong volume proves less.
        bbox = np.asarray(template.boundingbox).reshape(3, 2)
        points = rng.uniform(bbox[:, 0], bbox[:, 1], size=(SAMPLES, 3))

        expected = np.asarray(navis.mirror_brain(points, template=sid, warp=False))

        axis = AXIS_INDEX[mirror["axis"]]
        actual = points.copy()
        actual[:, axis] = mirror["flipAt"] - actual[:, axis]

        flip_error = float(np.abs(expected - actual).max())
        if flip_error != 0.0:
            # Not a tolerance. Both sides subtract from the same constant in float64; a
            # non-zero difference means they are not the same constant.
            print(f"  FAIL  {sid}: navis and the manifest disagree about the midline")
            failures += 1

        # --- the whole thing, through the CSV this build actually ships ---------
        source, target = read_landmarks(mirror)
        warped = fc.TpsTransform(source, target).xform(actual)
        expected_warp = np.asarray(navis.mirror_brain(points, template=sid, warp=True))
        warp_error = float(np.abs(expected_warp - warped).max())

        print(
            f"{sid:<14} {mirror['flipAt']:>12,.0f} {flip_error:>12.1e} {warp_error:>14.1e}"
        )
        if warp_error > 1e-6:
            # fastcore's TPS agrees with navis' to ~1e-14 relative, so at coordinates of order
            # 1e6 nm this is generous by orders of magnitude. What it catches is the landmark
            # file having parted company with flybrains' — which lands micrometres out, not
            # nanometres.
            print(f"  FAIL  {sid}: the shipped landmarks disagree with navis-flybrains'")
            failures += 1

    if failures:
        print(f"\n{failures} check(s) failed. Re-run scripts/gen-transforms.py.")
        return 1
    print("\nevery mirror agrees with navis, flip and spline alike")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
