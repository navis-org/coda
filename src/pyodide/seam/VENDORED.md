# Vendored from SEAM

`canonical.py` and `scan.py` are **byte-identical copies** of
`~/Github/SEAM/seam/` at commit `b361de9701c5643566fe1f3efa35513f3c82e421`.

They are not edited here, and that is the point. SEAM's invariant 3 is that training and
inference build the model's input through *one* function, and its invariant 11 is that the
code doing so is numpy-only precisely so the same file runs in CPython for training and in
Coda's Pyodide worker for inference. A reimplementation in TypeScript — or even a copy with
its imports rewritten — is the drift those rules exist to prevent, and nothing on this side
could detect it: a window built slightly differently still produces a plausible score.

`scan.py` does `from . import canonical`, so the two are installed as a real `seam`
package at runtime rather than flattened. `seamWindows.py` does that and is the only file
here that Coda wrote.

| file | sha256 |
| --- | --- |
| `canonical.py` | `1555371a8150caf7f862d48cc8152370f4d92d9db9926d01e9b36c9ba791d7c3` |
| `scan.py` | `e65c4d423c3f7e42b06232f0fd1291b13c4e8a0d76e18fbbae598caefa2c5f5d` |

Check them with `shasum -a 256 src/pyodide/seam/*.py`, against the same command in SEAM at the
commit above. A copy that has drifted is the one failure neither repo's tests can see.

## `cutout.py` and `candidates.py` are **slices**, not whole-file copies

Two runs taken **without editing a character of them**:

| file | from | what |
| --- | --- | --- |
| `cutout.py` | `seam/negatives.py` | `summarize_cutout`, `_local_moments` — what is in a box |
| `candidates.py` | `seam/candidates.py` | `pool_features`, `GeometricRanker` — the eight features and the score |

Neither can be a whole-file copy: `negatives.py` imports `cave`, `paths` and `pre_edit`, and
`candidates.py` imports `paths`. What Coda needs out of each is numpy, scipy and pandas only, and
sits in one contiguous run.

**The second slice drifts the same way the first does, and that is why it is vendored too.** A
feature computed slightly differently still *ranks* — the list comes back with plausible scores
in a plausible order, and nothing downstream can tell. `pnpm probe:candidate-search` is what
would notice: it ranks one real open end and compares against SEAM's own `geo_rank` for it.

Cut at SEAM commit `3cc180a167a67e6423393d62659405045dba3aca`. Recording it matters as much here as the hashes
do above: without it a clean ✓ against a dirty or differently-branched checkout is
indistinguishable from a real one, and nobody can tell later which SEAM state the ranker's
features were cut from.

A sha256 cannot pin a slice the way it pins the copies above, because the bytes here are a
*subset* of the bytes there. `scripts/vendor-seam-cutout.mjs` does that job instead — it re-cuts
the run from `negatives.py` by the markers that bound it and byte-compares:

```
pnpm vendor:seam-cutout            # check this file against SEAM
pnpm vendor:seam-cutout --write    # re-cut it
```

If SEAM moves these functions the script refuses by name rather than cutting the wrong run.

**The better end state is for SEAM to extract them** into a numpy-only module of their own, as
`canonical.py` and `scan.py` already are. Then the script goes and the file joins the table
above. That ask is recorded in `docs/seam-suggestions-plan.md`.

The script checks both; a sha256 here would pin only one state of a subset, and is left out
deliberately so there is one check rather than two that can disagree.

**Updating them:** re-copy both, update the commit above, and re-run
`pnpm probe:seam-windows`. If SEAM changes the sampler, the model has to be re-exported
too — the window a checkpoint was trained on is part of what it means.
