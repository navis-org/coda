# Vendored from SEAM

Four **byte-identical copies** of whole SEAM modules, and one slice.

They are not edited here, and that is the point. SEAM's invariant 3 is that training and
inference build the model's input through *one* function, and its invariant 11 is that the
code doing so is numpy-only precisely so the same file runs in CPython for training and in
Coda's Pyodide worker for inference. A reimplementation in TypeScript — or even a copy with
its imports rewritten — is the drift those rules exist to prevent, and nothing on this side
could detect it: a window built slightly differently still produces a plausible score, a
feature computed slightly differently still ranks, and a patch cut half a voxel over still
scores.

```
pnpm vendor:seam            # check every file here against SEAM
pnpm vendor:seam --write    # re-copy and re-cut them
```

One command, and it covers both kinds. It also checks the table below against the files on
disk, so the hashes cannot go stale — they are for a reader with no SEAM checkout, and the
`shasum` this file used to prescribe was the step nobody ran.

## The copies

| file | from | what |
| --- | --- | --- |
| `canonical.py` | `seam/canonical.py` | the model's input, built one way |
| `scan.py` | `seam/scan.py` | the windows a surface is tiled into |
| `cutout.py` | `seam/cutout.py` | what is in a supervoxel cutout, and the local shape near a point |
| `patches.py` | `seam/segclr/patches.py` | the assessor's 129³ patches, and the box labelling under them |

| file | sha256 |
| --- | --- |
| `canonical.py` | `1555371a8150caf7f862d48cc8152370f4d92d9db9926d01e9b36c9ba791d7c3` |
| `scan.py` | `e65c4d423c3f7e42b06232f0fd1291b13c4e8a0d76e18fbbae598caefa2c5f5d` |
| `cutout.py` | `5839b36359eed58d4a2c7aea0e1affc136eab05865ed2330f37b8418f499526a` |
| `patches.py` | `4a96fc79f320380bb9c6c045c7bd1ec9c2931fc134cf901996ac7c83d37e965e` |

Copied at SEAM commit `84cb4d2`. Recording it matters as much
as the hashes: without it a clean ✓ against a dirty or differently-branched checkout is
indistinguishable from a real one, and nobody can tell later which SEAM state a feature or a
patch was copied from.

`scan.py` does `from . import canonical`, so these are installed as a real `seam` package at
runtime rather than flattened. `seamWindows.py` does that for the windows and
`assessorPatches.py` for the patches; both are Coda's own.

**`cutout.py` was a slice until 2026-11-10**, when SEAM moved `summarize_cutout` out of
`negatives.py` — which imports `cave`, `paths` and `pre_edit` — into a module of its own, for
exactly this reason. Its docstring names this copy. The move was found by the check rather than
announced: `pnpm vendor:seam` refused by name, because the markers bounding the run had gone.

**`patches.py` says so itself**: "Coda's browser scorer vendors it whole (invariant 11)". It is
the assessor's input contract — 129³ voxels at 32 nm, axes (X, Y, Z), labels 1 = Q, 2 = C,
0 = neither — and a browser that cut that patch its own way would be feeding a checkpoint
something it was not trained on.

**It changed under exactly that pressure, at `dbfef4c`.** `sample` used to pick each label
plane's section by rounding a position measured from the box's corner, so a plane landing
exactly on a section boundary was resolved by that corner's parity and a patch depended on the
box it came from — a quarter of candidates, logits up to 1.5. It is now `label_sections`: a
`floor` of the absolute position, the section that *holds* the plane, with no tie for a port to
break another way. [seam-patch-sampling.md](../../../docs/seam-patch-sampling.md) is the report
that led to it, and §11 is SEAM's answer.

**The published fixture has caught up** (SEAM `84cb4d2`, set `rv2-0d62bc912a89`): the patch sets
were rebuilt from the label cache under the new rule and rescored in fp32, every fit redone, and
`pnpm probe:assessor-patch` now demands a patch be SEAM's byte for byte from any box that holds
it. The tied-plane allowance it carried until 2026-11-11 is gone. `patches.py` itself is
unchanged between `dbfef4c` and `84cb4d2` — the refit moved the data, not the sampler.

## `candidates.py` is a **slice**, not a whole-file copy

One run taken **without editing a character of it**: `pool_features` and `GeometricRanker` out
of `seam/candidates.py` — the eight features and the fitted score. It cannot be a whole-file
copy because that module imports `paths`, which reaches the filesystem; what Coda needs is
numpy and pandas only and sits in one contiguous run.

**It drifts the way the copies would, which is why it is vendored at all.** A feature computed
slightly differently still *ranks* — the list comes back with plausible scores in a plausible
order, and nothing downstream can tell. `pnpm probe:candidate-search` is what would notice: it
ranks one real open end and compares against SEAM's own `geo_rank` for it.

A sha256 cannot pin a slice the way it pins the copies above, because the bytes here are a
*subset* of the bytes there. `scripts/vendor-seam.mjs` does that job instead — it re-cuts the
run by the markers that bound it and byte-compares. If SEAM moves the functions the script
refuses by name rather than cutting the wrong run, which is how the `cutout.py` move was found.

**The better end state is for SEAM to extract this one too**, as it has now done for the other
four. Then the slice machinery goes. That ask is in `docs/seam-suggestions-plan.md`.

**What the check does not catch:** a copy or a run that acquires a *new* module-level
dependency upstream. For a copy the import simply fails in the worker; for a slice it is cut
away silently and surfaces as a `NameError` in a browser. `pnpm probe:cutout-summary`'s CPython
leg is what notices, because it imports the cut files on their own.

**Updating any of them:** re-run `pnpm vendor:seam --write`, update the commit and the hashes
above, and re-run `pnpm probe:seam-windows`, `pnpm probe:cutout-summary` and
`pnpm probe:candidate-search`. If SEAM changes the sampler or the patch, the models have to be
re-exported too — the input a checkpoint was trained on is part of what it means.
