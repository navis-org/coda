#!/usr/bin/env python3
"""
Does the converted point affinity transformer still give the same answer?

Run after `convert-affinity-model.py`. For each exported variant this runs ONNX Runtime and
PyTorch over the same point clouds and compares them three ways, in increasing order of what
anybody actually cares about:

  1. affinity error          -- max and mean absolute difference per pair
  2. threshold disagreement  -- the share of pairs where `a > 1 - t` differs between the two
  3. clustering disagreement -- VOI (split and merge) and the adjusted Rand index between the
                                labels the two produce after the paper's own pipeline

**Do not judge a variant on (1) alone, and do not judge one on (3) alone either.** The affinity
head ends in a sigmoid and the pipeline cuts it near the flat part, so a mean absolute error of
0.002 can still move a pair across the cut -- (1) under-reports. But where the *model* is
uncertain the clustering is chaotic, and then (3) measures the model's uncertainty rather than
the variant's error: in one measured case fp32 PyTorch itself failed to recover the planting and
every variant's ARI scattered, one to -0.0006. (1) is the stable ranking; (3) is the one that
matters when the model is confident. Read them together, and split the cases by whether the
reference found the planting at all.

## Everything comes from the manifest

The scale, the threshold, the minimum cluster size, the translate augmentation, the architecture
and the graphs' tensor names are all facts the converter already recorded. This script reads them
rather than retyping them, so a corrected constant or a renamed output cannot leave the probe
measuring one thing and reporting against another.

## The point clouds

Synthetic branching trees, not real neurons -- `affinity_reference.py` builds them, and holds
the clustering rule too. This probe measures whether the *conversion* preserves the model's
answer, and for that the input only has to put the affinities in a realistic regime rather than
saturated. Whether the model is any good on real merged segments is Phase 3's question and
cannot be answered here.
"""

from __future__ import annotations

import argparse
import gc
import importlib.util
import json
import sys
from functools import partial
from pathlib import Path
from typing import NamedTuple

import numpy as np

try:
    import onnxruntime as ort
    import torch
except ImportError:  # pragma: no cover - the probe is opt-in
    sys.exit("torch and onnxruntime are not installed; see docs/proofread-plan.md for the venv")

# `affinity_reference` sits beside this file. Added explicitly rather than relying on Python
# putting the script's directory on the path, because `python -I` (isolated) implies `-P`, which
# removes it -- and the failure is an ImportError a long way from its cause.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from affinity_reference import cluster, merged_cloud, voi  # noqa: E402


PARTS = ("encoder", "decoder")


class Case(NamedTuple):
    """One synthetic merge, and what fp32 PyTorch made of it."""

    points: np.ndarray
    reference: np.ndarray
    labels: np.ndarray

    @property
    def clusters(self) -> int:
        """Objects found. Label 0 is the background class, not a cluster."""
        return int(len(np.unique(self.labels[self.labels != 0])))


def load_converter(scripts: Path):
    """
    The converter owns how to build upstream's model and where it is cut in two.

    Importing it means the PyTorch reference runs through *the exact modules that were exported*,
    rather than a second hand-written spelling of the same cut -- which would let a change to the
    split pass this probe while silently comparing ONNX against a different model. `importlib` on
    a hyphenated filename is the house pattern; `probe-skeletonize.py` does it.
    """
    spec = importlib.util.spec_from_file_location(
        "convert_affinity_model", scripts / "convert-affinity-model.py"
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def pair_blocks(n: int, chunk: int):
    """
    The all-pairs index, a block at a time, with the offset each block starts at.

    Never materialised whole: the grid is 2 * n^2 int64, 268 MB at n = 4096 before the transposed
    copy `np.indices(...).T.astype(...)` would add. Only `chunk` pairs are ever in flight.
    """
    for start in range(0, n * n, chunk):
        flat = np.arange(start, min(start + chunk, n * n), dtype=np.int64)
        yield start, np.stack(np.divmod(flat, n), axis=1)[None, ...]


def run_onnx(enc, dec, names: dict, points: np.ndarray, n: int, chunk: int) -> np.ndarray:
    ein, eout = names["encoder"]["inputs"], names["encoder"]["outputs"]
    din, dout = names["decoder"]["inputs"], names["decoder"]["outputs"]
    encoded = enc.run(eout, {ein[0]: points[None, ...], ein[1]: np.ones((1, n), dtype=bool)})
    feeds = dict(zip(din, encoded))
    out = np.empty(n * n, dtype=np.float32)
    for start, block in pair_blocks(n, chunk):
        got = dec.run(dout, {**feeds, din[2]: block})[0][0]
        out[start : start + got.shape[0]] = got
    return out.reshape(n, n)


def run_torch(encoder, decoder, points: np.ndarray, n: int, chunk: int) -> np.ndarray:
    out = np.empty(n * n, dtype=np.float32)
    with torch.no_grad():
        latents, point_emb = encoder(
            torch.from_numpy(points[None, ...]), torch.ones(1, n, dtype=torch.bool)
        )
        for start, block in pair_blocks(n, chunk):
            got = decoder(latents, point_emb, torch.from_numpy(block))[0].numpy()
            out[start : start + got.shape[0]] = got
    return out.reshape(n, n)


def session(path: Path):
    options = ort.SessionOptions()
    options.log_severity_level = 3
    # CPU on purpose: this measures fidelity, not speed. Speed is Phase 1, on a real GPU.
    return ort.InferenceSession(str(path), options, providers=["CPUExecutionProvider"])


def build_cases(encoder, decoder, rng, args, pre: dict, label) -> list[Case]:
    """The fp32 PyTorch reference for every case, built once so the variant loop can be outer."""
    cases = []
    n = args.neurons * args.points
    for index in range(args.cases):
        points, truth = merged_cloud(rng, args.neurons, args.points, pre)
        reference = run_torch(encoder, decoder, points, n, args.chunk)
        case = Case(points, reference, label(reference))
        split, merge = voi(truth, case.labels)
        cases.append(case)
        print(
            f"case {index}: fp32 torch vs ground truth  VOI_s {split:.3f}  "
            f"VOI_m {merge:.3f}  clusters {case.clusters}"
        )
    return cases


def verified_path(manifest: dict, exported: Path, variant: str, part: str, digest) -> Path:
    """
    The file the manifest says, checked against the hash the manifest says.

    Reconstructing `<variant>/<part>.onnx` by hand and trusting it means a truncated download or
    a layout change is reported as an ORT load failure -- or, worse, measured as a genuine
    quantisation difference.
    """
    record = next(
        (f for f in manifest["files"] if f["variant"] == variant and f["part"] == part), None
    )
    if record is None:
        raise FileNotFoundError(f"manifest lists no {variant}/{part}")
    path = exported / record["file"]
    sha, size = digest(path)
    if sha != record["sha256"]:
        raise ValueError(
            f"{record['file']} is {size} bytes with sha256 {sha[:12]}, manifest says "
            f"{record['bytes']} bytes and {record['sha256'][:12]}"
        )
    return path


def compare(variant, cases, exported, manifest, digest, args, cut, label):
    n = args.neurons * args.points
    rows = []
    try:
        enc, dec = (
            session(verified_path(manifest, exported, variant, part, digest))
            for part in PARTS
        )
        rows = _measure(variant, enc, dec, cases, manifest["signatures"], args, n, cut, label)
    except Exception as exc:
        # One variant failing must not discard what the others already measured, so the whole
        # measurement is inside the try, not only the session construction.
        print(f"{variant:7s} FAILED: {type(exc).__name__}: {exc}\n")
        return [*rows, {"error": f"{type(exc).__name__}: {exc}"}]
    print()
    return rows


def _measure(variant, enc, dec, cases, names, args, n, cut, label):
    rows = []
    for index, case in enumerate(cases):
        got = run_onnx(enc, dec, names, case.points, n, args.chunk)
        error = np.abs(case.reference - got)
        labels = label(got)
        split, merge = voi(case.labels, labels)
        row = {
            "case": index,
            "maxAbs": float(error.max()),
            "meanAbs": float(error.mean()),
            "thresholdDisagreement": float(
                np.mean((case.reference > cut) != (got > cut))
            ),
            "voiSplit": split,
            "voiMerge": merge,
            "adjustedRand": float(_ari(case.labels, labels)),
            "clusters": int(len(np.unique(labels[labels != 0]))),
            # Per row, not per case: it is what separates "the variant disagreed" from "the
            # model was uncertain and everything scattered", which is the whole reading above.
            "clustersReference": case.clusters,
        }
        rows.append(row)
        print(
            f"  {variant:7s} case {index}  maxAbs {row['maxAbs']:.4f}  "
            f"meanAbs {row['meanAbs']:.5f}  "
            f"pairs across t {row['thresholdDisagreement'] * 100:.3f}%  "
            f"ARI {row['adjustedRand']:.4f}  clusters {row['clusters']} vs {case.clusters}"
        )
    return rows


def _ari(a, b) -> float:
    from sklearn.metrics import adjusted_rand_score

    return adjusted_rand_score(a, b)


def summarise(results: dict[str, list[dict]]) -> dict:
    keys = ("maxAbs", "meanAbs", "thresholdDisagreement", "adjustedRand", "voiSplit", "voiMerge")
    summary = {}
    for variant, rows in results.items():
        ok = [r for r in rows if "error" not in r]
        # `cases` alone says whether it ran; a separate flag would be a second spelling of it.
        stats = {k: float(np.mean([r[k] for r in ok])) for k in keys} if ok else {}
        summary[variant] = {"cases": len(ok), **stats}
    return summary


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--repo", type=Path, required=True)
    p.add_argument("--checkpoint", type=Path, required=True)
    p.add_argument("--exported", type=Path, required=True, help="the converter's --out directory")
    p.add_argument("--points", type=int, default=256, help="points per neuron")
    p.add_argument("--neurons", type=int, default=2)
    p.add_argument("--cases", type=int, default=4)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--chunk", type=int, default=16384)
    # Overrides for exploring. Unset means the manifest's value, which is the normative one.
    p.add_argument("--distance-threshold", type=float)
    p.add_argument("--min-cluster-size", type=int)
    p.add_argument("--out", type=Path, help="write the measurements as JSON")
    args = p.parse_args()

    if args.cases < 1 or args.neurons < 1 or args.points < 1 or args.chunk < 1:
        # `--chunk 0` throws from inside the run; a negative one makes `pair_blocks` yield
        # nothing at all, so the probe would cluster and score an uninitialised `np.empty`
        # buffer and exit 0 -- a full set of plausible numbers measured from garbage.
        raise SystemExit("--cases, --neurons, --points and --chunk must all be at least 1")
    if args.out:
        # Checked before a run of tens of minutes, not after: the measurements are the product.
        args.out.parent.mkdir(parents=True, exist_ok=True)

    converter = load_converter(Path(__file__).resolve().parent)

    manifest = json.loads((args.exported / "manifest.json").read_text())
    schema = manifest.get("manifestSchema")
    if schema != converter.MANIFEST_SCHEMA:
        # The converter stamps this precisely so a stale conversion is detectable; not reading
        # it back leaves a bare KeyError, or silently different constants, as the only symptom.
        raise SystemExit(
            f"{args.exported}/manifest.json is schema {schema}, this probe expects "
            f"{converter.MANIFEST_SCHEMA}; reconvert with `pnpm convert:affinity`"
        )
    if manifest.get("randomWeights"):
        # Every quantisation error would be measured against noise and reported as fidelity.
        raise SystemExit(
            f"{args.exported}/manifest.json is a --random-weights export; "
            "convert a real checkpoint before probing it"
        )
    if not manifest["files"]:
        raise SystemExit(f"{args.exported}/manifest.json lists no files")

    # Schema 2 moved the task's own constants under `config`; `src/ml` never reads them.
    config = manifest["config"]
    pre, clus = config["preprocessing"], config["clustering"]
    threshold = args.distance_threshold if args.distance_threshold is not None else clus["threshold"]
    min_size = args.min_cluster_size if args.min_cluster_size is not None else clus["minClusterSize"]
    cut = 1.0 - threshold
    label = partial(cluster, threshold=threshold, min_size=min_size, linkage=clus["linkage"])

    # The probe cannot tell one `.pth` from another, but it can tell when the architecture the
    # converter saw has moved under it -- `Encoder`/`Decoder` reach into `pat` by attribute name,
    # so a different upstream can load, export and measure cleanly while meaning something else.
    here, converter_commit = converter.upstream_commit(args.repo), manifest.get("upstreamCommit")
    if here and converter_commit and here != converter_commit:
        print(
            f"warning: --repo is at {here[:12]}, the manifest was converted from "
            f"{converter_commit[:12]}; the PyTorch reference may not be the exported model"
        )
    pat, models = converter.load_model(
        args.repo, args.checkpoint, config["model"], config["depth"]
    )
    encoder, decoder = converter.Encoder(pat), converter.Decoder(pat, models.pair)

    variants = sorted({e["variant"] for e in manifest["files"]})
    n = args.neurons * args.points
    print(f"{manifest['id']}: {config['model']}, {config['parameters'] / 1e6:.1f}M parameters")
    print(f"variants: {', '.join(variants)}")
    print(
        f"{args.cases} cases, {args.neurons} neurons x {args.points} points = {n}, "
        f"distance t = {threshold} (links above affinity {cut:.2f})\n"
    )

    cases = build_cases(encoder, decoder, np.random.default_rng(args.seed), args, pre, label)
    print()

    # The torch model is 1.52 GB resident and nothing below needs it; the fp32 ORT session alone
    # is another 1.5 GB, and the two peaks would otherwise overlap.
    del encoder, decoder, pat, models
    gc.collect()

    results = {
        variant: compare(
            variant, cases, args.exported, manifest, converter.digest, args, cut, label
        )
        for variant in variants
    }

    summary = summarise(results)
    print("summary, averaged over cases (against fp32 PyTorch):")
    for variant, mean in summary.items():
        if not mean["cases"]:
            print(f"  {variant:7s} no runs completed")
            continue
        print(
            f"  {variant:7s} meanAbs {mean['meanAbs']:.4f}  "
            f"across t {mean['thresholdDisagreement'] * 100:.3f}%  "
            f"ARI {mean['adjustedRand']:.4f}  VOI_s {mean['voiSplit']:.4f}  "
            f"VOI_m {mean['voiMerge']:.4f}"
        )

    if args.out:
        payload = {"config": vars(args), "summary": summary, "cases": results}
        args.out.write_text(json.dumps(payload, indent=2, default=str) + "\n")
        print(f"\nwrote {args.out}")

    # A variant ORT cannot load is a failure, not a quiet row in a report: every other probe in
    # `scripts/` exits nonzero, and Phase 2 chains this behind `pnpm`.
    failed = [v for v, rows in results.items() if any("error" in r for r in rows)]
    if failed:
        print(f"\n{len(failed)} variant(s) did not run: {', '.join(failed)}")
        return 1
    if not any(summary[v]["cases"] for v in summary):
        print("\nnothing was measured")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
