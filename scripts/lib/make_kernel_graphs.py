#!/usr/bin/env python3
"""The one-node graphs `probe-ort-kernels.mjs` times. Needs only `onnx`.

Three graphs, each a single node, so that a timing is a kernel's and nothing else's:
a square `MatMul`, a 3x3x3 `Conv` and a 1x1x1 `Conv` on the same tensor. The third is
the load-bearing one -- it is arithmetically a matrix multiply, so if it is as slow as
the 3x3x3 then the cost is the `Conv` path itself rather than the sliding window.
"""

import sys
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
rng = np.random.default_rng(0)
# onnxruntime-web 1.31 reads IR 13 at most, while onnx 1.23 writes 14 by default and the
# refusal names the version rather than the cause.
IR = 10


def save(model, name):
    model.ir_version = IR
    onnx.checker.check_model(model)
    onnx.save(model, out / name)


N, C, S = 2048, 64, 65
w = (rng.standard_normal((N, N)) * 0.01).astype(np.float32)
save(
    helper.make_model(
        helper.make_graph(
            [helper.make_node("MatMul", ["x", "w"], ["y"])],
            "matmul",
            [helper.make_tensor_value_info("x", TensorProto.FLOAT, [N, N])],
            [helper.make_tensor_value_info("y", TensorProto.FLOAT, [N, N])],
            [helper.make_tensor("w", TensorProto.FLOAT, [N, N], w.ravel().tolist())],
        ),
        opset_imports=[helper.make_opsetid("", 17)],
    ),
    "matmul.onnx",
)

WEIGHTS = {}
for k, name in ((3, "conv3.onnx"), (1, "conv1.onnx")):
    kw = (rng.standard_normal((C, C, k, k, k)) * 0.01).astype(np.float32)
    WEIGHTS[k] = kw
    save(
        helper.make_model(
            helper.make_graph(
                [
                    helper.make_node(
                        "Conv",
                        ["x", "w"],
                        ["y"],
                        kernel_shape=[k] * 3,
                        pads=[k // 2] * 6,
                        strides=[1] * 3,
                    )
                ],
                name.removesuffix(".onnx"),
                [helper.make_tensor_value_info("x", TensorProto.FLOAT, [1, C, S, S, S])],
                [helper.make_tensor_value_info("y", TensorProto.FLOAT, [1, C, S, S, S])],
                [helper.make_tensor("w", TensorProto.FLOAT, list(kw.shape), kw.ravel().tolist())],
            ),
            opset_imports=[helper.make_opsetid("", 17)],
        ),
        name,
    )

print(f"wrote matmul.onnx, conv3.onnx, conv1.onnx to {out}")


# ── The rewrite: the same convolutions expressed as MatMul ──────────────────────────────────
#
# `Conv` over 5-D tensors runs ~21x below this backend's own `MatMul` for identical arithmetic
# (probe-ort-kernels), so the question is whether the graph can simply stop using it. Both
# rewrites below carry **the same weights** as the plain versions above, so the probe compares
# answers as well as times -- a fast wrong graph is worth nothing, and a transposed reshape is
# the obvious way to get one.
#
# The layout trick is the whole thing. A convolution's input is (N, C, X, Y, Z) with C *not*
# adjacent to the spatial axes in the way a matrix multiply wants, so each rewrite reshapes
# (1, C, X, Y, Z) to (C, X*Y*Z) -- channels as rows, voxels as columns -- multiplies by the
# (Cout, Cin) weight matrix, and reshapes back. No transpose is needed because C is already the
# outermost axis after the batch.


def pointwise_as_matmul(c: int, s: int, weight: np.ndarray) -> onnx.ModelProto:
    """A 1x1x1 convolution as one matrix multiply. The clean case: no neighbourhood."""
    voxels = s**3
    nodes = [
        helper.make_node("Reshape", ["x", "flat"], ["x2"]),
        helper.make_node("MatMul", ["w2", "x2"], ["y2"]),
        helper.make_node("Reshape", ["y2", "cube"], ["y"]),
    ]
    inits = [
        helper.make_tensor("flat", TensorProto.INT64, [2], [c, voxels]),
        helper.make_tensor("cube", TensorProto.INT64, [5], [1, c, s, s, s]),
        helper.make_tensor("w2", TensorProto.FLOAT, [c, c], weight.reshape(c, c).ravel().tolist()),
    ]
    return helper.make_model(
        helper.make_graph(
            nodes,
            "pointwise_matmul",
            [helper.make_tensor_value_info("x", TensorProto.FLOAT, [1, c, s, s, s])],
            [helper.make_tensor_value_info("y", TensorProto.FLOAT, [1, c, s, s, s])],
            inits,
        ),
        opset_imports=[helper.make_opsetid("", 17)],
    )


def conv3_as_matmuls(c: int, s: int, weight: np.ndarray) -> onnx.ModelProto:
    """A 3x3x3 convolution as 27 shifted matrix multiplies, summed.

    out[co, v] = sum over the 27 offsets of W[offset] @ shifted(in)[:, v]. Each W[offset] is a
    (Cout, Cin) matrix, so each term is exactly the pointwise case above on an input shifted by
    one voxel.

    **Why 27 terms and not one big im2col.** Stacking the 27 shifted copies into a single
    (Cin*27, voxels) matrix would make this one matrix multiply -- the textbook form, and the
    fastest -- but at 64*27 x 65^3 floats that intermediate is 1.9 GB. Accumulating 27 terms
    keeps the memory flat and pays for it in passes over the tensor, which is the trade this
    probe exists to measure.
    """
    voxels = s**3
    pad = [0, 0, 1, 1, 1, 0, 0, 1, 1, 1]  # N and C untouched, one voxel each spatial side
    nodes = [
        helper.make_node("Pad", ["x", "pads", "zero"], ["xp"], mode="constant"),
    ]
    inits = [
        helper.make_tensor("pads", TensorProto.INT64, [10], pad),
        helper.make_tensor("zero", TensorProto.FLOAT, [], [0.0]),
        helper.make_tensor("flat", TensorProto.INT64, [2], [c, voxels]),
        helper.make_tensor("cube", TensorProto.INT64, [5], [1, c, s, s, s]),
    ]
    running = None
    for i, (dx, dy, dz) in enumerate(
        (dx, dy, dz) for dx in range(3) for dy in range(3) for dz in range(3)
    ):
        tag = f"o{i}"
        inits += [
            helper.make_tensor(f"{tag}s", TensorProto.INT64, [3], [dx, dy, dz]),
            helper.make_tensor(f"{tag}e", TensorProto.INT64, [3], [dx + s, dy + s, dz + s]),
            helper.make_tensor(f"{tag}a", TensorProto.INT64, [3], [2, 3, 4]),
            helper.make_tensor(
                f"{tag}w",
                TensorProto.FLOAT,
                [c, c],
                weight[:, :, dx, dy, dz].reshape(c, c).ravel().tolist(),
            ),
        ]
        nodes += [
            helper.make_node("Slice", ["xp", f"{tag}s", f"{tag}e", f"{tag}a"], [f"{tag}c"]),
            helper.make_node("Reshape", [f"{tag}c", "flat"], [f"{tag}f"]),
            helper.make_node("MatMul", [f"{tag}w", f"{tag}f"], [f"{tag}m"]),
        ]
        if running is None:
            running = f"{tag}m"
        else:
            nodes.append(helper.make_node("Add", [running, f"{tag}m"], [f"{tag}sum"]))
            running = f"{tag}sum"
    nodes.append(helper.make_node("Reshape", [running, "cube"], ["y"]))
    return helper.make_model(
        helper.make_graph(
            nodes,
            "conv3_matmul",
            [helper.make_tensor_value_info("x", TensorProto.FLOAT, [1, c, s, s, s])],
            [helper.make_tensor_value_info("y", TensorProto.FLOAT, [1, c, s, s, s])],
            inits,
        ),
        opset_imports=[helper.make_opsetid("", 17)],
    )


save(pointwise_as_matmul(C, S, WEIGHTS[1]), "conv1_matmul.onnx")
save(conv3_as_matmuls(C, S, WEIGHTS[3]), "conv3_matmul.onnx")
print("wrote conv1_matmul.onnx, conv3_matmul.onnx")


def conv3_grouped(c: int, s: int, weight: np.ndarray, per: int) -> onnx.ModelProto:
    """The 3x3x3 convolution as 27/`per` matrix multiplies, each over `per` offsets at once.

    The 27-term version is memory-bound, not compute-bound: each term reads the whole tensor to
    do 64 multiply-adds a voxel, and the 1x1x1 measurement puts that floor at ~30 ms however the
    arithmetic is expressed. Concatenating `per` shifted copies along the channel axis before
    multiplying trades one materialised copy for `per` passes -- K goes from 64 to 64*`per`, and
    the same arithmetic is done with fewer trips over the data.

    `per` = 27 would be the textbook single im2col matmul; at 64*27 x 65^3 floats its
    intermediate is 1.9 GB, which is why this is a knob rather than a constant.
    """
    voxels, offsets = s**3, [(dx, dy, dz) for dx in range(3) for dy in range(3) for dz in range(3)]
    nodes = [helper.make_node("Pad", ["x", "pads", "zero"], ["xp"], mode="constant")]
    inits = [
        helper.make_tensor("pads", TensorProto.INT64, [10], [0, 0, 1, 1, 1, 0, 0, 1, 1, 1]),
        helper.make_tensor("zero", TensorProto.FLOAT, [], [0.0]),
        helper.make_tensor("cube", TensorProto.INT64, [5], [1, c, s, s, s]),
    ]
    running = None
    for g in range(0, len(offsets), per):
        chunk = offsets[g : g + per]
        tag = f"g{g}"
        parts = []
        for i, (dx, dy, dz) in enumerate(chunk):
            at = f"{tag}_{i}"
            inits += [
                helper.make_tensor(f"{at}s", TensorProto.INT64, [3], [dx, dy, dz]),
                helper.make_tensor(f"{at}e", TensorProto.INT64, [3], [dx + s, dy + s, dz + s]),
                helper.make_tensor(f"{at}a", TensorProto.INT64, [3], [2, 3, 4]),
            ]
            nodes.append(
                helper.make_node("Slice", ["xp", f"{at}s", f"{at}e", f"{at}a"], [f"{at}c"])
            )
            parts.append(f"{at}c")
        # Concatenated on the channel axis, so the flattened rows line up with the weight
        # matrix built in the same offset order below.
        inits.append(
            helper.make_tensor(f"{tag}flat", TensorProto.INT64, [2], [c * len(chunk), voxels])
        )
        stacked = np.concatenate([weight[:, :, dx, dy, dz] for dx, dy, dz in chunk], axis=1)
        inits.append(
            helper.make_tensor(
                f"{tag}w", TensorProto.FLOAT, list(stacked.shape), stacked.ravel().tolist()
            )
        )
        nodes += [
            helper.make_node("Concat", parts, [f"{tag}cat"], axis=1),
            helper.make_node("Reshape", [f"{tag}cat", f"{tag}flat"], [f"{tag}f"]),
            helper.make_node("MatMul", [f"{tag}w", f"{tag}f"], [f"{tag}m"]),
        ]
        if running is None:
            running = f"{tag}m"
        else:
            nodes.append(helper.make_node("Add", [running, f"{tag}m"], [f"{tag}sum"]))
            running = f"{tag}sum"
    nodes.append(helper.make_node("Reshape", [running, "cube"], ["y"]))
    return helper.make_model(
        helper.make_graph(
            nodes,
            f"conv3_grouped{per}",
            [helper.make_tensor_value_info("x", TensorProto.FLOAT, [1, c, s, s, s])],
            [helper.make_tensor_value_info("y", TensorProto.FLOAT, [1, c, s, s, s])],
            inits,
        ),
        opset_imports=[helper.make_opsetid("", 17)],
    )


for per in (3, 9):
    save(conv3_grouped(C, S, WEIGHTS[3], per), f"conv3_group{per}.onnx")
print("wrote conv3_group3.onnx, conv3_group9.onnx")


def conv3_gemm(c: int, s: int, weight: np.ndarray) -> onnx.ModelProto:
    """The 27-term rewrite with the 26 `Add` nodes folded into the multiplies.

    The accumulation, not the arithmetic, is what the 27-term form spends its time on: each
    `Add` reads two full (Cout, voxels) tensors and writes a third, 26 times a convolution.
    `Gemm` computes alpha*A*B + beta*C in one node, so passing the running sum as C removes
    every one of those passes and leaves the same answer.
    """
    voxels = s**3
    nodes = [helper.make_node("Pad", ["x", "pads", "zero"], ["xp"], mode="constant")]
    inits = [
        helper.make_tensor("pads", TensorProto.INT64, [10], [0, 0, 1, 1, 1, 0, 0, 1, 1, 1]),
        helper.make_tensor("zero", TensorProto.FLOAT, [], [0.0]),
        helper.make_tensor("flat", TensorProto.INT64, [2], [c, voxels]),
        helper.make_tensor("cube", TensorProto.INT64, [5], [1, c, s, s, s]),
    ]
    running = None
    for i, (dx, dy, dz) in enumerate(
        (a, b, d) for a in range(3) for b in range(3) for d in range(3)
    ):
        at = f"o{i}"
        inits += [
            helper.make_tensor(f"{at}s", TensorProto.INT64, [3], [dx, dy, dz]),
            helper.make_tensor(f"{at}e", TensorProto.INT64, [3], [dx + s, dy + s, dz + s]),
            helper.make_tensor(f"{at}a", TensorProto.INT64, [3], [2, 3, 4]),
            helper.make_tensor(
                f"{at}w",
                TensorProto.FLOAT,
                [c, c],
                weight[:, :, dx, dy, dz].reshape(c, c).ravel().tolist(),
            ),
        ]
        nodes += [
            helper.make_node("Slice", ["xp", f"{at}s", f"{at}e", f"{at}a"], [f"{at}c"]),
            helper.make_node("Reshape", [f"{at}c", "flat"], [f"{at}f"]),
        ]
        if running is None:
            nodes.append(helper.make_node("MatMul", [f"{at}w", f"{at}f"], [f"{at}m"]))
        else:
            nodes.append(
                helper.make_node("Gemm", [f"{at}w", f"{at}f", running], [f"{at}m"], beta=1.0)
            )
        running = f"{at}m"
    nodes.append(helper.make_node("Reshape", [running, "cube"], ["y"]))
    return helper.make_model(
        helper.make_graph(
            nodes,
            "conv3_gemm",
            [helper.make_tensor_value_info("x", TensorProto.FLOAT, [1, c, s, s, s])],
            [helper.make_tensor_value_info("y", TensorProto.FLOAT, [1, c, s, s, s])],
            inits,
        ),
        opset_imports=[helper.make_opsetid("", 17)],
    )


save(conv3_gemm(C, S, WEIGHTS[3]), "conv3_gemm.onnx")
print("wrote conv3_gemm.onnx")
