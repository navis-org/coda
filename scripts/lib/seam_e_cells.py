#!/usr/bin/env python3
"""The numpy half of `probe-seam-e-cells.mjs`: SEAM's own answer, and the comparison.

The probe runs Coda's windows and Model E in a browser; what it cannot do there is read SEAM's
`e_cells/<neuron>.npz` and `tips.parquet`. Those stay here, in numpy and pandas, for the reason
the vendored `scan.py` stays Python: the reference is SEAM's file, and a reader of it written in
another language is a second implementation to keep honest.

Three subcommands, reading from a SEAM fixture directory and writing JSON the probe turns into
checks.

    python3 -I scripts/lib/seam_e_cells.py tips <fixture> <neuron> <out.json>
    python3 -I scripts/lib/seam_e_cells.py mesh <mesh.npz> <out.bin>
    python3 -I scripts/lib/seam_e_cells.py compare <fixture> <neuron> <cells.bin> <tips.json>

`cells.bin` is what the browser produced: `n` float32 triples of nanometres, then `n` float32
scores, which is the shape `reduce_max` returns and the cheapest thing to get out of a page.

## What "agrees" means here, and why it is not one number

Two quantities are compared and they fail differently.

**The cells** are a *set*: one point per 0.5 µm cell, each carrying the best logit in it. A port
that drifts in the sampling moves points between cells, so the first thing to measure is how many
of SEAM's cells Coda found at all, by position. Cells that both have are then compared by logit,
where a disagreement is the GPU's and should be at the 1e-5 that `probe:seam-model` measured for
this graph.

**`e_tip`** is what the pipeline actually reads — the best cell within `E_TIP_UM` of a tip — and
the handoff names the bar: p_tip weighs E at 0.959, so an `e_tip` off by 0.1 moves p_tip's logit
by about that, and parity is judged by whether the shown set changes rather than by raw error.
Re-deriving `shown` needs the p_tip fit and the cutoff, which belong to the stage that computes
them and is not built yet, so what is reported here is the error **and how many tips move by
more than 0.1** — the count that decides whether the shown set could have moved at all.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

#: `calib_tips.E_TIP_UM`: how far from a tip a Model E cell may be and still be its `e_tip`.
E_TIP_UM = 1.0


def _cells_from_bin(path: Path) -> tuple[np.ndarray, np.ndarray]:
    """`(pos nm, logit)` out of the browser's flat buffer."""
    flat = np.fromfile(path, dtype=np.float32)
    if len(flat) % 4:
        raise SystemExit(f"{path} holds {len(flat)} floats, which is not 3 + 1 per cell")
    n = len(flat) // 4
    return flat[: n * 3].reshape(n, 3).astype(np.float64), flat[n * 3 :].astype(np.float64)


def _tips_of(fixture: Path, neuron: str) -> pd.DataFrame:
    tips = pd.read_parquet(fixture / "tips.parquet")
    # The neuron column is an id, and ids are text everywhere — a float64 column would name a
    # different neuron for an 18-digit root. Compared as strings for that reason.
    tips = tips[tips["neuron"].astype(str) == str(neuron)]
    return tips.reset_index(drop=True)


def _e_at(cells_pos: np.ndarray, cells_logit: np.ndarray, at: np.ndarray, floor: float):
    """`calib_tips.e_at`: the best cell logit within `E_TIP_UM` of each tip, else the floor."""
    out = np.full(len(at), floor, dtype=np.float64)
    reach_nm = E_TIP_UM * 1000.0
    if not len(cells_pos):
        return out
    for i, p in enumerate(at):
        near = ((cells_pos - p) ** 2).sum(axis=1) <= reach_nm * reach_nm
        if near.any():
            out[i] = cells_logit[near].max()
    return out


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    what = sys.argv[1]

    if what == "tips":
        _, _, fixture, neuron, out = sys.argv
        tips = _tips_of(Path(fixture), neuron)
        if tips.empty:
            raise SystemExit(f"no tips for {neuron} in {fixture}/tips.parquet")
        Path(out).write_text(
            json.dumps(
                {
                    "neuron": str(neuron),
                    "tips": len(tips),
                    # Nanometres, as the pipeline holds them and as a mesh arrives.
                    "xyz": tips[["x_nm", "y_nm", "z_nm"]].to_numpy(dtype=float).ravel().tolist(),
                    "eTip": tips["e_tip"].to_numpy(dtype=float).tolist(),
                    # `tip` or `kink`. Coda produces only the first, so a comparison that does
                    # not split by this is measuring against a target it cannot reach.
                    "kind": tips["kind"].astype(str).tolist(),
                }
            )
        )
        print(f"{len(tips)} tips for {neuron}")
        return

    if what == "mesh":
        # SEAM's own cached mesh as a flat buffer, so the probe can put the *same* geometry
        # through Coda's pipeline and take the mesh out of the question. `cached_object_mesh`
        # stores what the pipeline scored, so this is the exact surface `e_cells` was made on.
        _, _, mesh_npz, out = sys.argv
        z = np.load(mesh_npz)
        v, f = z["v"].astype(np.float32), z["f"].astype(np.uint32)
        with open(out, "wb") as fh:
            fh.write(np.asarray([len(v), len(f)], dtype=np.uint32).tobytes())
            fh.write(v.ravel().tobytes())
            fh.write(f.ravel().tobytes())
        print(f"{len(v)} vertices, {len(f)} faces -> {out}")
        return

    if what != "compare":
        raise SystemExit(f"unknown subcommand {what!r}")

    _, _, fixture, neuron, cells_bin, tips_json = sys.argv
    fixture = Path(fixture)
    ref = np.load(fixture / "e_cells" / f"{neuron}.npz")
    ref_pos, ref_logit = ref["pos"].astype(np.float64), ref["logit"].astype(np.float64)
    got_pos, got_logit = _cells_from_bin(Path(cells_bin))
    tips = json.loads(Path(tips_json).read_text())

    # Cells are matched by the 0.5 µm cell they name rather than by exact coordinate: both sides
    # return the *best point* in a cell, and two runs can pick different points in the same cell
    # without disagreeing about anything the pipeline reads.
    def key(pos):
        return [tuple(k) for k in np.floor(pos / 500.0).astype(np.int64)]

    ref_key, got_key = key(ref_pos), key(got_pos)
    got_by_cell = {}
    for k, v in zip(got_key, got_logit):
        got_by_cell[k] = max(got_by_cell.get(k, -np.inf), v)
    shared = [(i, got_by_cell[k]) for i, k in enumerate(ref_key) if k in got_by_cell]
    report = {
        "neuron": str(neuron),
        "refCells": int(len(ref_pos)),
        "gotCells": int(len(got_pos)),
        "sharedCells": len(shared),
    }
    if shared:
        idx = np.array([i for i, _ in shared])
        mine = np.array([v for _, v in shared])
        error = np.abs(mine - ref_logit[idx])
        report["logitMaxError"] = float(error.max())
        report["logitMeanError"] = float(error.mean())

    # Then `e_tip`, which is the number the pipeline actually reads.
    at = np.asarray(tips["xyz"], dtype=float).reshape(-1, 3)
    want = np.asarray(tips["eTip"], dtype=float)
    # The floor only matters for a tip no cell reaches; taking the fixture's own minimum keeps a
    # missing-cell tip from reading as a huge error when it is really "neither side had one".
    floor = float(want.min())
    mine = _e_at(got_pos, got_logit, at, floor)
    err = np.abs(mine - want)
    report["tips"] = int(len(at))
    report["eTipMaxError"] = float(err.max())
    report["eTipMeanError"] = float(err.mean())
    report["eTipOver0p1"] = int((err > 0.1).sum())
    print(json.dumps(report, indent=1))


if __name__ == "__main__":
    main()
