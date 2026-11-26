#!/usr/bin/env python3
"""Package one of SEAM's exported assessors, with the pipeline it was fitted in, as a model
`src/ml` can fetch.

    python3 -I scripts/make-assessor-manifest.py \\
        <SEAM data/onnx/n3_mal_mask> <SEAM fixture.json> <out dir> [--seed 0]

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

So this **converts nothing** — SEAM's ONNX is copied byte for byte, and its own manifest and the
configuration's own fixture are the source for every number here. What this adds is addressing,
hashing and the `config` blob the pack reads.

## The fits ride with the weights

The second argument is the `fixture.json` of the configuration this checkpoint is scored in, and
its `pipeline` block is copied into `config.pipeline` whole. That is the same bargain
`make-ranker-manifest.mjs` makes, for the same reason stated the other way round: SEAM refits
ref, `p_tip`, the cutoff and the `r` staircase **per configuration**, and says so in as many words
for the single-seed one ("These weights are new... This cutoff is new too"). A build that scored
one seed against production's three-seed fits would publish a probability for every tip and the
right one for none, and nothing downstream could tell.

Which is also why the fixture is checked against the graph rather than trusted beside it: a
`pipeline.assessor.ckpt` naming another checkpoint is two halves of two different configurations
in one file.

## What it chooses, and why

**One seed per manifest.** The three seeds are alternatives, not a pipeline — `parts` means
"graphs that must all be run, in order", which they are not. A seed is a row in
`src/packs/seam/models.ts`, the way a second affinity checkpoint would be.

**Both forms, because they are two runtimes rather than two qualities.** This shipped the matmul
form alone while ONNX Runtime was the only way to run the network: its WebGPU backend puts 3D
`Conv` through a per-element shader, so the matmul rewrite was 8.4x the plain graph *there*.
Coda now implements the architecture itself in WGSL (`src/packs/seam/gpuAssessor/`), which reads
the **plain** export at 26.5 ms a patch against ONNX Runtime's 136. Both are listed: a reader
downloads exactly one, and which one is named at the opening site. The `VARIANTS` table below
says which is which and why neither may be chosen by size.

**One patch at a time.** `signatures.assess.dynamic` is empty for both builds, which is what
stops a caller feeding either a list, and `config.batch` is published once as 1 — what a browser
actually feeds. The two graphs reach that differently and both are checked: the matmul build
*pins* its batch axis to 1 and must, because flattening `(N,C,X,Y,Z)` to `(C, voxels)` is only
the same tensor at N=1, while the plain export leaves the axis free. A free axis satisfies
"accepts one"; a pin above one does not, and is refused.
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

#: The two builds of one checkpoint, and which runtime reads which.
#:
#: `conv` is the plain export, read by Coda's own WGSL implementation of the architecture
#: (`src/packs/seam/gpuAssessor/`) at 26.5 ms a patch. `matmul` is the same weights cut into
#: per-offset pieces for ONNX Runtime, whose WebGPU backend runs 3D `Conv` through a naive
#: per-element shader; it is 136 ms a patch and is kept as the fallback and as the probe's
#: comparison baseline. **Both are listed**, because a variant is chosen at open time and a
#: reader downloads exactly one of them. The second element is the operator that makes a file
#: *be* that build: the two are the same size and the same weights, so nothing else tells them
#: apart, and each is useless to the other's runtime.
VARIANTS = {"conv": ("", "Conv"), "matmul": ("_mm", "MatMul")}

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


def fitted_pipeline(fixture: Path, model_e: Path | None, family: str, seed: int) -> dict:
    """The `pipeline` block of the configuration this checkpoint is scored in, checked.

    Copied rather than transcribed, as `input` and `output` are: these are the numbers SEAM
    fitted, and a hand-kept Coda-side copy of them is exactly what moving the ranker's pipeline
    into its manifest was for.

    Two checks, both for shapes that otherwise produce numbers:

    * the fixture must name **this** checkpoint. Two configurations' fixtures look identical in
      structure, and a manifest holding one checkpoint's weights beside another's fits would load,
      run, rank and show.
    * `model_e.e_tip_floor` must be there. It is what `p_tip` is given for a tip Model E found no
      cell near, and the value the fit itself saw -- not a neutral one. SEAM states it in the
      fixture of the configuration that *introduced* Model E and omits it from one whose Model E
      is inherited unchanged, so `--model-e` points at the fixture that configuration says it is
      `based_on`.
    """
    doc = json.loads(fixture.read_text())
    block = dict(doc.get("pipeline") or {})
    if not block:
        raise SystemExit(f"{fixture} has no `pipeline` block, so there are no fits to carry.")

    ckpt = str((block.get("assessor") or {}).get("ckpt", ""))
    wanted = f"{family}_s{seed}"
    if wanted not in ckpt:
        raise SystemExit(
            f"{fixture} says its assessor is {ckpt!r}, and this packages {wanted}. The weights "
            "and the fits would be from two different configurations, and every number after "
            "the scorer would still be a number."
        )

    if "e_tip_floor" not in (block.get("model_e") or {}):
        if model_e is None:
            based_on = doc.get("based_on") or "see the fixture's own `based_on`"
            raise SystemExit(
                f"{fixture} states no `pipeline.model_e.e_tip_floor`, which is what p_tip is "
                "given for a tip Model E found no cell near. It is unchanged in this "
                f"configuration ({based_on}), so pass `--model-e` pointing at that fixture -- "
                "or have SEAM emit the block."
            )
        base = json.loads(model_e.read_text()).get("pipeline") or {}
        if "e_tip_floor" not in (base.get("model_e") or {}):
            raise SystemExit(f"{model_e} states no `pipeline.model_e.e_tip_floor` either.")
        # **The same Model E, checked** — the same way this function checks the assessor's own
        # checkpoint, and for a sharper reason. `e_tip_floor` is what `decideTip` gives `p_tip`
        # for every tip Model E found no cell near, so a floor spliced from a configuration
        # fitted against a different Model E is a plausible probability on a whole class of tips
        # and nothing downstream can tell. Where the configuration's own fixture names its
        # Model E, the two must agree; where it names none, there is nothing to check against
        # and the splice is the reader's assertion.
        mine = (block.get("model_e") or {}).get("ckpt")
        theirs = (base.get("model_e") or {}).get("ckpt")
        if mine and theirs and mine != theirs:
            raise SystemExit(
                f"{fixture} was fitted against Model E {mine!r} and {model_e} states {theirs!r}. "
                "`e_tip_floor` is the value the p_tip fit saw for a tip with no cell near it, so "
                "the two have to be the same checkpoint."
            )
        block["model_e"] = base["model_e"]

    return block


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("exported", type=Path, help="SEAM's data/onnx/<family>")
    ap.add_argument(
        "fixture",
        type=Path,
        help="the fixture.json of the configuration this checkpoint is scored in",
    )
    ap.add_argument("out", type=Path, help="the directory to upload")
    ap.add_argument(
        "--model-e",
        type=Path,
        help=(
            "a fixture.json to take the unchanged `pipeline.model_e` block from, where the "
            "configuration's own fixture states none (it is the one it says it is `based_on`)"
        ),
    )
    ap.add_argument("--seed", type=int, default=0, help="which of the three checkpoints (0)")
    args = ap.parse_args()

    repo = Path(__file__).resolve().parent.parent
    seam = json.loads((args.exported / "manifest.json").read_text())
    # The family is the export directory's, not a constant: SEAM has exported `sa2_mask` and
    # `n3_mal_mask` from the same script, and a checkpoint name baked in here would have
    # packaged the first under the second's name the day the second landed — one manifest
    # holding one family's weights and another's fits, both perfectly well formed.
    family = args.exported.name
    entries = {}
    for variant, (infix, _op) in VARIANTS.items():
        name = f"{family}{infix}_s{args.seed}.onnx"
        entry = next((m for m in seam["models"] if m["file"] == name), None)
        if entry is None:
            raise SystemExit(
                f"{args.exported}/manifest.json lists no {name}. Export it with "
                "`export_assessor.py export --kernels conv,matmul`."
            )
        entries[variant] = entry

    pipeline = fitted_pipeline(args.fixture, args.model_e, family, args.seed)

    # The entry every *shared* fact is read from. Both builds are the same checkpoint, so it
    # does not matter which — but it has to be named rather than taken from whatever `entry`
    # the copy loop below happened to leave bound, which is `VARIANTS`' last key and would
    # change silently if somebody reordered the dict.
    spec = entries["matmul"]

    # **Every refusal before any write**, which is the ordering `fitted_pipeline` above already
    # follows and which the hash check's own "nothing was written" promise depends on: checking
    # inside the copy loop would leave the first build on disk when the second one failed.
    for variant, entry in entries.items():
        # Hashed before it is copied, never after: a truncated or half-written source would
        # otherwise be packaged with a hash of itself and verify perfectly in the browser.
        got = digest(args.exported / entry["file"])
        if got != entry["sha256"]:
            raise SystemExit(
                f"{entry['file']} hashes to {got}, and SEAM's manifest says {entry['sha256']}. "
                "The file on disk is not the one that was exported; nothing was written."
            )
        required = VARIANTS[variant][1]
        if required not in set(entry["ops"]):
            raise SystemExit(
                f"{entry['file']} has no {required}, so it is not the {variant} build. The two "
                "builds are the same weights and the same size; this is what tells them apart."
            )
        # **Each build has to accept one patch**, which is what `config.batch: 1` published
        # below says about both of them and what the browser actually feeds.
        #
        # A *free* axis satisfies that and a pinned 1 satisfies it; only a value pinned above 1
        # does not. The two builds differ here and both are fine: the matmul graph is pinned to
        # 1 and must be, because flattening `(N,C,X,Y,Z)` to `(C, voxels)` is the same tensor
        # only at N=1, while the plain export leaves the axis free. Checking only matmul — which
        # this did for a round — would have shipped `batch: 1` over a conv export pinned to
        # something else, with `parseAssessorConfig` waving it through.
        batch = entry.get("batch")
        if isinstance(batch, int) and batch != 1:
            raise SystemExit(
                f"{entry['file']} pins its batch axis to {batch}, and a browser feeds one patch "
                "at a time. `config.batch` is published once for both builds."
            )


    manifest = {
        "id": f"{family}_s{args.seed}",
        "manifestSchema": manifest_schema(repo),
        "task": TASK,
        "parts": [PART],
        "datasets": sorted(
            {d.split(":")[0] for d in spec["checkpoint"]["train_args"]["data"]}
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
            "batch": spec["batch"],
            "input": seam["input"],
            "output": seam["output"],
            # The score a candidate takes when its patch cannot be cut. Per seed, and SEAM's
            # own: a browser scoring one tip at a time has no batch to take a minimum over.
            "missingPatchScore": seam["missing_patch_score"][args.seed],
            "gflopPerPatch": seam["cost"]["gflop_per_patch"],
            "checkpoint": spec["checkpoint"]["val"],
            "parity": seam["parity"]["rule"],
            # Stages 7-9, copied whole from the fixture of the configuration this checkpoint is
            # scored in. `src/packs/seam/pipelineFits.ts` reads it; see the header.
            "pipeline": pipeline,
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
                "variant": variant,
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
                    "emits": sorted(
                        set(entry["ops"]) & {"MatMul", "Gemm", "MatMulInteger", "MatMulNBits"}
                    ),
                },
            }
            for variant, entry in entries.items()
        ],
    }
    # **Written last, and only once the manifest exists.** The graphs used to be copied before
    # the dict was built, so anything that could still fail while building it — an out-of-range
    # `--seed`, a `MANIFEST_SCHEMA` this can no longer find — left 266 MB in the output
    # directory with no `manifest.json` beside it, which is a directory that looks uploadable
    # and is not. The comment above the checks promises that cannot happen; now it cannot.
    args.out.mkdir(parents=True, exist_ok=True)
    for entry in entries.values():
        shutil.copyfile(args.exported / entry["file"], args.out / entry["file"])
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=1) + "\n")

    print(f"{args.out}/")
    print(f"  manifest.json     {TASK} / {manifest['id']}, schema {manifest['manifestSchema']}")
    for variant, entry in entries.items():
        print(f"  {entry['file']:<26} {variant:<7} {entry['bytes'] / 1e6:.0f} MB, sha256 verified")
    seeds = pipeline["ref"].get("seeds")
    print(
        f"  fits              ref on {len(seeds) if seeds else 1} seed(s), "
        f"cutoff {pipeline['show']['cutoff']:.4f}, "
        f"{len(pipeline['r']['steps_q'])} display steps"
        + (", split" if "split" in pipeline else ", no split")
    )
    print(f"\nUpload the directory whole. Then point a row in src/packs/seam/models.ts at")
    print(f"  <host>/{args.out.name}/manifest.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
