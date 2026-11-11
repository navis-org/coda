#!/usr/bin/env python3
"""Package one of SEAM's exported assessors as a model `src/ml` can fetch.

    python3 -I scripts/make-assessor-manifest.py <SEAM data/onnx/sa2_mask> <out dir> [--seed 0]

Writes `<out dir>/` holding the graph and a `manifest.json` in Coda's own schema, which is then
uploaded whole — the directory *is* the deployment, because `src/ml` resolves every file against
the manifest's own URL and so the same directory works at any host, behind any path.

## Why this is here and not in SEAM

SEAM's `scripts/export_onnx.py` writes Coda manifests for Models A and E, and this could have
gone there too. It did not, for one reason: **the assessors are exported for SEAM's own cluster
first.** `export_assessor.py` produces six graphs, a parity fixture, real patches and a
timing record, none of which a browser wants; what Coda needs is one graph of one seed in one
kernel form, hashed and addressed its way. Putting Coda's packaging in SEAM's exporter would
make SEAM's schema version a thing SEAM has to track.

So this **converts nothing** — SEAM's ONNX is copied byte for byte, and its own manifest is the
source for every number here. What this adds is addressing, hashing and the `config` blob the
pack reads.

## What it chooses, and why

**One seed per manifest.** The three seeds are alternatives, not a pipeline — `parts` means
"graphs that must all be run, in order", which they are not. A seed is a row in
`src/packs/seam/models.ts`, the way a second affinity checkpoint would be.

**The matmul form only.** `src/ml` is WebGPU or nothing (`support.ts` refuses before anything is
downloaded), and on WebGPU the matmul graph is **8.4x** the convolution one for the same answer
— 1,122 ms a patch against 133 (`docs/seam-assessor-speed.md`). Shipping the `conv` form beside
it would double a 133 MB upload for a path that is never taken. Note this is the opposite of the
right choice on a CPU, where the convolution form is four times *faster* (SEAM's
`fixture_timing.json`: 0.199 s a patch against 0.854) — which is why the two forms exist at all.

**No dynamic axes.** The matmul graph pins its batch to 1, and must: flattening `(N,C,X,Y,Z)` to
`(C, voxels)` is only the same tensor at N=1. `signatures.assess.dynamic` is therefore empty,
which is the truth and also what stops a caller feeding it a list.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
from pathlib import Path

TASK = "merge-assessor"
PART = "assess"
VARIANT = "matmul"

#: Coda's manifest schema, read from the TypeScript rather than copied.
#:
#: `convert-affinity-model.py` hard-codes it, and a stale copy there is at least loud — every
#: manifest it wrote would be refused at load. Reading it is four lines and cannot go stale at
#: all, which is the same bargain `src/packs/seam/patchBox.ts` makes with the vendored Python.
def manifest_schema(repo: Path) -> int:
    source = (repo / "src/ml/manifest.ts").read_text()
    found = re.search(r"^export const MANIFEST_SCHEMA = (\d+)", source, re.M)
    if not found:
        raise SystemExit("src/ml/manifest.ts no longer declares MANIFEST_SCHEMA")
    return int(found.group(1))


def digest(path: Path) -> str:
    sha = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            sha.update(block)
    return sha.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("exported", type=Path, help="SEAM's data/onnx/sa2_mask")
    ap.add_argument("out", type=Path, help="the directory to upload")
    ap.add_argument("--seed", type=int, default=0, help="which of the three checkpoints (0)")
    args = ap.parse_args()

    repo = Path(__file__).resolve().parent.parent
    seam = json.loads((args.exported / "manifest.json").read_text())
    name = f"sa2_mask_mm_s{args.seed}"
    entry = next((m for m in seam["models"] if m["file"] == f"{name}.onnx"), None)
    if entry is None:
        raise SystemExit(
            f"{args.exported}/manifest.json lists no {name}.onnx. Export it with "
            "`export_assessor.py export --kernels matmul`."
        )

    # Hashed before it is copied, never after: a truncated or half-written source would
    # otherwise be packaged with a hash of itself and verify perfectly in the browser.
    source = args.exported / entry["file"]
    got = digest(source)
    if got != entry["sha256"]:
        raise SystemExit(
            f"{entry['file']} hashes to {got}, and SEAM's manifest says {entry['sha256']}. "
            "The file on disk is not the one that was exported; nothing was written."
        )

    ops = set(entry["ops"])
    if "Conv" in ops and "MatMul" not in ops:
        raise SystemExit(
            f"{entry['file']} contains Conv and no MatMul: this is the convolution form, which "
            "runs 8.4x slower on WebGPU. Export --kernels matmul."
        )
    if entry.get("batch") != 1:
        raise SystemExit(f"{entry['file']} declares batch {entry.get('batch')}, and this packages batch 1 only.")

    args.out.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, args.out / entry["file"])

    manifest = {
        "id": f"sa2_mask_s{args.seed}",
        "manifestSchema": manifest_schema(repo),
        "task": TASK,
        "parts": [PART],
        "datasets": sorted(
            {d.split(":")[0] for d in entry["checkpoint"]["train_args"]["data"]}
        ),
        "license": "MIT",
        "citation": (
            "SEAM, Drosophila Connectomics group; mask assessor trained on the Aedes "
            "reconstruction's edit history"
        ),
        "source": "https://github.com/flyconnectome/SEAM",
        "upstreamCommit": seam["commit"],
        "randomWeights": False,
        # Opaque to `src/ml`; `src/packs/seam` reads it. Copied from SEAM's manifest wherever
        # SEAM states it, so the patch contract a browser cuts against and the one the
        # checkpoint was trained on are one text rather than two that can drift.
        "config": {
            "seed": args.seed,
            "kernels": entry["kernels"],
            "batch": entry["batch"],
            "input": seam["input"],
            "output": seam["output"],
            # The score a candidate takes when its patch cannot be cut. Per seed, and SEAM's
            # own: a browser scoring one tip at a time has no batch to take a minimum over.
            "missingPatchScore": seam["missing_patch_score"][args.seed],
            "gflopPerPatch": seam["cost"]["gflop_per_patch"],
            "checkpoint": entry["checkpoint"]["val"],
            "parity": seam["parity"]["rule"],
        },
        "signatures": {
            PART: {
                "inputs": [seam["input"]["name"]],
                "outputs": [seam["output"]["name"]],
                # Empty, and that is the fact: the matmul graph pins its batch axis to 1.
                "dynamic": {},
            }
        },
        "files": [
            {
                "variant": VARIANT,
                "part": PART,
                "file": entry["file"],
                "url": None,
                "bytes": entry["bytes"],
                "sha256": entry["sha256"],
                "quantisation": {
                    "kind": "none",
                    "io": "float32",
                    "quantises": [],
                    # What decides whether a browser can run it at all, which is why it is
                    # recorded rather than derived: this graph's matmuls are plain `MatMul` and
                    # `Gemm`, both of which WebGPU takes. `MatMulInteger` would not be.
                    "emits": sorted(ops & {"MatMul", "Gemm", "MatMulInteger", "MatMulNBits"}),
                },
            }
        ],
    }
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=1) + "\n")

    print(f"{args.out}/")
    print(f"  manifest.json     {TASK} / {manifest['id']}, schema {manifest['manifestSchema']}")
    print(f"  {entry['file']}  {entry['bytes'] / 1e6:.0f} MB, sha256 verified")
    print(f"\nUpload the directory whole. Then point a row in src/packs/seam/models.ts at")
    print(f"  <host>/{args.out.name}/manifest.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
