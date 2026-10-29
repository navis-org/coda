#!/usr/bin/env python3
"""
Convert Troidl et al.'s point affinity transformer into the ONNX graphs Coda runs in the browser.

Upstream is https://github.com/jakobtroidl/neuron-shape-reasoning (MIT). The architecture is
*imported from that clone* rather than transcribed here, so what we export is theirs by
construction; the only thing this file knows about it is where to cut it in two.

What each checkpoint *is* -- its training constants, licence and citation -- lives in
`affinity-checkpoints.json`, named by `--checkpoint-id`, and is copied into the manifest
verbatim. This script adds only what it can honestly measure: the files, their sizes and
hashes, and the parameter count. It does not know which connectome a `.pth` was trained on and
must never appear to.

## Why two graphs

`eval_affinity.py` chunks the pair tensor 50 ways and calls `model(pc, mask, chunk)` per chunk,
which re-runs the 24-layer encoder 50 times. The encoder is ~390 GFLOP and the decoder is ~15
MFLOP *per pair*, so on any realistic point count the encoder is a rounding error paid 50 times
over. Splitting it means the latents are computed once and kept, which is also what makes the
paper's query-conditioned mode (affinities of every point against one point) nearly free later.

  encoder(points, mask) -> latents [1, C, D], point_emb [1, N, D]
  decoder(latents, point_emb, pairs) -> affinity [1, P]

`pairs` are *indices*, not gathered features: a pair of gathered features is 2*D floats, so
handing the decoder indices instead of features is a 1024x smaller upload per chunk.

## Quantisation

The checkpoint is ~381M parameters -- 1.52 GB fp32. Which variant the browser can actually *run*
is a WebGPU question this script cannot answer, so it emits candidates and Phase 1 picks:

  fp32    1523 MB  plain MatMul            reference, for the probe to compare against
  fp16     762 MB  plain MatMul            WebGPU-native, but see below
  int8     384 MB  MatMulInteger           dynamic; WebGPU does NOT implement this op
  nbits4   206 MB  MatMulNBits, 4-bit      weight-only, block 128
  nbits8   396 MB  MatMulNBits, 8-bit      weight-only, block 128

Measured (docs/proofread-plan.md): **nbits8 is ~10x more accurate than fp16 at half the size.**
fp16 halves weights, activations and 24 layers of residual accumulation, and the error compounds;
`MatMulNBits` quantises weights only and leaves the arithmetic in fp32. On a deep residual stack
weight-only quantisation beats halving the arithmetic, which is worth remembering for whatever
model comes next.
"""

from __future__ import annotations

import argparse
import gc
import hashlib
import json
import os
import shutil
import subprocess
import sys
import types
import warnings
from pathlib import Path

try:
    import torch
    from torch import nn
except ImportError:  # pragma: no cover - the converter is opt-in
    sys.exit("torch is not installed; see docs/proofread-plan.md for the venv this needs")

CHECKPOINTS = Path(__file__).resolve().parent / "affinity-checkpoints.json"

# Bumped when the shape of the emitted manifest changes, so a stale conversion is detectable
# rather than merely wrong.
MANIFEST_SCHEMA = 1
OPSET = 17
PARTS = ("encoder", "decoder")

# One recipe per *part*, because the parts genuinely want different ones: the decoder is 2% of
# the bytes and ~95% of the runtime (measured, docs/proofread-plan.md), so quantising it to save
# space is the wrong trade while quantising the encoder is the right one. `mixed` is that, and it
# is a row here rather than a rewrite of the loop.
#
# `stage` is per recipe too: `torch` needs the live model (fp16 is exported from a halved copy),
# `onnx` reads the raw fp32 export back off disk. A variant may span both, which `mixed` does.
_NONE = {"stage": "onnx", "kind": "none"}
_FP16 = {"stage": "torch", "kind": "fp16", "io": "fp32"}
_INT8 = {"stage": "onnx", "kind": "dynamic-int8", "ops": ["MatMul"]}
_NBITS4 = {"stage": "onnx", "kind": "nbits", "bits": 4, "blockSize": 128}
_NBITS8 = {"stage": "onnx", "kind": "nbits", "bits": 8, "blockSize": 128}

VARIANTS: dict[str, dict[str, dict]] = {
    "fp32": {"encoder": _NONE, "decoder": _NONE},
    "fp16": {"encoder": _FP16, "decoder": _FP16},
    "int8": {"encoder": _INT8, "decoder": _INT8},
    "nbits4": {"encoder": _NBITS4, "decoder": _NBITS4},
    "nbits8": {"encoder": _NBITS8, "decoder": _NBITS8},
    "mixed": {"encoder": _NBITS8, "decoder": _FP16},
}


def staged(requested: list[str], stage: str) -> list[tuple[str, str]]:
    """Every (variant, part) whose recipe belongs to `stage`, in a stable order."""
    return [(v, part) for v in requested for part in PARTS if VARIANTS[v][part]["stage"] == stage]


# `src/models.py` imports DropPath from timm, which has no parameters and is the identity in
# eval mode. Shimming it keeps this script to torch + onnx rather than pulling timm and
# torchvision in behind it.
def _install_timm_shim() -> None:
    if "timm" in sys.modules:
        return
    try:
        import timm  # noqa: F401

        return
    except ImportError:
        pass

    class DropPath(nn.Module):
        def __init__(self, drop_prob: float = 0.0) -> None:
            super().__init__()
            self.drop_prob = drop_prob

        def forward(self, x):  # eval only; training never happens here
            return x

    timm = types.ModuleType("timm")
    models = types.ModuleType("timm.models")
    layers = types.ModuleType("timm.models.layers")
    layers.DropPath = DropPath
    models.layers = layers
    timm.models = models
    sys.modules["timm"] = timm
    sys.modules["timm.models"] = models
    sys.modules["timm.models.layers"] = layers


def describe(checkpoint_id: str) -> dict:
    """
    The checkpoint's own description, copied into the manifest verbatim.

    A missing id is an error, never a default: this script cannot know which connectome a `.pth`
    was trained on, and a checkpoint that silently inherits another's constants is the exact
    failure `affinity-checkpoints.json` exists to prevent. Add an entry there, reading each
    value off that checkpoint's own upstream train script.
    """
    entries = json.loads(CHECKPOINTS.read_text())["checkpoints"]
    if checkpoint_id not in entries:
        raise SystemExit(
            f"unknown checkpoint id {checkpoint_id!r}; "
            f"{CHECKPOINTS.name} has {', '.join(entries)}"
        )
    card = entries[checkpoint_id]
    # Checked here, not where they are read: a missing constant otherwise surfaces as a bare
    # KeyError in the probe, after a conversion that took minutes.
    required = {
        "model": (), "depth": (), "datasets": (), "license": (), "citation": (), "source": (),
        "preprocessing": ("units", "globalScale", "centre", "samplesPerNeuron", "jitter",
                          "translate", "padValue"),
        "clustering": ("linkage", "threshold", "minClusterSize"),
    }
    for key, fields in required.items():
        if key not in card:
            raise SystemExit(f"{checkpoint_id}: {CHECKPOINTS.name} entry has no {key!r}")
        missing = [f for f in fields if f not in card[key]]
        if missing:
            raise SystemExit(f"{checkpoint_id}: {key} is missing {', '.join(missing)}")
    return card


def upstream_commit(repo: Path) -> str | None:
    """
    Which commit of upstream defined the architecture we just exported.

    `Encoder`/`Decoder` reach into `pat.point_embed`, `pat.encode`, `pat.m_layer_attention`,
    `pat.decoder_cross_attn` and `pat.mlp` by name, so a moved upstream can load, export and
    measure cleanly while meaning something different. Recorded rather than checked -- same role
    as `commit` in `public/wheels/manifest.json`.
    """
    try:
        out = subprocess.run(
            ["git", "-C", str(repo), "rev-parse", "HEAD"],
            capture_output=True, text=True, check=True,
        )
        return out.stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def load_model(repo: Path, checkpoint: Path | None, name: str, depth: int):
    """
    Build upstream's model, optionally with its trained weights.

    `checkpoint=None` gives random weights, which is enough to exercise the export path without
    a 4.5 GB download.
    """
    _install_timm_shim()
    sys.path.insert(0, str(repo))
    import src.models as models  # type: ignore

    model = models.__dict__[name](depth=depth)
    if checkpoint is not None:
        # weights_only stays on -- the checkpoint is a downloaded pickle and `torch.load` on one
        # is arbitrary code execution. It carries the training run's argparse.Namespace next to
        # the state dict, so that one class is allowlisted rather than the protection dropped.
        with torch.serialization.safe_globals([argparse.Namespace]):
            state = torch.load(checkpoint, map_location="cpu", weights_only=True)
        model.load_state_dict(state.get("model", state), strict=True)
    model.eval()
    return model, models


class Encoder(nn.Module):
    """Points to latents. Everything paid once per neuron."""

    def __init__(self, pat: nn.Module) -> None:
        super().__init__()
        self.pat = pat

    def forward(self, points: torch.Tensor, mask: torch.Tensor):
        point_emb = self.pat.point_embed(points)
        latents = self.pat.encode(point_emb, mask.bool())
        latents = self.pat.m_layer_attention(latents)
        return latents, point_emb


class Decoder(nn.Module):
    """Latents plus a chunk of point-index pairs to affinities. Paid once per pair."""

    def __init__(self, pat: nn.Module, pair_fn) -> None:
        super().__init__()
        self.pat = pat
        self._pair = pair_fn

    def forward(self, latents: torch.Tensor, point_emb: torch.Tensor, pairs: torch.Tensor):
        features = self._pair(point_emb, pairs)
        queried = self.pat.decoder_cross_attn(features, context=latents)
        return self.pat.mlp(queried).squeeze(-1)


class HalfIO(nn.Module):
    """
    An fp16 module with fp32 at the boundary.

    fp16 is exported from torch rather than converted from the fp32 ONNX, because
    `onnxconverter_common`'s pass with `keep_io_types=True` leaves the decoder's `norm_context`
    LayerNormalization with one fp32 and one fp16 input, and ORT refuses to load it: "Type
    parameter (T) ... bound to different types". Casting at the boundary in torch and letting the
    exporter type the graph avoids the whole class of problem.

    The boundary stays fp32 so no caller has to build half-precision buffers; requiring
    `Float16Array` at the seam would be a needless constraint.

    Note this wraps an *already halved* module: the encoder and decoder share one `pat`, so it is
    halved once by the caller rather than twice through two wrappers.
    """

    def __init__(self, inner: nn.Module) -> None:
        super().__init__()
        self.inner = inner

    def forward(self, *args):
        cast = tuple(a.half() if a.dtype.is_floating_point else a for a in args)
        out = self.inner(*cast)
        if isinstance(out, tuple):
            return tuple(o.float() if o.dtype.is_floating_point else o for o in out)
        return out.float()


def export(module: nn.Module, args: tuple, path: Path, names: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with torch.no_grad():
        torch.onnx.export(
            module,
            args,
            str(path),
            input_names=names["inputs"],
            output_names=names["outputs"],
            dynamic_axes=names["dynamic"],
            opset_version=OPSET,
            do_constant_folding=True,
            dynamo=False,
        )


def to_int8(src: Path, dst: Path, ops: list[str]) -> None:
    from onnxruntime.quantization import QuantType, quantize_dynamic

    quantize_dynamic(
        str(src),
        str(dst),
        weight_type=QuantType.QInt8,
        op_types_to_quantize=ops,
        extra_options={"MatMulConstBOnly": True},
    )


def to_nbits(src: Path, dst: Path, bits: int, block_size: int) -> None:
    import onnx
    from onnxruntime.quantization import matmul_nbits_quantizer as nb

    config = nb.DefaultWeightOnlyQuantConfig(
        block_size=block_size, is_symmetric=True, bits=bits
    )
    quantizer = nb.MatMulNBitsQuantizer(onnx.load(str(src)), algo_config=config)
    quantizer.process()
    # No external data: a sidecar .onnx.data is a second file to host, hash and cache, and every
    # quantised variant is far below the 2 GB protobuf ceiling. Only fp32 comes near it.
    quantizer.model.save_model_to_file(str(dst), use_external_data_format=False)


def digest(path: Path) -> tuple[str, int]:
    h = hashlib.sha256()
    size = 0
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
            size += len(block)
    return h.hexdigest(), size


def link_or_copy(src: Path, dst: Path) -> None:
    """
    fp32 is the raw export unchanged, so hardlink it rather than moving 1.5 GB twice.

    Falls back to a copy across filesystems. Either way the bytes are identical, so the caller
    reuses the digest instead of hashing them a second time.
    """
    if dst.exists():
        dst.unlink()
    try:
        os.link(src, dst)
    except OSError:
        shutil.copyfile(src, dst)


def refuse_sidecar(path: Path) -> None:
    """
    No export here may spill its weights into a `.onnx.data` sidecar.

    One that did would be a file nobody hosts and the browser cannot find, and `link_or_copy`
    carries only the `.onnx`. Checked on the raw fp32 export too -- at ~1.52 GB it is the one
    nearest the 2 GB protobuf ceiling, and so the one that would spill first.
    """
    sidecar = path.with_name(path.name + ".data")
    if sidecar.exists():
        raise SystemExit(f"{path.name} produced an unexpected sidecar {sidecar.name}")


def entry(variant: str, part: str, path: Path, root: Path) -> dict:
    refuse_sidecar(path)
    sha, size = digest(path)
    return {
        "variant": variant,
        "part": part,
        "file": str(path.relative_to(root)),
        # Filled in once the weights are hosted; the manifest, not a human, owns the address.
        "url": None,
        "bytes": size,
        "sha256": sha,
        "quantisation": VARIANTS[variant][part],
    }


def torch_stage(args, card: dict, requested: list[str]) -> tuple[list[dict], dict, int]:
    """
    Everything that needs the live PyTorch model: the raw fp32 export, and any torch-staged
    variant (fp16, which halves `pat` in place).

    **A function rather than a block in `main`, so that the model is actually released.** The
    1.52 GB model must be gone before the quantisers run -- each holds a source and an output
    graph of its own -- and a `del` at the end of a block does not achieve it: the export loops
    leave `module` and `inputs` bound to the decoder and the traced tensors, which keep `pat`
    alive through the whole variant loop. A frame that returns takes its locals with it.

    Returns plain data only: the manifest entries, the per-part signature, and the parameter
    count. Nothing torch escapes.
    """
    pat, models = load_model(
        args.repo,
        None if args.random_weights else args.checkpoint,
        card["model"],
        card["depth"],
    )
    params = sum(t.numel() for t in pat.parameters())
    print(f"{args.checkpoint_id}: {card['model']}, {params / 1e6:.1f}M parameters")

    n = args.points
    points = torch.randn(1, n, 3).clamp(-1, 1)
    mask = torch.ones(1, n, dtype=torch.bool)
    pair_idx = torch.cartesian_prod(torch.arange(n), torch.arange(n)).unsqueeze(0)

    enc, dec = Encoder(pat), Decoder(pat, models.pair)
    with torch.no_grad():
        latents, point_emb = enc(points, mask)
    print(f"latents {tuple(latents.shape)}  point_emb {tuple(point_emb.shape)}")

    # The signature is part of the artefact, not a detail of the export: whoever feeds these
    # graphs needs the tensor names and which axes are dynamic, and re-typing them in TypeScript
    # is how a renamed output becomes a runtime KeyError nobody connects to the rename.
    signatures = {
        "encoder": (
            enc,
            (points, mask),
            {
                "inputs": ["points", "mask"],
                "outputs": ["latents", "point_emb"],
                "dynamic": {"points": {1: "N"}, "mask": {1: "N"}, "point_emb": {1: "N"}},
            },
        ),
        "decoder": (
            dec,
            (latents, point_emb, pair_idx),
            {
                "inputs": ["latents", "point_emb", "pairs"],
                "outputs": ["affinity"],
                "dynamic": {"point_emb": {1: "N"}, "pairs": {1: "P"}, "affinity": {1: "P"}},
            },
        ),
    }

    # `raw/` is scratch, not an artefact: it is the fp32 export the ONNX-side variants quantise
    # from, it is not listed in the manifest, and the fp32 variant *hardlinks* it -- so measuring
    # or uploading `--out` wholesale double-counts about 1.5 GB. Skipped entirely when nothing
    # downstream of it was asked for.
    raw = args.out / "raw"
    # Only the parts something quantises from; `mixed` needs the raw encoder and not the decoder.
    for part in [p for p in PARTS if any(q == p for _, q in staged(requested, "onnx"))]:
        module, inputs, names = signatures[part]
        export(module, inputs, raw / f"{part}.onnx", names)
        refuse_sidecar(raw / f"{part}.onnx")

    entries = []
    torch_parts = staged(requested, "torch")
    if torch_parts:
        # After the raw export, never before: halving is in place and both parts share `pat`.
        pat.half()
        for variant, part in torch_parts:
            module, inputs, names = signatures[part]
            dst = args.out / variant / f"{part}.onnx"
            dst.parent.mkdir(parents=True, exist_ok=True)
            export(HalfIO(module), inputs, dst, names)
            record = entry(variant, part, dst, args.out)
            entries.append(record)
            print(f"{variant}/{part}: {record['bytes'] / 1e6:.1f} MB")

    return entries, {part: signatures[part][2] for part in PARTS}, params


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--repo", type=Path, required=True, help="clone of neuron-shape-reasoning")
    p.add_argument("--checkpoint", type=Path, help="omit with --random-weights")
    p.add_argument(
        "--checkpoint-id",
        required=True,
        help=f"an id in {CHECKPOINTS.name}: what this checkpoint is and how it was trained",
    )
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--points", type=int, default=64, help="tracing size only; N stays dynamic")
    p.add_argument(
        "--variants",
        default=",".join(VARIANTS),
        help=f"comma-separated: {', '.join(VARIANTS)}",
    )
    p.add_argument("--random-weights", action="store_true", help="skip the checkpoint; shape test")
    args = p.parse_args()

    # Every argument check before the 4.5 GB load: a typo in --variants should fail in a second,
    # not after a checkpoint read and a trace export.
    if args.random_weights and args.checkpoint is not None:
        # Otherwise the checkpoint is silently ignored and the output looks like a real one.
        raise SystemExit("--random-weights and --checkpoint are mutually exclusive")
    if not args.random_weights and args.checkpoint is None:
        raise SystemExit("--checkpoint is required unless --random-weights is given")
    if args.points < 1:
        raise SystemExit("--points must be at least 1")
    # dict.fromkeys: de-duplicated, order preserved. A repeated name would otherwise export and
    # quantise twice and write duplicate manifest entries, which the probe's `set` then hides.
    requested = list(dict.fromkeys(v.strip() for v in args.variants.split(",") if v.strip()))
    unknown = [v for v in requested if v not in VARIANTS]
    if unknown:
        raise SystemExit(f"unknown variant(s): {', '.join(unknown)}; have {', '.join(VARIANTS)}")
    if not requested:
        # Otherwise the run loads 4.5 GB, exports nothing, and writes a manifest carrying the
        # full citation and training constants with an empty `files` -- which looks like a
        # conversion that happened.
        raise SystemExit(f"--variants is empty; have {', '.join(VARIANTS)}")
    card = describe(args.checkpoint_id)

    raw = args.out / "raw"
    entries, signatures_record, params = torch_stage(args, card, requested)

    # Everything torch-side died with `torch_stage`'s frame. A `del` in `main` could not do this:
    # the export loops leak their `module` and `inputs` names, which still reference `pat` and
    # the traced tensors, so the collection frees nothing and the peak happens anyway.
    gc.collect()

    for variant, part in staged(requested, "onnx"):
        recipe = VARIANTS[variant][part]
        src, dst = raw / f"{part}.onnx", args.out / variant / f"{part}.onnx"
        dst.parent.mkdir(parents=True, exist_ok=True)
        if recipe["kind"] == "none":
            link_or_copy(src, dst)
        elif recipe["kind"] == "dynamic-int8":
            to_int8(src, dst, recipe["ops"])
        else:
            to_nbits(src, dst, bits=recipe["bits"], block_size=recipe["blockSize"])
        record = entry(variant, part, dst, args.out)
        entries.append(record)
        print(f"{variant}/{part}: {record['bytes'] / 1e6:.1f} MB")

    manifest = {
        # `card` is spread first: a checkpoint entry carrying `id` or `manifestSchema` must not
        # be able to override them, or the staleness check reports whatever the entry says.
        **card,
        "id": args.checkpoint_id,
        "manifestSchema": MANIFEST_SCHEMA,
        "parameters": params,
        "opset": OPSET,
        # A shape test carries every other field of a real conversion -- citation, licence,
        # training constants, parameter count -- so without this the two are indistinguishable
        # and a random-weight export could be hosted by mistake.
        "randomWeights": bool(args.random_weights),
        "upstreamCommit": upstream_commit(args.repo),
        "signatures": {part: signatures_record[part] for part in PARTS},
        "files": entries,
    }
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"\nwrote {args.out / 'manifest.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
