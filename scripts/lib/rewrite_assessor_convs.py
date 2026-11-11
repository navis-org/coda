"""Rewrite an assessor's stride-1 3x3x3 convolutions as 27 accumulated matrix multiplies.

    <seam venv>/bin/python scripts/lib/rewrite_assessor_convs.py <in.onnx> <out.onnx> <shapes.json>

**Measured, on sa2_mask_s0 and a real patch: 1,131 ms a patch to 136, and every logit of an
18-candidate list is unchanged (1.7e-5 against the original, ranking identical).** onnxruntime-web's `Conv` path over 5-D tensors runs ~25x below the same
backend's own `MatMul` for identical arithmetic (`pnpm probe:ort-kernels`), and 3x3x3
convolutions are 61% of a patch. So the fastest available fix is to stop using that kernel.

Each convolution becomes: for each of the 27 one-voxel offsets, slice the (already padded)
input, flatten it to (channels, voxels), multiply by that offset's (out, in) weight matrix, and
sum. Arithmetically identical, 27 small matrix multiplies instead of one convolution.

Two paths, by kernel size. **3x3x3 convolutions** become 27 shifted multiplies, one per offset;
stride is free, since `Slice` takes a step. **Larger kernels** — the 7x7x7 stem — would be 343
such terms, each a (64, 2) x (2, voxels) multiply, which is 343 passes over the tensor to do two
multiply-adds a voxel and is slower than the kernel it replaces; those go through grouped im2col
instead, gathering `GROUP` taps into one wide matrix. All 17 of sa2_mask's convolutions with a
kernel bigger than 1 are rewritten.

**Why 27 separate multiplies and not one im2col.** Stacking the offsets would make this a single
matrix multiply -- the textbook form -- but the intermediate is gigabytes. Grouping a few at a
time was measured and is *worse* (9 groups 5.6x, 3 groups 4.8x, against 6.8x ungrouped): the
`Concat` costs more than the saved passes.

**Batch 1 only.** A (N, C, X, Y, Z) tensor flattens to (C, voxels) only when N is 1; otherwise
the channel and batch axes interleave and the reshape is wrong. The rewritten model therefore
pins its batch axis to 1, so a larger batch is refused when the session is built rather than
answered incorrectly. Nothing is lost: batch size does not change throughput on this backend
(1, 4 and 18 patches a run all measure the same per patch).

`shapes.json` comes from tracing, because the graph computes its pads in-graph and ONNX shape
inference cannot resolve the spatial extents -- see `probe-ort-kernels.mjs`.
"""
import json, sys
import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

src, dst, shapes_path = sys.argv[1], sys.argv[2], sys.argv[3]
m = onnx.load(src)
shapes = json.load(open(shapes_path))
init = {i.name: numpy_helper.to_array(i) for i in m.graph.initializer}

# Taps gathered per matrix multiply in the im2col path. **49 was measured**, not chosen: on
# sa2_mask's 7x7x7 stem the whole model runs 166 / 142 / 136 / 141 / 165 ms a patch at groups of
# 7 / 21 / 49 / 98 / 343. The minimum is flat around 49 and both ends are real -- too few taps
# means too many passes over the tensor, too many means a Concat that costs more than it saves.
GROUP = int(sys.argv[4]) if len(sys.argv) > 4 else 49


def im2col_conv(n, w, at, s_in, tag, extra):
    """A convolution of any kernel size as grouped im2col: gather `GROUP` taps into one wide
    matrix, multiply, and sum the groups.

    This is what the 7x7x7 stem needs. The 27-term form the 3x3x3 convolutions use would be 343
    terms here, each a (64, 2) x (2, voxels) multiply -- 343 passes over the tensor to do two
    multiply-adds a voxel, which is slower than the kernel it replaces. Gathering taps raises K
    from 2 to 2*GROUP and cuts the passes by the same factor.

    `GROUP` is a knob because the two costs pull apart: the gathered matrix is
    `2 * GROUP * voxels` floats, and all 343 taps at once is 754 MB, which is a lot to ask of a
    WebGPU buffer. 49 taps is 108 MB and seven groups.
    """
    cout, cin = w.shape[0], w.shape[1]
    k = w.shape[2]
    step = at.get("strides", [1] * 3)[0]
    pads = at.get("pads") or [0] * 6
    padded = s_in + pads[0] + pads[3]
    s_out = (padded - k) // step + 1
    voxels = s_out ** 3
    nodes = []
    source = n.input[0]
    if any(pads):
        extra += [
            helper.make_tensor(f"{tag}p", TensorProto.INT64, [10],
                               [0, 0, pads[0], pads[1], pads[2], 0, 0, pads[3], pads[4], pads[5]]),
            helper.make_tensor(f"{tag}z", TensorProto.FLOAT, [], [0.0]),
        ]
        nodes.append(helper.make_node("Pad", [source, f"{tag}p", f"{tag}z"], [f"{tag}xp"]))
        source = f"{tag}xp"
    taps = [(a, b, c) for a in range(k) for b in range(k) for c in range(k)]
    extra.append(helper.make_tensor(f"{tag}cube", TensorProto.INT64, [5],
                                    [1, cout, s_out, s_out, s_out]))
    running = None
    for g in range(0, len(taps), GROUP):
        chunk = taps[g : g + GROUP]
        gt = f"{tag}g{g}"
        parts = []
        for i, (dx, dy, dz) in enumerate(chunk):
            it = f"{gt}_{i}"
            extra += [
                helper.make_tensor(f"{it}s", TensorProto.INT64, [3], [dx, dy, dz]),
                helper.make_tensor(f"{it}e", TensorProto.INT64, [3],
                                   [d + (s_out - 1) * step + 1 for d in (dx, dy, dz)]),
                helper.make_tensor(f"{it}a", TensorProto.INT64, [3], [2, 3, 4]),
                helper.make_tensor(f"{it}t", TensorProto.INT64, [3], [step] * 3),
            ]
            nodes.append(helper.make_node(
                "Slice", [source, f"{it}s", f"{it}e", f"{it}a", f"{it}t"], [f"{it}c"]))
            parts.append(f"{it}c")
        stacked = np.concatenate([w[:, :, dx, dy, dz] for dx, dy, dz in chunk], axis=1)
        extra += [
            helper.make_tensor(f"{gt}flat", TensorProto.INT64, [2], [cin * len(chunk), voxels]),
            helper.make_tensor(f"{gt}w", TensorProto.FLOAT, list(stacked.shape),
                               stacked.astype(np.float32).ravel().tolist()),
        ]
        nodes += [
            helper.make_node("Concat", parts, [f"{gt}cat"], axis=1) if len(parts) > 1
            else helper.make_node("Identity", parts, [f"{gt}cat"]),
            helper.make_node("Reshape", [f"{gt}cat", f"{gt}flat"], [f"{gt}f"]),
            helper.make_node("MatMul", [f"{gt}w", f"{gt}f"], [f"{gt}m"]),
        ]
        if running is None:
            running = f"{gt}m"
        else:
            nodes.append(helper.make_node("Add", [running, f"{gt}m"], [f"{gt}sum"]))
            running = f"{gt}sum"
    if len(n.input) > 2:
        b = init[n.input[2]].astype(np.float32).reshape(cout, 1)
        extra.append(helper.make_tensor(f"{tag}b", TensorProto.FLOAT, [cout, 1], b.ravel().tolist()))
        nodes.append(helper.make_node("Add", [running, f"{tag}b"], [f"{tag}bb"]))
        running = f"{tag}bb"
    nodes.append(helper.make_node("Reshape", [running, f"{tag}cube"], [n.output[0]]))
    return nodes


nodes, extra, done, skipped = [], [], 0, 0
for n in m.graph.node:
    w = init.get(n.input[1]) if n.op_type == 'Conv' and len(n.input) > 1 else None
    at = {a.name: (list(a.ints) if a.ints else a.i) for a in n.attribute}
    stride = at.get('strides', [1, 1, 1])
    ok = (
        w is not None
        and tuple(w.shape[2:]) == (3, 3, 3)
        and len(set(stride)) == 1  # one step for all three axes; Slice takes it directly
        and not any(at.get('pads') or [])
        and at.get('group', 1) == 1
        and at.get('dilations', [1, 1, 1]) == [1, 1, 1]
        and n.name in shapes
    )
    big = (
        w is not None
        and len(w.shape) == 5
        and len(set(w.shape[2:])) == 1
        and w.shape[2] > 3
        and len(set(at.get('strides', [1, 1, 1]))) == 1
        and at.get('group', 1) == 1
        and n.name in shapes
    )
    if not ok and big:
        nodes += im2col_conv(n, w, at, shapes[n.name][2], f"c{done}", extra)
        done += 1
        print(f"  im2col: {n.name} kernel {w.shape[2]}^3, groups of {GROUP}")
        continue
    if not ok:
        if w is not None and tuple(w.shape[2:]) == (3, 3, 3):
            skipped += 1
            print(f"  left alone: {n.name} stride={stride} pads={at.get('pads')}")
        nodes.append(n)
        continue

    cout, cin = w.shape[0], w.shape[1]
    s_in = shapes[n.name][2]
    step = stride[0]
    # A strided convolution is the same shifted window taken every `step` voxels, which `Slice`
    # expresses directly -- so stride costs nothing here beyond getting the arithmetic right.
    s_out = (s_in - 3) // step + 1
    voxels = s_out ** 3
    tag = f"mm{done}"
    extra += [
        helper.make_tensor(f"{tag}flat", TensorProto.INT64, [2], [cin, voxels]),
        helper.make_tensor(f"{tag}cube", TensorProto.INT64, [5], [1, cout, s_out, s_out, s_out]),
    ]
    running = None
    for i, (dx, dy, dz) in enumerate(
        (a, b, c) for a in range(3) for b in range(3) for c in range(3)
    ):
        at_ = f"{tag}_{i}"
        extra += [
            helper.make_tensor(f"{at_}s", TensorProto.INT64, [3], [dx, dy, dz]),
            # One past the last index the step actually reaches: dx + (s_out - 1) * step.
            helper.make_tensor(f"{at_}e", TensorProto.INT64, [3],
                               [d + (s_out - 1) * step + 1 for d in (dx, dy, dz)]),
            helper.make_tensor(f"{at_}a", TensorProto.INT64, [3], [2, 3, 4]),
            helper.make_tensor(f"{at_}t", TensorProto.INT64, [3], [step] * 3),
            helper.make_tensor(f"{at_}w", TensorProto.FLOAT, [cout, cin],
                               w[:, :, dx, dy, dz].astype(np.float32).ravel().tolist()),
        ]
        nodes += [
            helper.make_node(
                "Slice", [n.input[0], f"{at_}s", f"{at_}e", f"{at_}a", f"{at_}t"], [f"{at_}c"]
            ),
            helper.make_node("Reshape", [f"{at_}c", f"{tag}flat"], [f"{at_}f"]),
            helper.make_node("MatMul", [f"{at_}w", f"{at_}f"], [f"{at_}m"]),
        ]
        if running is None:
            running = f"{at_}m"
        else:
            nodes.append(helper.make_node("Add", [running, f"{at_}m"], [f"{at_}a{i}"]))
            running = f"{at_}a{i}"
    if len(n.input) > 2:  # bias, broadcast over the voxel axis
        b = init[n.input[2]].astype(np.float32).reshape(cout, 1)
        extra.append(helper.make_tensor(f"{tag}b", TensorProto.FLOAT, [cout, 1], b.ravel().tolist()))
        nodes.append(helper.make_node("Add", [running, f"{tag}b"], [f"{tag}bb"]))
        running = f"{tag}bb"
    nodes.append(helper.make_node("Reshape", [running, f"{tag}cube"], [n.output[0]]))
    done += 1

graph = helper.make_graph(nodes, m.graph.name, list(m.graph.input), list(m.graph.output),
                          list(m.graph.initializer) + extra)
out = helper.make_model(graph, opset_imports=list(m.opset_import))
# onnxruntime-web 1.31 reads IR 13 at most; onnx writes 14 by default and the refusal names
# the version rather than the cause.
out.ir_version = 10
# Pinned, so a batch this rewrite cannot express is refused at session creation. Left dynamic
# it fails mid-run inside a Reshape, naming two shapes and neither the cause nor the fix.
batch = out.graph.input[0].type.tensor_type.shape.dim[0]
batch.ClearField("dim_param")
batch.dim_value = 1
onnx.save(out, dst)
print(f"rewrote {done} convolutions, left {skipped} 3x3x3 ones alone (stride or padding)")
