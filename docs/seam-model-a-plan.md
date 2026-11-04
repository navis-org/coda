# The `seam` pack: adding SEAM's Model A beside the affinity transformer

A plan, not a record of what is built. It brings SEAM's Model A (`~/Github/SEAM`, checkpoint
`data/ckpt/A_d256_e80/best.pth`, trained on real FlyWire merges) into this repo as the merge
detector, and renames the pack it joins.

**Read [seam-plan.md](seam-plan.md) first.** It holds why the pack exists and what
Phases 0–2 measured. The short version of why this plan exists: that plan named the training
distribution as its largest risk — the shipped checkpoint learned from *made-up* merges, two
neurons each centred and then pushed about 20 µm apart — and said nothing licensed a claim about
real ones until Phase 3 measured it. SEAM measured it. **Zero-shot Troidl is at chance on real
merges.** Model A reaches test AUC 0.95 on FlyWire and 0.78 zero-shot on Aedes.

## Nothing is deleted

**Decided (user, 2026-11-04): the affinity path stays, whole and runnable.** A refined Troidl
checkpoint is a live possibility, and what failed is the checkpoint, not the apparatus around it —
the preprocessing is parity-checked against a declared Python reference, the clustering agrees
with scikit-learn at thresholds that straddle the cut, and the converter turns any of the three
published checkpoints into a manifest. That is the instrumentation a retrained model would
otherwise have to be rebuilt against.

So this is **a second node sharing `src/ml`**, not a swap. The practical consequence is that the
plan below adds files and renames a pack; it removes nothing.

## Why it cannot be one node

The pack was built so a second model costs a row in `models.ts` and nothing else, and that
property is real — but it holds for a model asking the *same shape of question*. Model A asks a
different one, and almost every difference reaches the node's ports:

| | affinity transformer (shipped) | SEAM Model A |
| --- | --- | --- |
| what it eats | the whole neuron, 1,024 points | a **15 µm window**, 4,096 points, run tiled |
| where the points come from | **skeleton nodes**, drawn with replacement | **mesh surface**, area-uniform at 0.2 µm |
| features | positions only | positions **plus surface normals** |
| scale | ÷ 659.88, centred on the neuron's centroid | ÷ 50.2864, relative to the window centre |
| what it answers | an N×N affinity matrix | **two heads**: `p(false merge)` per window, and a per-point bipartition |
| what the node does with it | average-linkage clustering, `1 − affinity` at t = 0.8 | rank windows by score; the bipartition becomes a proposed cut |
| size | 406 MB (`mixed`) | **70.6 MB fp32** (17,640,841 parameters, d256, depth 12) |
| per neuron | ~12 s at N = 1024 | tens of windows × **12 ms** on WebGPU |

A single node spanning both would take skeletons *or* meshes, show one of two disjoint param sets,
and emit one of two output shapes. That is two nodes wearing one hat, and `Model` would be the
param that silently decides which. Two nodes, one runtime.

**Note Model A is trained from scratch, not fine-tuned from Troidl.** d1024/depth 24 weights do not
fit d256/depth 12. Same backbone architecture (`seam/backbone/pst.py`, vendored from
split_learning), different size, different heads.

## What the two nodes are called

The plain name goes to the model that works.

| | type | label |
| --- | --- | --- |
| Model A | `seam:findMerges` | Find Merges |
| affinity transformer | `seam:affinityClusters` | Affinity Clusters |

"Affinity Clusters" is also the more honest label for what that node does: it clusters a neuron's
points by predicted affinity, and calling more than one cluster a merge was always the reader's
inference rather than the model's claim.

## The pack becomes `seam`

SEAM's own `docs/coda-pack.md` plans a pack called `seam` in this repo, on a branch off
`neuroglancer-selected`, with `seam:suggestions` (fetch suggestions from a service) and
`seam:review` (a review queue that POSTs decisions, in the style of `annotation:editor`), plus
three neuroglancer protocol extensions. `proofread` is the in-browser half of the same thing.

**Decided (user, 2026-11-04): one pack, named `seam`.** `findMerges` is the node that runs a model
here and now; `suggestions`/`review` join it for the service path.

**Do the rename first**, because its cost only goes up. A node type is persisted in graph files, so
once a reader has saved a workflow the old id has to live on in `NodeDefinition.formerTypes`
forever. Nothing has shipped under `seam:affinityClusters`, so today both renames are a
find-and-replace; tomorrow they are a migration. The pack id is also the directory name and the
glob key for `glyphs.ts`, `seeAlso.ts` and `nodeValues.ts`, and `NODE_VALUES` attributes a value to
its pack by that path.

## Three things Model A forces, and one it does not

**1. Meshes, not skeletons.** `seam:findMerges` cannot take what `seam:affinityClusters` takes.
Model A's input is mesh surface points with normals, and SEAM decided for the browser path on
2026-10-20 that it stays that way, because Coda's bundled neuroglancer already fetches and decodes
graphene meshes. A window is megabytes of mesh rather than kilobytes of skeleton, so **fetch time
per window** becomes a real cost with no equivalent in the existing node, and SEAM named it as the
spike's one unmeasured item.

**2. Its preprocessing is Pyodide, and the existing TypeScript stays as it is.** SEAM's rules 3
and 11 are that training and inference build the input through **one** numpy-only function, so the
same file runs in CPython and in Coda's Pyodide worker — verified, not assumed: `seam/canonical.py`
runs unchanged under Pyodide 0.28.3 and gives **bit-identical** output to CPython for the same mesh
and seed, in 248 ms.

Coda's side already fits: `src/pyodide/` is a `.py` file beside a `.ts` wrapper, numpy is 2.92 MB
of a ~10 MB first load, and a second capability costs only its own file.

So the pack ends up with two input-building styles — TypeScript with a parity probe for the
affinity path, vendored numpy for Model A. **That is not drift**, because they are inputs to
different models with no shared constant, and each is checked against its own reference. Rewriting
the working, parity-checked TypeScript to match a rule from another repo would be churn with a
real chance of introducing the error the probe exists to catch.

**3. No top-k.** Model A gives a window score and a per-point bipartition, so the answer is "these
windows look like merges, here is where to cut". SEAM's invariant 14 is explicit: a candidate list
is cut by an **absolute, calibrated score**, never top-k, never a share, never a z-score over the
candidates — and the precision/recall curve ships with the model so the cutoff is a setting read
off a curve rather than a constant. That curve has to be carried in the manifest.

**What it does not force: a new runtime.** `src/ml` — `manifest.ts`, `weights.ts`, `session.ts`,
`protocol.ts`, `infer.worker.ts` and the consent gate — takes Model A unchanged. The manifest
already declares its parts, its `config` is already opaque to `src/ml`, and the weight cache is
already keyed on the file's hash. This is the seam doing the job it was built for, one model later.

## fp32, not fp16 — and a question about what is already shipped

SEAM's spike measured the quantisation question on the **same backbone family**:

- fp32 exports match PyTorch to 6.7e-6 on WebGPU and 1.6e-5 on WASM, 100% same class per point.
- A naive fp16 conversion flips 13% of points, because the Fourier projection's
  coordinate × frequency `Einsum` loses phase before `sin`/`cos`. Keeping `Einsum`/`Sin`/`Cos` in
  fp32 fixes it on CPU and WASM — 98.5% agreement, every flip a near-tie.
- **fp16 on WebGPU is still wrong**: 34% agreement, mean logit error 0.32, with the same file that
  is fine on WASM. The fault is in the WebGPU fp16 kernels. SEAM's conclusion is *use fp32*.

At 70.6 MB that costs Model A nothing worth arguing about.

**For the affinity model it is a live question, and keeping that path makes it more urgent rather
than less.** The `mixed` variant is an nbits8 encoder and an **fp16 decoder**, and the decoder is
~95% of the runtime. The variant table in [ml.md](ml.md) was measured through ONNX Runtime in
**Python, on the CPU**; the only WebGPU check (`probe:affinity-runtime`) asserts that affinities
land in [0, 1], which a badly wrong fp16 kernel would also satisfy. So the shipped model's accuracy
on the backend it actually runs on has never been measured, and a sibling project has measured the
same arithmetic going wrong there.

**Measured, 2026-11-04 — SEAM's failure does not reproduce in our export.** `pnpm
probe:affinity-backend` ran one set of files on two execution providers: 0.233% of pair decisions
depend on which backend answered, against the 66% of points SEAM saw flip. The numbers, and what
they are and are not a distance from, are in
[ml.md](ml.md#fidelity-on-webgpu-which-the-table-above-does-not-measure); they are not repeated
here, because that is a fact about the runtime and this is a plan.

**What that does and does not license for Model A.** The op SEAM blames — the Fourier projection,
where the coordinate × frequency `Einsum` loses phase before `sin`/`cos` — never runs in fp16 in
our export, because it sits in the encoder and `mixed` quantises that weight-only. But nothing
measured here shows it *would* have broken had it been in the fp16 graph; an export or runtime
that lowers those ops differently from SEAM's predicts the same result, and the variant that would
settle it is not exported.

So the conclusion for Model A rests on **SEAM's own measurement on SEAM's own model**, which is
the right authority for it: Model A is one graph including its own point embedding, so an fp16
export puts that op inside the fp16 graph — SEAM's case exactly, on SEAM's toolchain. **Export
Model A fp32.** At 70.6 MB there is nothing to weigh against it, and an fp16 export would have to
re-establish on our files what SEAM has already established on theirs.

**The shipped affinity model stays as it is.** 0.233% is inside fp16's own 0.793% deviation from
fp32, and a reconversion would buy a difference nobody can see.

## What keeping both costs

Stated so it is a decision rather than a default:

- **Two nodes in the palette doing adjacent things**, which is a question a reader has to answer.
  The labels above carry most of that weight; the guides carry the rest.
- **A help document that has to say what was measured.** `help/affinityClusters.md` currently says
  "read a cluster as a place to look rather than as a finding", which was the honest hedge while
  nothing was measured. Something *is* measured now, and the affinity node's help has to say that
  its checkpoint is at chance on real FlyWire merges and that `seam:findMerges` is the one to
  reach for. Not saying so would be the worse outcome of keeping it.
- **Two input idioms in one pack**, discussed above — acceptable, and worth one sentence in the
  pack's README-equivalent so the next reader does not take it for an accident.
- **`knip` stays quiet only while both nodes are registered.** If the affinity node is ever
  unregistered rather than removed, its modules become unused exports and need baselining.

## Phases

**Phase A — the rename, and one probe.** Both decided, both before the model work.

1. **`proofread` → `seam`**: directory, pack id, both node types, the `/seam` shortcut, the help
   path, the three glob-found files, `packs.test.ts`'s sweeps, and the `NO_EMITTER` excuses in both
   exporters. `seam:affinityClusters` → `seam:affinityClusters` in the same pass.
2. **A WebGPU-versus-CPU parity probe** for the affinity model — `scripts/probe-affinity-backend.mjs`,
   `pnpm probe:affinity-backend`. Done; the result is in the section above and in
   [ml.md](ml.md#fidelity-on-webgpu-which-the-table-above-does-not-measure).

**Phase B — export and verify Model A. Done, 2026-11-04.**

`~/Github/SEAM/scripts/export_onnx.py` is the release exporter for the current model class: one
**fp32** graph per checkpoint, both heads as outputs, the point count a dynamic axis, the manifest
`src/ml` reads, and a `fixture.json` holding one window with PyTorch's logits for it. `A_d256_e80`
comes out at **70.8 MB** and agrees with PyTorch to **7.6e-6** on the point logits on the CPU.

`pnpm probe:seam-model -- --exported <dir>` is the other half, here rather than there because the
backend that matters is the one Coda ships. It runs the exported file through onnxruntime-web
against the fixture — PyTorch's own answer, not another ORT build's — on both providers:

| | max logit error | points on the wrong side | window logit |
| --- | --- | --- | --- |
| WASM | 9e-6 | 0 of 4,096 | agrees, 0 |
| **WebGPU** | **4e-6** | **0 of 4,096** | agrees, 1e-6 |

**So fp32 is sound on WebGPU for the whole single graph, Fourier projection included** — which
rules out those ops being broken on that backend at any precision. It does **not** explain SEAM's
34% fp16 figure: that file already kept `Einsum`/`Sin`/`Cos` in fp32, so its failure was never the
phase loss and remains undiagnosed. Warm, the run is 49 ms against WASM's 370, which is also the
only check available that the graph ran on the GPU at all — onnxruntime-web falls back per node
without saying so.

**No calibration curve ships, and the node must not invent one.** Invariant 14 says a cutoff comes
off a calibration curve, and there is no calibration run for this checkpoint — only test-fold
scores, which are exactly what a cutoff may not be chosen on. `config.calibration` is `null`, so
Phase D has to treat the cutoff as unset rather than defaulting it.

**What is left of this phase:** the 70.8 MB file needs hosting, as the affinity weights were. And
SEAM's audit asks for a parity criterion shaped for a *scorer* — rank deltas on a real candidate
set — where this ships a score-delta bound and classification agreement on one synthetic window,
so `docs/review-fixes.md` keeps that item open.

Still unused from the plan above: `scale_um` 50.2864, `n_points` 4,096, window radius 15 µm,
spacing 0.2 µm — all in the manifest's `config`, read in Phase C and D.

**Phase C — the input path.** Vendor `canonical.py` and `scan.py` into `src/pyodide/` with their
source commit recorded, and a `.ts` wrapper in the house style. A window needs a mesh crop, so this
is where **mesh fetch per window** gets measured; it is the item most likely to decide whether the
node is pleasant to use, and nobody has measured it on either side.

**Phase D — `seam:findMerges`.** The node: meshes in, a per-window table with scores out, a
`Points` output carrying the per-point bipartition, and a layer marking sites. The cutoff param
reads the manifest's calibration curve rather than naming a number. Help, glyph, See also, and the
`packs.test.ts` sweeps.

**Phase E — measure, in Coda.** What the old plan called Phase 3, now against SEAM's own cluster
numbers. If they disagree, the input path drifted — which is the whole reason Phase C vendors the
sampler rather than porting it.
