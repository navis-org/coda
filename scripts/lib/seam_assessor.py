#!/usr/bin/env python3
"""The numpy half of the assessor probes: SEAM's own files, and the comparison.

`seam_e_cells.py`'s arrangement, and it is here for the same reason. What a browser
cannot do is read `probe_fixture.npz`, `patches/<end_uid>.npz` and `lists.parquet`;
those stay in numpy and pandas, where SEAM wrote them, rather than growing a second
reader in JavaScript for files that are the reference.

    python3 -I scripts/lib/seam_assessor.py probe <onnx dir> <out dir>
    python3 -I scripts/lib/seam_assessor.py lists <onnx dir> <out dir> <end_uid>...
    <seam venv>/bin/python scripts/lib/seam_assessor.py native <onnx dir> <work dir> <end_uid>
    <seam venv>/bin/python scripts/lib/seam_assessor.py conv

`native` and `conv` need onnxruntime and torch, which Coda does not depend on — they run
from SEAM's own virtualenv and exist to place a browser number against this machine's.

`probe` prepares the op probe's input: it checks `probe.onnx` and `probe_fixture.npz`
against `manifest.json`'s sha256 — a model served from the wrong directory answers
perfectly plausibly — and writes

- `lab.u8`, the two patches as raw bytes, `n * 129^3` of 0, 1 and 2. **uint8, not the
  float32 the graph takes**: the cast is four lines in the page and a quarter of the
  bytes over the wire (4.3 MB against 17 MB), and the page has to build a typed array
  either way.
- `probe-fixture.json`, PyTorch's logits and the shape to read `lab.u8` with.
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import numpy as np


def digest(path: Path) -> str:
    sha = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            sha.update(block)
    return sha.hexdigest()


def checked(src: Path, name: str, want: str) -> Path:
    """One file of SEAM's export, refused unless it is the one the manifest names."""
    path = src / name
    if not path.exists():
        raise SystemExit(f"{src} has no {name}")
    got = digest(path)
    if got != want:
        raise SystemExit(
            f"{name} is not the file manifest.json names (sha256 {got[:12]}… against "
            f"{want[:12]}…). A model from another export answers plausibly; refusing."
        )
    return path


def prepare_probe(src: Path, out: Path) -> None:
    manifest = json.loads((src / "manifest.json").read_text())
    probe = manifest["probe"]
    checked(src, probe["file"], probe["sha256"])
    fixture_name = probe["fixture"].split(":")[0].strip()
    fixture = checked(src, fixture_name, manifest["files"][fixture_name])

    held = np.load(fixture)
    lab, logit = held["lab"], held["logit"]
    if lab.dtype != np.uint8 or lab.ndim != 4 or len(set(lab.shape[1:])) != 1:
        raise SystemExit(f"{fixture_name}'s lab is {lab.dtype} {lab.shape}, not uint8 (n, s, s, s)")
    values = sorted(int(v) for v in np.unique(lab))
    if not set(values) <= {0, 1, 2}:
        raise SystemExit(f"{fixture_name}'s lab holds {values}, not only 0, 1 and 2")

    out.mkdir(parents=True, exist_ok=True)
    (out / "lab.u8").write_bytes(lab.tobytes(order="C"))
    (out / "probe-fixture.json").write_text(
        json.dumps(
            {
                "what": "the op probe's input and PyTorch's answer, from SEAM's probe_fixture.npz",
                "patches": int(lab.shape[0]),
                "size": int(lab.shape[1]),
                "values": values,
                "logit": [float(v) for v in logit],
                "ops": probe["ops"],
                "ort": probe["ort"],
                "gflop_per_patch": probe["gflop_per_patch"],
                "cpu_s_per_patch": probe["check"]["ort_cpu_s_per_patch"],
                "max_abs_vs_torch": probe["check"]["max_abs_vs_torch"],
                "commit": manifest["commit"],
            },
            indent=1,
        )
        + "\n"
    )
    print(
        f"{lab.shape[0]} patches of {lab.shape[1]}^3, values {values}; "
        f"PyTorch {[round(float(v), 6) for v in logit]}"
    )


def prepare_lists(src: Path, out: Path, ends: list[int]) -> None:
    """One or more real lists, for the parity probe: the patches, and SEAM's own answers.

    Written per end rather than all at once on purpose. `lists.parquet` covers 1,387
    candidates and a 129^3 patch is 2.1 MB, so the whole fixture is 2.9 GB — more than a
    browser will hold, let alone a fetch. A caller names the ends it wants.
    """
    import pandas as pd

    manifest = json.loads((src / "manifest.json").read_text())
    checked(src, "lists.parquet", manifest["files"]["lists.parquet"])
    held = pd.read_parquet(src / "lists.parquet")

    out.mkdir(parents=True, exist_ok=True)
    wanted = []
    for end in ends:
        rows = held[held.end_uid == end].sort_values("i").reset_index(drop=True)
        if rows.empty:
            raise SystemExit(f"lists.parquet has no end {end}")
        name = f"patches/{end}.npz"
        patches = np.load(checked(src, name, manifest["files"][name]))["lab"]
        if len(patches) != len(rows):
            raise SystemExit(
                f"end {end} has {len(patches)} patches and {len(rows)} rows; "
                "the npz and lists.parquet disagree, so nothing could be joined"
            )
        if list(rows.i) != list(range(len(rows))):
            # The patches are stored in `i` order, so a gap would silently pair a candidate
            # with another one's patch -- every logit plausible, every one of them wrong.
            raise SystemExit(f"end {end}'s `i` is not 0..n-1; the patch order cannot be trusted")
        (out / f"{end}.u8").write_bytes(patches.tobytes(order="C"))
        wanted.append(
            {
                "end_uid": int(end),
                "patches": int(len(rows)),
                "size": int(patches.shape[1]),
                "cand_root": [str(r) for r in rows.cand_root],
                # The query neuron and each patch's centre, for a probe that cuts the patches
                # itself rather than reading SEAM's. `str`, never a float: an 18-digit root
                # through a double is a different neuron (Coda's invariant 8, SEAM's 1).
                "neuron": str(rows.neuron.iloc[0]),
                "contact_nm": [
                    [float(r.contact_x_nm), float(r.contact_y_nm), float(r.contact_z_nm)]
                    for r in rows.itertuples()
                ],
                # The reference, and still `torch_s<k>` rather than `stored_s<k>` although the
                # za refit rescored the cluster in fp32: `torch` is the number the parity rule
                # is written against. The two are now close enough that SEAM's own
                # `cluster_fp32` passes that rule (q within 3.5e-4), which it did not under
                # bf16 -- a stored score used to miss an exact fp32 browser by about a logit.
                "torch": [[float(v) for v in rows[f"torch_s{k}"]] for k in range(3)],
                # Neither is read by a probe, and both are here on purpose: `lists.json` is
                # also something a human opens when a browser's number looks wrong, and the
                # first question is always "wrong against what". `ort_cpu` says what the same
                # graph answers on a CPU, `stored` what the cluster actually recorded.
                "ort_cpu": [[float(v) for v in rows[f"ort_s{k}"]] for k in range(3)],
                "stored": [[float(v) for v in rows[f"stored_s{k}"]] for k in range(3)],
            }
        )
    (out / "lists.json").write_text(
        json.dumps(
            {
                "what": "real lists from SEAM's assessor fixture: patches, and PyTorch's logits",
                "reference": "torch",
                "lists": wanted,
                "commit": manifest["commit"],
                # Which suggestion set the patches were cut from. A probe comparing against
                # them byte for byte has no allowance left, so the one thing a reader needs
                # when a comparison fails is whether this checkout is the set SEAM recut.
                "set": manifest["fixture"]["set"],
            },
            indent=1,
        )
        + "\n"
    )
    total = sum(one["patches"] for one in wanted)
    print(f"{len(wanted)} list(s), {total} patches ({total * 129 ** 3 / 1e6:.0f} MB of labels)")


def native(src: Path, work: Path, end: int, runs: int = 2) -> None:
    """The same graph and the same patches, in Python on this machine.

    The browser numbers alone cannot say whether 1.1 s a patch is this laptop's GPU or
    onnxruntime-web's kernels, because the only Python figure to hand is a **CPU** one.
    This runs both of Python's providers over the patches `lists` already wrote, so the
    comparison is one machine, one graph, one input, three backends.

    **CoreML's node placement is reported, not assumed**, for the reason the browser probe
    is built around: an op the provider cannot take falls back to the CPU, answers
    correctly, and leaves a timing that means nothing. 3D convolution is exactly the op
    that might not be taken.
    """
    import contextlib
    import os
    import tempfile
    import time

    import onnxruntime as ort

    @contextlib.contextmanager
    def captured_stderr():
        """ORT's log is written from C++ to **file descriptor 2**, so a Python-level
        `redirect_stderr` sees none of it — the first run of this reported every placement
        as unknown. Redirecting the descriptor itself is what catches it, and the placement
        is the whole point: a provider that quietly declines the 3D convolutions falls back
        to the CPU, answers correctly, and leaves a timing that means nothing."""
        held: list[str] = []
        with tempfile.TemporaryFile(mode="w+") as sink:
            saved = os.dup(2)
            os.dup2(sink.fileno(), 2)
            try:
                yield held
            finally:
                os.dup2(saved, 2)
                os.close(saved)
                # Read **before** the temp file closes: filling the list in the caller after
                # the block has ended gets "I/O operation on closed file", which this did.
                sink.seek(0)
                held.append(sink.read())

    manifest = json.loads((src / "manifest.json").read_text())
    model = checked(src, "sa2_mask_s0.onnx", manifest["models"][0]["sha256"])
    listed = json.loads((work / "lists.json").read_text())
    one = next((l for l in listed["lists"] if l["end_uid"] == end), None)
    if one is None:
        raise SystemExit(f"{work}/lists.json has no end {end}; run the `lists` command for it")
    size, count = one["size"], one["patches"]
    lab = np.frombuffer((work / f"{end}.u8").read_bytes(), dtype=np.uint8)
    lab = lab.reshape(count, size, size, size).astype(np.float32)
    torch = np.asarray(one["torch"][0], dtype=np.float64)

    for provider in ("CPUExecutionProvider", "CoreMLExecutionProvider"):
        options = ort.SessionOptions()
        options.log_severity_level = 0  # the placement verdict is only printed at verbose
        # CoreML picks its own compute unit otherwise, and "it ran on the GPU" would be a
        # guess. Asking for GPU explicitly makes the comparison the one being claimed.
        settings = {"MLComputeUnits": "CPUAndGPU"} if "CoreML" in provider else {}
        text = ""
        try:
            with captured_stderr() as held:
                session = ort.InferenceSession(
                    str(model), options, providers=[provider], provider_options=[settings]
                )
            text = held[0]
        except Exception as error:  # a provider may refuse the graph outright
            print(f"{provider}: refused the graph -- {error}")
            continue
        name = session.get_inputs()[0].name
        got = session.run(None, {name: lab})[0]  # warm
        best = None
        for _ in range(runs):
            started = time.perf_counter()
            got = session.run(None, {name: lab})[0]
            took = time.perf_counter() - started
            best = took if best is None else min(best, took)
        worst = float(np.max(np.abs(np.asarray(got, dtype=np.float64) - torch)))
        placed = [
            l.split("VerifyEachNodeIsAssignedToAnEp]")[-1].strip()
            for l in text.splitlines()
            if "VerifyEachNodeIsAssignedToAnEp" in l
        ]
        # `Node placements` is a bare header; the verdict is the line after it.
        rest = [l for l in placed if l and l != "Node placements"]
        where = "; ".join(rest) if rest else "not reported"
        print(
            f"{provider:28} {best / count * 1000:7.0f} ms a patch over {count} patches, "
            f"max error {worst:.2e}"
        )
        print(f"{'':28} placement: {where[:110]}")


# The two convolution shapes SEAM names as two-thirds of a patch's cost: the stem, and a
# stage-0 residual block's 3x3x3. Taken from `sa2_mask_s0.onnx`'s own graph.
CONVS = (
    ("conv1  64x2x7^3 s2 on 129^3", 2, 64, 7, 2, 129),
    ("stage0 64x64x3^3 s1 on 65^3", 64, 64, 3, 1, 65),
)


def conv(runs: int = 5) -> None:
    """What this machine's GPU can do on a 3D convolution, in PyTorch.

    The missing leg of the comparison. onnxruntime's CoreML provider declines most of this
    graph (25 of 90 nodes), so its timing is a hybrid and says nothing about the GPU; and
    the browser number alone cannot tell "this laptop is bad at 3D convolutions" from
    "onnxruntime-web's WebGPU kernels are slow". A single convolution through Metal, against
    the same one on the CPU, separates them.
    """
    import time

    import torch

    print(f"torch {torch.__version__}, mps available: {torch.backends.mps.is_available()}")
    for label, cin, cout, k, stride, size in CONVS:
        row = [label]
        for device in ("cpu", "mps"):
            if device == "mps" and not torch.backends.mps.is_available():
                continue
            torch.manual_seed(0)
            layer = torch.nn.Conv3d(cin, cout, k, stride=stride, padding=k // 2)
            layer = layer.to(device).eval()
            x = torch.randn(1, cin, size, size, size, device=device)
            # Without the sync the GPU timing is the cost of *queueing* the work, which on
            # Metal comes back in microseconds and looks like a hundredfold speedup.
            sync = torch.mps.synchronize if device == "mps" else (lambda: None)
            with torch.no_grad():
                out = layer(x)
                sync()
                best = None
                for _ in range(runs):
                    started = time.perf_counter()
                    out = layer(x)
                    sync()
                    took = time.perf_counter() - started
                    best = took if best is None else min(best, took)
            flop = 2 * cout * cin * k**3 * out.shape[-1] * out.shape[-2] * out.shape[-3]
            row.append(f"{device} {best * 1000:7.1f} ms = {flop / best / 1e12:6.2f} TFLOP/s")
        print("  " + "   ".join(row))


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    command = sys.argv[1]
    if command == "probe":
        prepare_probe(Path(sys.argv[2]), Path(sys.argv[3]))
    elif command == "lists":
        prepare_lists(Path(sys.argv[2]), Path(sys.argv[3]), [int(v) for v in sys.argv[4:]])
    elif command == "native":
        native(Path(sys.argv[2]), Path(sys.argv[3]), int(sys.argv[4]))
    elif command == "conv":
        conv()
    else:
        raise SystemExit(f"no such command: {command}")


if __name__ == "__main__":
    main()
