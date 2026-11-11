# Draft issue for microsoft/onnxruntime

Template: **Performance** (`05-performance.yml`). Suggested labels: `ep:WebGPU`, `platform:web`.
Everything below is ready to paste into the template's fields.

---

## Title

```
[Performance] WebGPU EP: Conv3D uses a naive per-element shader and runs ~20x slower than the equivalent MatMul (0.08 vs 1.5 TFLOP/s)
```

---

## Describe the issue

`Conv3D` on the native WebGPU EP is served by `Conv3DNaiveProgram`
(`onnxruntime/core/providers/webgpu/nn/conv3d_naive.cc`), added in #27917, whose description
calls it "a naive Conv3D shader" implementing "a per-element Conv3D shader". The shader is one
thread per output element with four nested loops over the filter dimensions and a `dot` of four
channels at a time; there is no tiling, no shared-memory staging and no reuse of inputs or
weights between threads.

The cost is large. Three single-node graphs, same device, same session, fp32:

| graph | time | achieved |
|---|---|---|
| `MatMul`, 2048x2048 x 2048x2048 | 10.8 ms | **1.5 TFLOP/s** |
| `Conv` 3x3x3, 64→64, on 65³ | 724.8 ms | **0.08 TFLOP/s** |
| `Conv` 1x1x1, 64→64, on 65³ | 37.3 ms | **0.06 TFLOP/s** |

**The 1x1x1 row is the part worth looking at.** A 1x1x1 convolution is a matrix multiply — no
sliding window, no neighbourhood — and it is as slow as the 3x3x3. So the cost is not the extra
spatial dimension and not the kernel size; it is the `Conv` path over 5-D tensors.

### What this costs a real model

A 3D ResNet classifier (21 convolutions, 129³ input, 86.8 GFLOP a forward pass) runs at
**1,131 ms a patch** on the WebGPU EP, against 195 ms for onnxruntime's own CPU EP on the same
machine — the GPU path is **5.8x slower than the CPU path**.

Rewriting only the convolutions in the ONNX graph — each 3x3x3 becomes 27 shifted
`Slice`+`Reshape`+`MatMul` terms summed, and the 7x7x7 stem becomes a grouped im2col — takes the
same model to **136 ms a patch, an 8.3x speed-up, with the output unchanged** (every logit of an
18-candidate list within 1.7e-5 of the original, ranking identical). That is a graph rewrite
doing by hand what the kernel could do internally, which is the clearest evidence that the
arithmetic is not the limit.

For reference on the same machine, PyTorch's Metal backend reaches **6.47 TFLOP/s** on the same
3x3x3 convolution shape, so the hardware is not the constraint either.

### There is precedent for the fix

#32304, "[WebGPU] Share subgroup matrix MatMul with pointwise Conv" (merged 2026-09-05), already
routes **1x1 2D** convolutions into the subgroup-matrix `MatMul` kernel. Extending that routing
to 5-D `Conv` looks like the natural fix, and would reuse kernels that are already tuned rather
than adding a second optimised convolution implementation.

I am aware that routing is currently contested: #33856 reports it making pointwise convolutions
8-15x slower on an Intel Arc A750. I have only Apple hardware, so I cannot speak to the behaviour
of the subgroup-matrix path on other vendors — which is exactly why I am opening an issue rather
than a pull request. **If the team would like this kernel contributed, I am happy to do the
work; I would want guidance first on whether routing 5-D `Conv` through the MatMul path is the
direction you want, given #33856.**

### How the measurements were made

Per `docs/PR_Guidelines.md`, which asks for this. Every graph is a single node generated locally
so the timing is one kernel's; weights are constant initializers; each is run once to warm and
then the best of five is taken, all inside the page with `performance.now()`.

Two measurement traps are worth naming, because both produced confident wrong numbers before
being caught, and anyone re-running this will hit them:

- With the wide operand as a **graph input**, it is re-uploaded from JavaScript on every `run()`
  (70-1,898 MB here), and the timing is the upload.
- With it as an **initializer**, the large output is downloaded on every `run()`, which pins
  every shape at about 15 ms and makes throughput appear to rise with K.

Only timings whose input and output are both small, or whole-model timings, mean anything.

## To reproduce

A self-contained generator for the three single-node models (needs only `onnx` and `numpy`):

```python
import numpy as np, onnx
from onnx import TensorProto, helper

rng, IR = np.random.default_rng(0), 10   # onnxruntime-web 1.31 reads IR 13 at most
def save(model, name):
    model.ir_version = IR
    onnx.checker.check_model(model)
    onnx.save(model, name)

N, C, S = 2048, 64, 65
w = (rng.standard_normal((N, N)) * 0.01).astype(np.float32)
save(helper.make_model(helper.make_graph(
    [helper.make_node("MatMul", ["x", "w"], ["y"])], "matmul",
    [helper.make_tensor_value_info("x", TensorProto.FLOAT, [N, N])],
    [helper.make_tensor_value_info("y", TensorProto.FLOAT, [N, N])],
    [helper.make_tensor("w", TensorProto.FLOAT, [N, N], w.ravel().tolist())]),
    opset_imports=[helper.make_opsetid("", 17)]), "matmul.onnx")

for k, name in ((3, "conv3.onnx"), (1, "conv1.onnx")):
    kw = (rng.standard_normal((C, C, k, k, k)) * 0.01).astype(np.float32)
    save(helper.make_model(helper.make_graph(
        [helper.make_node("Conv", ["x", "w"], ["y"], kernel_shape=[k]*3,
                          pads=[k // 2]*6, strides=[1]*3)], name.removesuffix(".onnx"),
        [helper.make_tensor_value_info("x", TensorProto.FLOAT, [1, C, S, S, S])],
        [helper.make_tensor_value_info("y", TensorProto.FLOAT, [1, C, S, S, S])],
        [helper.make_tensor("w", TensorProto.FLOAT, list(kw.shape), kw.ravel().tolist())]),
        opset_imports=[helper.make_opsetid("", 17)]), name)
```

And the timing, in a page served over http (WebGPU needs a secure context):

```js
import * as ort from './ort/ort.webgpu.bundle.min.mjs'

async function time(file, dims) {
  const s = await ort.InferenceSession.create(file, { executionProviders: ['webgpu'] })
  const x = new ort.Tensor('float32', new Float32Array(dims.reduce((a, b) => a * b, 1)), dims)
  await s.run({ x })                       // warm: shader compilation
  let best = Infinity
  for (let i = 0; i < 5; i++) {
    const t = performance.now()
    await s.run({ x })
    best = Math.min(best, performance.now() - t)
  }
  await s.release?.()
  return best
}

console.log('matmul', await time('/matmul.onnx', [2048, 2048]))
console.log('conv3 ', await time('/conv3.onnx', [1, 64, 65, 65, 65]))
console.log('conv1 ', await time('/conv1.onnx', [1, 64, 65, 65, 65]))
```

GFLOP per run: MatMul `2 * 2048³ = 17.2`, conv3 `2 * 64 * 64 * 27 * 65³ = 60.7`,
conv1 `2 * 64 * 64 * 65³ = 2.25`.

That the graph really runs on the GPU was confirmed two ways rather than assumed, since a node
the EP cannot take falls back to the CPU and still answers correctly: ORT's own verbose log
reports `All nodes placed on [WebGpuExecutionProvider]`, and `Conv3DNaive` appears in the
compiled WGSL program names.

## Urgency

Not urgent — a graph-level workaround exists (above) and is in use. But it keeps a 3D CNN off
the GPU path in the browser for anyone who has not found it, and the current state is slower than
this runtime's own CPU EP.

## Platform

Mac

## OS Version

macOS 26.6.2 (Apple M3 Max)

## ONNX Runtime Installation

Released Package

## ONNX Runtime Version or Commit ID

onnxruntime-web 1.31.1

## ONNX Runtime API

JavaScript

## Architecture

ARM64

## Execution Provider

Other / Unknown — **WebGPU** (the native WebGPU EP; the session reports
`WebGpuExecutionProvider`)

## Execution Provider Library Version

Chrome 157.0.8103.51, launched with `--use-angle=metal --enable-unsafe-webgpu`

## Model File

The three single-node models are generated by the script above; happy to attach them if useful.

## Is this a quantized model?

No — fp32 throughout.
