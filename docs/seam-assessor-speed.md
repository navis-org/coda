# The assessors in a browser: what is slow, and the graph rewrite that fixes most of it

**For SEAM, and for whoever ports `scripts/lib/rewrite_assessor_convs.py` into
`scripts/export_assessor.py`.** Written by Coda's agent on 2026-11-10, the day the assessors
were exported. Everything below was measured on one machine — M3 Max, macOS 26.6.2, Chrome
157.0.8103.51 headless with `--use-angle=metal --enable-unsafe-webgpu`, onnxruntime-web 1.31.1,
onnxruntime Python 1.31.0, torch 2.14.1 — against `data/onnx/sa2_mask/` at SEAM `3cc180a`.
**Every number here is one machine's**; the ratios are what should travel, not the milliseconds.

The short version: **onnxruntime-web's `Conv` kernel is broken for 5-D tensors — about 25 times
slower than the same backend's own `MatMul` for identical arithmetic — and expressing the
convolutions as matrix multiplies instead takes `sa2_mask_s0` from 1,131 ms a patch to 136, with
the answer unchanged.** A tip goes from ~130 s to ~15.5 s at three seeds, ~5.2 s at one.

**Update, same day: SEAM ported the rewrite into the exporter and it holds — parity passes on
all three seeds, and the real models measure 8.4x in a browser. See [§12](#12-seam-shipped-it-and-the-real-models-were-measured-in-the-browser-2026-11-10).
§7's gating item is closed, and §11 withdraws an fp16 claim §6 and §9 still make.**

---

## 1. The headline numbers

Per patch, warm, batch 1, on the machine above. `sa2_mask_s0` is 86.8 GFLOP a patch.

| | ms a patch | TFLOP/s | |
|---|---|---|---|
| onnxruntime-web, WebGPU, as exported | 1,131 | 0.077 | |
| onnxruntime-web, WASM, as exported | 1,973 | 0.044 | |
| **onnxruntime-web, WebGPU, rewritten** | **136** | **0.64** | **8.3x** |
| onnxruntime Python, CPU (14 threads) | 195 | 0.45 | for scale |
| onnxruntime Python, CoreML | 331 | — | took only 25 of 90 nodes |
| PyTorch, Metal, one 3x3x3 convolution | — | 6.47 | the hardware's own answer |

Accuracy of the rewrite, over the whole 18-candidate list of end 2282:

- within **1.7e-5** of the unmodified graph, **ranking identical**;
- **1.01e-4** from PyTorch, which is exactly what the unmodified graph manages.

So the rewrite is no further from PyTorch than the export is.

---

## 2. Why: the `Conv` kernel, not the hardware and not the graph

Three one-node graphs, same GPU, same session (`pnpm probe:ort-kernels`, which builds them with
`scripts/lib/make_kernel_graphs.py`):

| graph | TFLOP/s |
|---|---|
| `MatMul` 2048³ | 1.3–1.6 |
| `Conv` 3x3x3, 64→64 on 65³ | 0.08 |
| `Conv` 1x1x1, 64→64 on 65³ | 0.06 |

**The third row is the argument.** A 1x1x1 convolution *is* a matrix multiply — no sliding
window, no neighbourhood. If the cost were the third dimension or the kernel size it would be
fast. It is not. What is slow is onnxruntime-web's `Conv` path over 5-D tensors, whatever is in
it, and one isolated `Conv` reproduces the whole model's 0.077 TFLOP/s exactly.

What this rules out, each checked rather than assumed:

- **The hardware.** PyTorch's Metal backend does 6.47 TFLOP/s on the 3x3x3 shape that is most of
  the graph (`scripts/lib/seam_assessor.py conv`). The machine is fine.
- **Graph bloat.** ORT's own optimiser already folds this model from **444 nodes to 90** at
  level 4, which onnxruntime-web applies by default. `onnxsim` and `onnx-optimizer` have nothing
  left to take; what survives — 22 `Pad`, 16 unfused `BatchNormalization` — is a few per cent.
- **WebNN.** Chrome exposes it (GPU, NPU and CPU contexts all open), but the spec has `conv2d`
  and **no 3D convolution**, so every `Conv` falls back. All three device types time identically
  at ~1,920 ms a patch.
- **Metal through Pyodide.** Not a thing: Pyodide is WebAssembly, and WebAssembly's only routes
  to a GPU are WebGPU and WebNN.

---

## 3. The rewrite

`scripts/lib/rewrite_assessor_convs.py`, run as

    <venv>/bin/python scripts/lib/rewrite_assessor_convs.py <in.onnx> <out.onnx> <shapes.json> [group]

Two paths, by kernel size. Both are exact: no approximation, no retraining, the same weights
rearranged.

### 3x3x3 convolutions → 27 shifted matrix multiplies

For each of the 27 one-voxel offsets `(dx, dy, dz)`: slice the input at that offset, flatten
`(1, C, X, Y, Z)` to `(C, voxels)`, multiply by that offset's `(Cout, Cin)` weight matrix, and
sum the 27 results. Arithmetically identical to the convolution.

The flatten needs no transpose because `C` is already the outermost axis after the batch — which
is also why this is **batch-1 only**: at `N > 1` the channel and batch axes interleave and the
reshape is wrong. The rewritten model pins its batch axis to 1 so a larger batch is refused when
the session is built rather than answered incorrectly. Nothing is lost by that: **batch size does
not change throughput on this backend** (1, 4 and 18 patches a run all measure the same per
patch).

Stride is free: `Slice` takes a step, so a stride-2 convolution is the same shifted window taken
every other voxel. Getting this right took the model from 251 ms to 181.

These convolutions have `pads` all zero in the exported graph — the separate `Pad` nodes do the
padding — so each is a 'valid' convolution and a slice of the already-padded input *is* the
shifted window.

### Larger kernels (the 7x7x7 stem) → grouped im2col

The 27-term form would be 343 terms here, each a `(64, 2) x (2, voxels)` multiply: 343 passes
over the tensor to do two multiply-adds a voxel, which is **slower than the kernel it replaces**.
So the stem gathers `group` taps into one wide matrix (`Concat` on the channel axis), multiplies
once per group, and sums the groups. K rises from 2 to `2 * group` and the passes fall by the
same factor.

`group = 49` is the default and it is **measured, not chosen**: the whole model runs

| taps a group | 7 | 21 | **49** | 98 | 343 |
|---|---|---|---|---|---|
| ms a patch | 166 | 142 | **136** | 141 | 165 |

The minimum is flat around 49 and both ends are real — too few taps means too many passes, too
many means a `Concat` that costs more than it saves. Note 343 (a single full im2col, the
textbook form) is one of the worse options, and its intermediate is 754 MB.

### `shapes.json`

The rewrite needs each convolution's input spatial extent, and ONNX shape inference **cannot
supply it**: the graph computes its pads in-graph (`ConstantOfShape` → `Concat` → `Slice` →
`Pad`), so the extents come back unknown. Coda gets them by tracing — adding each convolution's
input as a graph output and running the model once. **An exporter knows these shapes directly
and should simply emit them**, which is one of the two reasons this belongs upstream.

---

## 4. What was tried and did not work

Each of these looked right and measured wrong. Recorded so nobody spends the afternoon again.

- **Grouping taps for the 3x3x3 convolutions is worse than not grouping.** 6.8x ungrouped, 5.6x
  in nines, 4.8x in threes, on an isolated convolution. The `Concat` that builds a group costs
  more than the passes it saves. (The stem is the opposite case only because its ungrouped form
  is pathological at K=2.)
- **Folding the 26 accumulating `Add`s into the multiplies with `Gemm`'s `C` input is worse
  again** — 4.1x against 6.8x. The accumulation is not where the time goes, or ORT's `Gemm` path
  is worse than `MatMul` + `Add`; either way, do not.
- **fp16 is marginal and unproven.** About 1.1x on the rewritten graph, with the logit 8.5e-3
  from PyTorch — ordinary fp16 error, but against a parity rule that bounds q at 0.01 it is not
  obviously safe, and it has had **no parity check**. See §6 for why it is still interesting.
- **`onnxconverter_common.float16` is unusable on this graph.** Without a block list it produces
  a model ORT refuses to load (the in-graph label encoding ends up with a `Conv` bound to two
  types); with `op_block_list` it does per-node graph surgery with repeated shape inference and
  ran **47 minutes on the 133 MB model and over 10 on the 2.2 MB probe** without finishing — the
  cost is per node, so model size was never the problem. **`onnxruntime.transformers.float16`
  does the same job in 0.4 s.**

---

## 5. Where the remaining time goes, and the ceiling

The rewritten model runs at 0.64 TFLOP/s. The ceiling for the matmul shape it actually produces
— M=64, K=64, N=65³ — is **1.05 TFLOP/s**, measured with 20 chained multiplies so that neither
the upload nor the download could dominate. So the rewrite is at **61% of what this backend can
do with these shapes**, and at most ~1.6x remains inside this approach.

A per-node CPU profile of the rewritten graph puts **`Slice` at 70%** of its time — the gather,
not the arithmetic. That is the gap, and ONNX cannot express the fix: the 27 shifted windows
overlap almost entirely and a good kernel reads the tensor once, but every alternative still
materialises copies (im2col slices *and* concatenates, which is why grouping lost; shifting
outputs instead of inputs is the same count). **Caveat: that 70% is a CPU figure.** No
GPU-side confirmation was possible, because no variant with fewer slices computes the same
arithmetic.

**A warning about micro-benchmarks here.** Two attempts to measure these matmul shapes in
isolation were both I/O-bound rather than compute-bound, in opposite directions: with the wide
operand as a graph *input* it is re-uploaded from JavaScript every run (70–1,898 MB), and with it
as an *initializer* the 70 MB output is downloaded every run, which pins every K at ~15 ms and
makes throughput look like it rises with K. Both produced confident, wrong conclusions before
being caught. Only whole-model timings, whose output is one logit, mean anything.

The remaining ~6x to Metal is locked behind the kernel, not the graph.

---

## 6. For the upstream bug report

**One issue, not two.** The performance report is solid and is drafted in
`docs/onnxruntime-conv3d-issue.md`. The fp16 correctness report was **withdrawn after trying to
build a minimal repro for it** — see §11. The paragraph below is left as it was written, and is
wrong; §11 says why.

1. **fp16 `Conv` on 5-D tensors produces wrong results on WebGPU; the same model is correct on
   WASM.** Same converted file, same runtime: WASM gives 1.96e-2 error and the correct ranking,
   WebGPU gives **3.64** and scrambles the order. Since the rewritten graph — same conversion,
   same backend, no `Conv` left — is fine in fp16, the fault is in the WebGPU `Conv` kernels
   specifically, not in fp16 or in the converter. That A/B is the report.
2. **`Conv` on 5-D tensors is ~25x slower than the equivalent `MatMul`** (Performance template).
   The 1x1x1 case is the detail that makes it sharp: arithmetically a matmul, 0.06 against 1.5
   TFLOP/s in the same session.

`scripts/lib/make_kernel_graphs.py` generates self-contained one-node repro models for both.

`pnpm probe:ort-kernels` **asserts** the gap rather than describing it, so the onnxruntime-web
release that fixes the kernel announces itself by failing that check — at which point the rewrite
may become unnecessary, and the assessor cost should be re-measured before anyone relies on it.

---

## 7. What is not done

- ~~**SEAM's parity rule has not been run on the rewrite.**~~ **Done — see §12.** SEAM ported the
  rewrite into `export_assessor.py` the same day and the rule passes on every count.
- ~~Only `sa2_mask_s0` was rewritten and measured~~ — all three seeds are exported and measured.
- The rewritten file carries the replaced weights, so it is larger than it needs to be. An
  exporter emitting the graph directly would not have that problem. **Still true of SEAM's
  export**: `sa2_mask_mm_s0.onnx` is 133,083,679 bytes against the original's 132,877,338, so
  the dead weights cost 0.2 MB in 133 — not worth a pass to strip.
- The 1x1x1 convolutions are left on ORT's kernel: rewriting them gains ~1.2x on the isolated op
  and they are 0.6% of a patch.

## 8. Coda-side files

| | |
|---|---|
| `scripts/lib/rewrite_assessor_convs.py` | the rewrite, to be ported |
| `scripts/lib/make_kernel_graphs.py` | the one-node graphs, and the repro for the bug report |
| `scripts/probe-ort-kernels.mjs` | the kernel comparison, which asserts the gap |
| `scripts/probe-assessor-ops.mjs` | does WebGPU run the graph at all, and where did the nodes go |
| `scripts/probe-assessor-parity.mjs` | the real model against `lists.parquet`'s `torch_s<k>` |
| `scripts/lib/seam_assessor.py` | the numpy half: fixtures, the native comparison, the Metal benchmark |

Longer-form narrative, including the measurements that led here, is in
[seam-suggestions-plan.md](seam-suggestions-plan.md) under "Phase 7, measured before building".

---

## 9. Upstream: what onnxruntime already knows (searched 2026-11-10)

Searched `github.com/microsoft/onnxruntime` for issues, PRs and commits touching this. The
findings change what the bug report should say, and one of them corrects §6.

### The kernel really is called `Conv3DNaive`, and it is naive

`Conv3D` reached the native WebGPU EP in **PR #27917** (merged 2026-04-03), whose own description
says it adds "a **naive** Conv3D shader" implementing "a per-element Conv3D shader". The source
(`onnxruntime/core/providers/webgpu/nn/conv3d_naive.cc`, 175 lines) confirms it: one thread per
output element, four nested loops over the filter dimensions, a `dot` of four channels at a
time, `output.SetByOffset(global_idx, value)` at the end. **No tiling, no shared memory, no reuse
of weights or inputs between threads.** Every thread re-reads from global memory.

The file has had exactly **two** commits ever: that one, and #32117 (activation fusion,
2026-08-30).

Our own run used it: `Conv3DNaive` appears 50 times in the WebGPU shader log, and the session
reports `WebGpuExecutionProvider` — the native C++ EP, not the older JSEP path.

So the 25x gap against `MatMul` is not a mystery or a misconfiguration. It is an unoptimised
reference kernel that nobody has replaced.

### The maintainers already agree with our strategy — for 2D only

**PR #32304, "[WebGPU] Share subgroup matrix MatMul with pointwise Conv"** (merged 2026-09-05),
routes 1x1 **2D** convolutions through the subgroup-matrix `MatMul` kernel. That is the same
transformation this document describes, done inside the runtime. It has never been extended to
3D.

It is also not settled: **issue #33856** (open, 2026-11-04) reports that routing making pointwise
convolutions **8-15x slower** on an Intel Arc A750, with `preferredLayout: "NCHW"` as the
workaround. So when the report lands, expect the maintainers to be aware both that Conv→MatMul
is the right idea and that their first attempt at it has a live regression.

### Nobody has reported Conv3D performance

Three open issues match "conv3d" and none is about speed (CANN support #28093, non-symmetrical
padding #24800, a CUDA transpose from 2022). **The performance report would be new**, not a
duplicate.

### The fp16 finding needs rewording — our bug is *not* the known one

This corrects §6. There **is** a known fp16 Conv3D bug on WebGPU, and it is already fixed, but
somewhere else:

- **#22974** (2024-11-29): fp16 Conv3D failed on WebGPU with a WGSL validation error, "return
  statement type must match its function return type, returned 'f16', expected 'f32'". Correct on
  WASM, wrong on WebGPU — the same shape of symptom we saw.
- **#32357** (merged 2026-09-08) fixed it by replacing 12 hardcoded `f32` with the resolved
  element type. Its description records that on newer Chromium the failure had become worse:
  the shader **silently returned all zeros**, about 9x faster than fp32, "so it looks like a
  successful, fast run".
- **But that fix is in `js/web/lib/wasm/jsep/webgpu/ops/3rd-party/conv3d_naive_webgpu.ts`** — the
  **JSEP** implementation. The native EP's `conv3d_naive.cc` is a separate file, has no hardcoded
  `f32` (it uses `ShaderUsage::UseElementTypeAlias`), and never received it.

We are on the native EP, and our fp16 failure is **neither** of the known symptoms: not a WGSL
validation error, not all zeros, but plausible-looking logits 3.64 out with the ranking
scrambled. So it is a distinct, unreported defect — and the report must say so, or it will be
closed as a duplicate of #32357.

### Worth watching

Several open WebGPU convolution PRs could move these numbers without anything changing on our
side: **#33723** (tensor bounds and convolution geometry), **#33673** (crashes, indexing, numeric
precision), **#34074** (a subgroup-size-16 MatMul/Gemm kernel), **#33671** (Conv regression
coverage). `pnpm probe:ort-kernels` is what will notice.

### Revised filing advice

1. **Performance, new:** "WebGPU EP: Conv3D uses a naive per-element shader; ~25x slower than the
   equivalent MatMul." Cite #27917 as where it came from, #32304 as the precedent for the fix in
   2D, and the 1x1x1 measurement as the proof that kernel size is not the cause. Mention #33856
   so they know the 2D routing has an open regression.
2. **Correctness, new, and explicitly not #32357:** "WebGPU EP (native): fp16 Conv3D returns
   wrong values; correct on WASM." State up front that `conv3d_naive.cc` is a different file from
   the JSEP shader fixed in #32357, that it has no hardcoded `f32`, and that the symptom differs
   from both #22974's validation error and #32357's all-zeros.

---

## 10. Contributing upstream: the policy, and whether to submit a kernel

Checked 2026-11-10 against `CONTRIBUTING.md`, `docs/PR_Guidelines.md`, `AGENTS.md`,
`.github/pull_request_template.md` and `.github/instructions/`.

### The process

- **A Microsoft CLA is required**, once across all their repositories; a bot decorates the PR and
  tells you what to do.
- **Non-trivial changes start with an issue, not a PR.** "If your change is non-trivial… please
  use the feature request issue template to discuss it with the team and get consensus on the
  basic design and direction first. For all other changes, you can directly create a pull
  request." A new convolution kernel is non-trivial by any reading.
- **Unit tests are mandatory** on every PR unless already covered.
- **Build and test locally on at least one platform before opening the PR.** CI is not a scratch
  pad, and for a new contributor a maintainer has to trigger the build by hand.
- **Keep it under ~10 files**, and keep cosmetic changes out of functional PRs.
- **Performance PRs are asked to state the improvement and how it was measured**, explicitly "for
  educational purposes" — which is the one guideline this work is already over-prepared for.

### On AI: there is no policy, and the repository is built for agents

No disclosure requirement exists anywhere — not in `CONTRIBUTING.md`, `docs/PR_Guidelines.md`,
`AGENTS.md`, the PR template, or a code search of the repository. (`CONTRIBUTING.md` does match
"AI" five times; all five are `onnxruntime.ai` URLs or the `Windows.AI.MachineLearning`
namespace.)

The opposite, in fact: the repository ships `AGENTS.md` as repo-wide agent guidance,
`.github/copilot-instructions.md` pointing at it, path-scoped `.github/instructions/*.md`, and
ten `.github/skills/` including `ort-build`, `ort-ci`, `ort-test`, `ort-lint` and `code-review`.
Agent-assisted contribution is anticipated and tooled for.

One convention does bind the code itself, and it is the opposite of this repository's house
style. `AGENTS.md`: *"Keep code comments concise… Do not narrate obvious code or document the
sequence of approaches taken to reach the current implementation; that history belongs in the
pull request or commit message."* A kernel submitted upstream has to be written in their voice,
with the reasoning moved into the PR description.

### Would a kernel PR be welcome? The precedent says yes

Every one of the twenty most recently merged WebGPU pull requests is from `CONTRIBUTOR`, not
`MEMBER` — outside contributions land routinely. So do the three that matter here: #27917
(Conv3D itself), #32304 (the pointwise-Conv MatMul routing) and #32357 (the fp16 fix).

### But weigh these first

- **It is C++ and WGSL in the native EP, not a graph pass.** Nothing built here transfers except
  the measurements and the idea.
- **Building onnxruntime from source with the WebGPU EP is a heavy prerequisite**, and their
  guidelines require it before the PR.
- **We can only test on Apple and Metal.** #33856 is exactly the cautionary tale: the 2D
  pointwise→MatMul routing shipped and then turned out to be **8-15x slower on an Intel Arc
  A750**. A 3D version invites the same scrutiny on hardware we cannot run.
- **The right shape is probably not a new tiled shader** but routing Conv3D into the existing
  MatMul path, as #32304 did for pointwise 2D — reusing kernels their team has already tuned,
  and matching a precedent they accepted.

**Recommended order.** File the two issues first; they are cheap, they are not duplicates, and
the measurements are the valuable part. In the performance issue, offer to do the kernel and
*ask whether routing 3D Conv through the MatMul path is the direction they want*. That is the
path their own contribution guide prescribes for non-trivial work, and it avoids building
something they would rather have shaped differently.

### One more thing, and it strengthens the fp16 report

`.github/instructions/jsep-deprecated.instructions.md` says **JSEP is deprecated and being
replaced by the native WebGPU EP**, and sets this review policy:

> For a JSEP WebGPU kernel fix, inspect the corresponding native WebGPU EP implementation.
> **Report an actionable finding if the same defect applies there but the change does not include
> the native fix** and focused regression coverage.

That is precisely what happened with #32357: an fp16 Conv3D fix applied to the deprecated JSEP
shader and not to the native EP, where — on our measurement — a defect remains. The report is
not just valid, it names a case their own written policy says should have been caught. Say so.


---

## 11. The fp16 correctness report was withdrawn (2026-11-10)

§6 and §9 claim an fp16 `Conv3D` correctness bug on the native WebGPU EP, on the strength of a
whole-model A/B: the same converted file gave 1.96e-2 error on WASM and **3.64** on WebGPU, with
the ranking scrambled. Writing the minimal repro for the issue is what undid it.

**Two isolated fp16 `Conv3D` graphs are correct on WebGPU.** A 4-channel 16³ 3x3x3, and the
stem's own shape — 2 channels, 129³, 7x7x7, stride 2, the most unusual convolution in the model.
Both agree with the fp32 reference to about 1e-3 on WebGPU, which is ordinary fp16 error. The
defect does not reproduce in one node.

**And the whole-model gap has a benign explanation that fits the timings.** fp16 on WASM is
*slower* than fp32 (2,176 ms against 1,973) while fp16 on WebGPU is much faster (701 against
1,145). That is what it looks like when the WASM kernels upcast to fp32 and compute there — so
its "fp16" run is effectively an fp32 run and keeps a tiny error, while WebGPU genuinely computes
in fp16. Through 21 convolutions of a residual network, on logits of order ±8, fp16 accumulating
to a few units is believable arithmetic rather than a bug.

So: **there is no demonstrated correctness defect, and nothing should be filed.** What was
really measured is that this network does not survive fp16 end to end on a backend that honestly
computes in fp16 — which is a reason not to use fp16 here, and no more than that.

The lesson is the ordinary one: a model-level A/B localises nothing on its own. The claim held
for several hours only because the comparison was never reduced to a single node.

---

## 12. SEAM shipped it, and the real models were measured in the browser (2026-11-10)

SEAM ported the rewrite into `export_assessor.py` the same day (SEAM `c9b9a08`,
`export --kernels matmul`) and published `sa2_mask_mm_s{0,1,2}.onnx` beside the originals. The
sidecar records **17 convolutions rewritten, 4 left as `Conv`, `stem_group` 49** — the same
counts and the same group size the sweep in `rewrite_assessor_convs.py` landed on.

**SEAM's own parity rule passes on all three seeds** (`parity.json`, `onnxruntime_cpu_matmul`):
40 lists, 1,387 candidates, shown decisions the same on every tip, ref's first candidate the
same on every list, largest q difference 5.4e-6, Spearman ≥ 0.99999. Its raw logit error against
PyTorch is 5.2e-4 to 8.2e-4 — indistinguishable from the unmodified graph's 5.5e-4 to 8.3e-4.
That closes the gating item in §7.

### What the real models do in a browser

`pnpm probe:assessor-parity -- --exported … --model '/sa2_mask_mm_s{seed}.onnx' --eps webgpu`,
both graphs run the same hour on the same machine, 6 real patches each, warm:

| `sa2_mask_s0`, WebGPU | ms a patch | a 114-patch tip |
|---|---|---|
| as exported (`Conv`) | 1,122 | 128 s |
| **rewritten (`MatMul`)** | **133** | **15 s** |

**8.4x**, against the 8.3x predicted from the hand rewrite — so nothing was lost in the port.
And the headline worth keeping: **the browser is now faster than native onnxruntime on this
machine's CPU** (200 ms a patch), where before it was five and a half times slower.

Agreement in the browser, all three seeds, against `lists.parquet`'s `torch_s<k>`: worst
**1.2e-4** over 18 patches, ranking identical on every list — better than onnxruntime's own CPU
backend manages (8e-4), and the batch of 1 is not a cost: 133 ms a patch matches the 132 of the
single-seed run.

### One thing the probe had to learn

The matmul graph **pins its batch axis to 1**, which it must — flattening `(N,C,X,Y,Z)` to
`(C, voxels)` is only the same tensor at N=1 — and a list fed in one go is refused outright with
`Got: 3 Expected: 1`. `probe-assessor-parity.mjs` now asks `session.inputMetadata[0].shape[0]`
and feeds patches in whatever the graph takes, rather than assuming a whole list fits. A caller
scoring a tip should expect one `session.run` per patch per seed.

