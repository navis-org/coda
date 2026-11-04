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

**Updating them:** re-copy both, update the commit above, and re-run
`pnpm probe:seam-windows`. If SEAM changes the sampler, the model has to be re-exported
too — the window a checkpoint was trained on is part of what it means.
