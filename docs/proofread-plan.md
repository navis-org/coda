# Proofreading pack — plan

A plan, not a record of what is built. Pack id **`proofread`**, label **Proofreading**: nodes that
look for segmentation errors in a reconstruction and hand the reader somewhere to fix them.

The first node runs Troidl et al.'s **point affinity transformer**
([repo](https://github.com/jakobtroidl/neuron-shape-reasoning), MIT;
[preprint](https://doi.org/10.1101/2024.11.24.625067), CC BY-NC) over a neuron's skeleton points in
the browser, clusters the predicted affinities, and draws the clusters in the Neuroglancer card so
the reader can see where one segment holds two neurons. Later nodes bring other models. The point
of writing the seam down now is that the *second* model must cost a manifest entry, not a rewrite.

## What the model actually is

Read off `src/models.py` and `src/datasets.py` in the repo at clone time, not from the paper's prose.

**Architecture** (`ae_d1024_m512`, `depth=24`): points → `PointEmbed` (frequency basis of 90 dims
plus the raw xyz, one `Linear(93, 1024)`) → cross-attention from a learnable `512 × 1024` query set
→ 24 × (self-attention, 8 heads of 64, plus a GEGLU feed-forward of `mult=4`). The decoder gathers
the *point embeddings* for each pair, concatenates them to 2048, cross-attends into the latents
(one head, `dim_head=1024`), and pushes the result through `Linear(2048,2048) → ReLU →
Linear(2048,1) → Sigmoid`.

**Parameters: ~381M.** Per block 2.1M (attention) + 12.6M (feed-forward) = 14.7M, times 24 = 353M;
plus 16.8M for the cross-attend block, 6.3M for the decoder cross-attention, 4.2M for the decoder
MLP, 0.5M for the learnable query. fp32 is 1.52 GB, fp16 760 MB, **int8 381 MB**, int4 weight-only
~200 MB. The published checkpoints are ~4.5 GB because they carry Adam state.

**The small checkpoints do not exist.** `data/README.md` publishes three affinity checkpoints —
FlyWire, MANC, hemibrain — all `ae_d1024_m512`. `d512_m512` and `d1024_m256` are *training* scripts
under `scripts/flywire/ablations/` and nothing else. So "smaller" can only mean quantising the one
that exists.

**Preprocessing, exactly** (`NeuronDataset.__getitem__`): skeleton nodes converted to **µm**;
sampled `randint` **with replacement** and sorted, 1024 per neuron; each neuron centred on its own
centroid, jittered by 1 µm, translated by a random vector of norm 20 (FlyWire) or 60 (hemibrain) µm;
the merged cloud randomly rotated; then divided by the global scale **659.88367** so coordinates
land in [−1, 1]. Padding points sit at (−1,−1,−1) with `mask = 0`. Clustering is average-linkage
agglomerative on `1 − A` with threshold **t = 0.8**, then clusters under **30 points** are folded
into a background class (`misc.remove_small_clusters`).

### Three things that will bite, stated before anyone measures

- **The training distribution is not a merge.** Each component is centred on the origin *and then*
  offset by ~20 µm, so a training "merge" is two neurons superimposed near a shared centroid. A real
  merge is two neurons in their true relative positions, touching at one place. The model reasons
  about shape and may well transfer, but **nothing in the paper measures that**, and a node that
  claims to find merges on real data must be probed against real merges before it says so. This is
  the largest risk in the plan and it belongs in the help document, not just here.
- **The decode is the cost, not the encoder.** The encoder is ~390 GFLOP, paid once, under a second
  on WebGPU. The decoder costs ~15 MFLOP per pair that cannot be factored out of the pair (the
  `to_q` on the concatenated pair *is* separable into a per-point projection plus an add, but the
  attention, `to_out` and the 2048-wide MLP are not). So N² decoding is the whole bill:

  | points N | pairs | decode | expectation |
  | --- | --- | --- | --- |
  | 256 | 65k | ~1 TFLOP | a second or two |
  | 512 | 262k | ~4 TFLOP | several seconds |
  | 1024 | 1.0M | ~15 TFLOP | tens of seconds |
  | 2048 (their eval default) | 4.2M | ~63 TFLOP | minutes |

  Every number in that table is **arithmetic, not a measurement**. Phase 1 replaces it with
  measurements or the ceilings are guesses, and [limits.md](limits.md) does not take guesses.
- **`eval_affinity.py` re-runs the encoder 50 times.** It chunks the pairs and calls
  `model(pc, mask, chunk)` per chunk, so the 24 self-attention layers run once per chunk. Exporting
  encoder and decoder as **two ONNX graphs** gets that back for free and is the only reason the
  browser budget works at all. It also means the latents can be computed once and kept while the
  reader asks several questions of the same neuron.

## Decisions taken

| | |
| --- | --- |
| Where inference runs | The browser, WebGPU, in a Web Worker. No server. |
| Model size | **int8**, ~381 MB, from the published `ae_d1024_m512`. |
| Weights | Converted by us from the public Google Drive checkpoints. |
| Datasets | **Dataset-agnostic**: a model declares which datasets it is for; the node says so. |
| Input | **Skeletons only.** A mesh-only dataset is refused with a sentence saying why. |
| Fixing | **Read-only.** Coda draws the clusters and deep-links into the dataset's own proofreading viewer. Nothing writes to a live segmentation. |

The read-only decision is the standing "never write to production" rule, and it is also the honest
one: a model whose transfer to real merges is unmeasured must not be wired to a chunkedgraph split.

**Where the weights live.** Phase 0 hands over a converted file; it goes on one of our own servers
and the URL comes back into the manifest. If the model is ever retrained (below), a GitHub release
with the weights attached as an artefact is the likely home — versioned, CORS-open, and the release
tag is the manifest's revision. The options weighed, kept for whenever that decision is revisited:

- **Hugging Face Hub.** Free, CORS-open, versioned, resolves to a stable
  `https://huggingface.co/<repo>/resolve/<rev>/<file>` URL, byte-range capable, and gives the
  conversion a citable public artefact others can reuse. A third-party dependency at runtime, and
  the repo needs an owner.
- **A bucket we control (GCS / S3 / Cloudflare R2).** Same kind of place the connectome data already
  comes from, we set CORS and `Cache-Control` ourselves, no third party. Costs egress (381 MB per
  cold reader) and someone owns the bill. R2 has no egress fee, which makes it the cheapest of the
  three.
- **Beside the deployment.** Simplest to reason about, but it puts 381 MB in the repo or the build
  and `deploy.yml` is not sized for that. Not recommended.

Until it is settled the manifest carries a placeholder URL and the probe reads from a local file.

## The seam: `src/ml`

Headless, under the `eslint.config.js` boundary like `src/core` and `src/data` — no React, no store,
no UI. This is what the second model costs a manifest entry instead of a rewrite.

```
src/ml/
  manifest.ts      ModelManifest — one entry per model: id, url, sha256, bytes, licence,
                   citation, input/output signatures, which datasets it applies to.
  weights.ts       fetch → verify sha256 → keep in IndexedDB (idb.ts' plumbing, its own
                   database) → hand back an ArrayBuffer. Progress reported, resumable,
                   never fatal: a failed cache write is a slow next session, not an error.
  runtime.ts       ONNX Runtime Web, WebGPU EP, created once per model, disposed on idle.
  session.ts       run(graph, feeds) with a cancel signal; chunking is the caller's.
  support.ts       hasWebGPU(), adapter limits — what the node asks before offering to run.
  infer.worker.ts  the one worker; the main thread never holds a session.
src/packs/proofread/
  index.ts         the PackDefinition: id 'proofread', defaultOn: false
  affinity.ts      the node — proofread:findMerges
  affinityOps.ts   preprocessing, pair batching, agglomerative clustering, cluster→label
  pointCloud.ts    skeleton → sampled, centred, scaled point cloud (pure, testable)
  scene.ts         clusters → a neuroglancer local annotation layer + the deep link
  glyphs.ts seeAlso.ts help/findMerges.md
```

Two rules make this a seam rather than a folder:

- **A model is data.** `ModelManifest` is the only place a URL, a hash, a threshold or a dataset
  list appears. A node names a model id; it never names a URL. The second model is a manifest entry
  plus a node.
- **The runtime never knows what a model is for.** `session.ts` takes tensors and gives tensors.
  Preprocessing, chunking and clustering are the pack's, because they are facts about *this* model's
  training, and the next model's will differ.

`onnxruntime-web` is a new dependency and a real one: ~10–20 MB of wasm and JS. It must be
**dynamically imported** from the worker so that nothing on the main chunk — and nothing in
`nodes.html` or the MCP build — pulls it in. [pages.md](pages.md) and the `nodes.html` rule in
[packs.md](packs.md) are the precedent; `src/packs/**` is imported by the MCP build, which stays
headless, so the import must be behind the worker boundary and the knip baseline must say so.

### The node

`proofread:findMerges`, **`expensive`** — invariant 6 is not negotiable here; a `cheap` node would
fire a 381 MB download and a WebGPU run on every keystroke.

- **In:** `Skeletons` (required). One item per run; a value holding several is iterated or refused —
  decide in Phase 2 against the per-run cost measured in Phase 1.
- **Params:** `Points` (how many to sample, default from the measurements, with the warn and refuse
  tiers derived — `CRASH_FLOOR_BYTES` is 512 MB and the decode's intermediates are the allocation to
  size against); `Threshold` (t, default 0.8, the paper's); `Minimum cluster size` (default 30);
  `Model` (an enum over the manifest entries that apply to the wired dataset).
- **Out:** a `Table` — one row per sampled skeleton point: `point`, the skeleton's own index,
  position, `cluster`, and the point's affinity to its own cluster's medoid as a confidence. Plus a
  `Layers` output carrying the neuroglancer annotation layer, so it wires straight into the existing
  Neuroglancer card's `Extra layers` socket rather than needing a viewer of its own. That socket
  takes arbitrary layer specs (`buildScene`'s `extraLayers`), and a **local annotation layer with
  inline points needs no server** — which is the whole reason this display route is cheap.
- **Refusals, each its own sentence:** no WebGPU; the dataset has no skeleton route
  (`requireSkeletonRoute` already speaks this language); the wired dataset is not one the chosen
  model declares; the skeleton has fewer points than the floor.
- **`ctx.warn`, not refuse:** the point count is above where it was measured; the model's dataset
  list does not include this one but the reader chose it anyway; more than four clusters came back
  (out of distribution per the paper's own ablation, and biased to under-segmentation there).

The reader's path: a `Skeletons` node → **Find Merges** → Neuroglancer. The card shows the segment
with the predicted clusters as coloured point annotations over it, and the node's state bar carries
the link into the dataset's own proofreading viewer.

### The second interaction, nearly free

`M(P, q)` — affinities of every point against **one** point — is ~1000 pairs, about 20 GFLOP, and
reuses latents already computed. That is "click a point, see what the model thinks belongs with it",
at interactive speed, and it is a far better fit for a reader checking a specific branch than a
full re-cluster. It is **not** in Phase 2; it is the reason the latents are kept rather than
discarded after a run, and it should land as a second node or a card interaction once the first is
measured. Noting it now so the session cache is built to allow it.

## Phases

Each milestone ends with the standing order: **2 × `/simplify`, then 2 × `/code-review medium`.**

**Phase 0 — conversion, offline, no app code.** `scripts/convert-affinity-model.py`: load the
checkpoint, export encoder and decoder as separate ONNX graphs with dynamic N, quantise to int8,
emit the manifest entry with the sha256. `scripts/probe-affinity.py` runs PyTorch and ONNX on the
same fixtures and compares affinities and, more importantly, the *clusterings* they produce — a
sigmoid near 0.8 is where int8 error shows up as a different answer, and a mean absolute error on
the affinities would hide it. Deliverable: the ONNX files, measured agreement, and a decision on
whether int8 survives. If it does not, fall back to fp16 for the decoder MLP only and re-measure.

**Phase 1 — the runtime, measured.** `src/ml` with a trivial model end to end, then the real
encoder: `pnpm probe:affinity-runtime` in headless Chrome with real WebGPU (jsdom has none, and SwiftShader
is not a measurement — [canvas.md](canvas.md)'s rule) reporting cold-cache download, warm start,
encoder time and decode time per N across a few GPUs. **The table above is replaced here.** The
ceilings in [limits.md](limits.md) come out of this, derived, not picked.

**Phase 2 — the node and the pack.** `proofread` registered, off by default, shortcut `/proofread`;
the node, the preprocessing, the clustering, the annotation layer and the deep link; glyph, See
also, help. Help says plainly what Phase 0 and Phase 3 measured, including the training-distribution
caveat. Pack and node tests join `packs.test.ts`'s sweeps.

**And one parity probe, whose shape is decided now because discovering it late costs the phase.**
Preprocessing and clustering will then exist three times: upstream's Python, `probe-affinity.py`'s
`merged_cloud`/`cluster`, and the pack's `pointCloud.ts`/`affinityOps.ts`. The probe's two
functions are the **declared reference** — `probe-affinity.py` says so in its docstring — and
`pnpm probe:affinity-parity` runs `vite-node` over the TypeScript and Python over the reference on
one seed, comparing the cloud point-for-point and the labels label-for-label. **Not a golden
file**, for the reason `scripts/probe-skeletonize.py` already gives: a fixture pins whatever the
implementation happened to produce. The `t`-is-a-distance-threshold trap below is exactly what a
second author re-reading `eval_affinity.py` gets wrong, and exactly what this catches.

**Phase 3 — validation against reality.** Real merged segments from a dataset where ground truth
exists (proofreading history gives before-and-after root ids), run through the node, scored the way
the paper scores — VOI split/merge and ARAND. This is the phase that decides whether the help
document says "finds merge errors" or "suggests where a segment may hold more than one neuron".
Nothing here writes to production.

**Phase 4 — the second interaction and the second model.** Query-conditioned affinity; and the
contrastive DeepSet head (~5 MB on top of latents we already have) for neuron-type suggestion, which
costs almost nothing once Phase 1 exists and is the cheapest proof that the manifest seam works.

## Phase 1 findings — the browser half

Measured on an Apple **metal-3** adapter via `pnpm probe:affinity-runtime`, which drives headless
Chrome over the DevTools protocol. Two things about that harness are load-bearing and both were
found the hard way:

- **Headless Chrome gives a real GPU for WebGPU on macOS.** [canvas.md](canvas.md)'s "headless
  Chrome is SwiftShader" holds for WebGL and *not* for WebGPU here, so these timings are honest.
  The probe reports the adapter every run, so a software adapter can never be mistaken for a GPU.
- **The page must be on an http origin.** On `about:blank` `navigator.gpu` is simply absent, which
  reads exactly like "this Chrome has no WebGPU" and produced a false negative before it was
  caught. The probe serves a directory on localhost for this reason alone.

### Which variants the browser can actually run

| variant | size | encoder @ N=1024 | decoder pairs/s | full 1024² decode |
| --- | --- | --- | --- | --- |
| **mixed** (nbits8 encoder, fp16 decoder) | **406 MB** | 513 ms | **89,201** | **11.8 s** |
| fp16 | 762 MB | 123 ms | 88,074 | 11.9 s |
| nbits8 | 396 MB | 505 ms | 30,845 | 34.0 s |
| nbits4 | 206 MB | 493 ms | 32,814 | 32.0 s |
| int8 | 384 MB | **8,402 ms** | 2,605 | 402 s |

**int8's fallback is now measured rather than inferred**: 16× slower encoder, 13× slower decode,
exactly as the `MatMulInteger` op inventory predicted. It is out, and the plan's original choice
of it was wrong for a reason no fidelity measurement could have surfaced.

**Two surprises overturn the Phase 0 reading.** fp16 is the *fastest* variant, not the slowest —
weight-only quantisation must dequantise on the fly, which costs ALU, while fp16 hits native
half-precision throughput. And nbits4 is no faster than nbits8, so 4 bits buys size alone and the
fidelity it costs (ARI 0.884) buys nothing back.

### The answer: quantise the encoder, leave the decoder alone

The decoder is **2% of the bytes and ~95% of the runtime**. Those are opposite ends, so one recipe
for both parts was always the wrong shape:

> **mixed — 406 MB, 11.8 s, ARI 1.0000 against fp32.** It takes nbits8's encoder (385 MB, where
> the bytes are) and fp16's decoder (21 MB, where the time is).

It is not a compromise but a dominating choice: fp16's speed at 53% of its download, nbits8's
exact clustering for +10 MB, and measured fidelity identical to nbits8 (meanAbs 0.0029, 0.070% of
pairs crossing t, VOI 0) because the quantisation error lives in the 24-layer encoder and not in
the 2-layer decoder. `VARIANTS` in the converter is keyed per part so this is a row, not a special
case.

### What this sets for the node

A run is the encoder once plus an N² decode, so at the measured 89k pairs/s:

| points N | decode | total |
| --- | --- | --- |
| 256 | 0.7 s | ~1.2 s |
| 512 | 2.9 s | ~3.4 s |
| 1024 | 11.8 s | ~12.3 s |
| 2048 | 47 s | ~47.5 s |

Phase 0's FLOP arithmetic predicted 15–45 s at N=1024 against 11.8 s measured, so the shape of
that estimate held. **N=1024 is the default** — the training point count, and about ten seconds.
The warn tier belongs just above it and the refusal well above; both go in
[limits.md](limits.md) derived from this table rather than picked.

Still to measure in Phase 1: cold-cache download over a real network (the figures above are
localhost), peak GPU memory, and whether a second adapter — a discrete NVIDIA or an Intel iGPU —
changes the ranking. Nothing above should be read as cross-platform until it is.

## What this plan does not do

- No chunkedgraph writes, in any phase.
- No `src/ml` abstraction beyond what two models need. [packs.md](packs.md)'s rule — seams are built
  when a pack needs them — applies; the manifest and the worker are the two that are needed twice
  by construction, everything else waits.
- No training. **Retraining is a separate project**, and a likely one: real merges from FlyWire's
  split history are better training data than the paper's synthetic superpositions, and a slimmed
  architecture (`d512_m512` is 75M params, ~75 MB int8, at a published VOI cost of 0.09/0.12 against
  0.07/0.10) would make the download a non-issue. The pack must be ready to take that checkpoint as
  **a manifest entry and nothing else** — which is also what several models for one task, each
  trained on one connectome, already requires, so the seam is paid for either way. Nothing in the
  node may assume there is one model, one dataset, or one point count.

## Phase 0 findings

**These are measurements, and this file is a plan.** CLAUDE.md is explicit that `docs/*-plan.md`
are "plans and surveys, not records of what is built", so when this plan is retired after Phase 2
the measurements below must move rather than go with it: the sizes and op inventory to
`docs/proofread.md`, the derived ceilings to [limits.md](limits.md), the two conversion traps to
the converter's own docstring where the next person to run it reads them, and the weight-only
generalisation to wherever `src/ml` is documented — it is about models in general, not this one.

Measured, not estimated. `scripts/convert-affinity-model.py` and `scripts/probe-affinity.py`;
`pnpm convert:affinity` and `pnpm probe:affinity-export`. Both need torch, onnx, onnxruntime,
onnxconverter-common and scikit-learn, which the repo does not carry — a venv, as for the Jaxley
reference.

**What a checkpoint is, is not the converter's to invent.** `scripts/affinity-checkpoints.json`
holds one entry per published checkpoint — architecture, datasets, licence, citation, and the
training constants — and the converter copies it into the manifest, adding only the files, their
hashes and the parameter count. Before that split existed the converter took a `--dataset` flag
and wrote FlyWire's constants into whatever manifest it produced, so converting the hemibrain
checkpoint emitted a confident and wrong `translate`: **20 µm for FlyWire** (absent from its train
script, because it is `train_affinity.py`'s default — the kind of fact that is invisible unless
written down), **60 for hemibrain, 70 for MANC**, against a `globalScale` of 659.88367 that really
is shared by all three. A second model is now an entry in that file plus a run, which is the
property the whole seam exists to buy, demonstrated in Phase 0 rather than asserted in Phase 2.

**The architecture is 380,577,793 parameters**, against the 381M the arithmetic above predicted.
Exported sizes, encoder plus decoder: fp32 1523 MB, fp16 762 MB, int8 384 MB, nbits4 206 MB.

**The ONNX export is faithful.** fp32 through ONNX Runtime reproduces PyTorch to a maximum absolute
affinity difference of 1e-4 over a full N×N matrix, and an identical clustering. So everything
below is quantisation error and not a conversion bug — which is the only reason the fp32 variant is
worth its 1.5 GB.

**`t` is a distance threshold, not an affinity cut.** `eval_affinity.py` computes
`pred_dists = 1.0 - pred_aff` and hands `t` straight to `AgglomerativeClustering`, so the paper's
`t = 0.8` links points whose average affinity exceeds **0.2**. Reading it as an affinity threshold
silently over-fragments every clustering, and nothing about the output says so.

**Two conversion traps, both silent until they are not:**

- `onnxconverter_common`'s fp16 pass with `keep_io_types=True` leaves the decoder's `norm_context`
  LayerNormalization with one fp32 and one fp16 input, and ORT refuses to load the model. fp16 is
  exported from a halved torch module with casts at the boundary instead.
- The checkpoint carries the training run's `argparse.Namespace` beside the state dict, which
  `weights_only=True` rejects. That one class is allowlisted rather than the protection turned off:
  it is a downloaded pickle, and `torch.load` on one of those is arbitrary code execution.

### Which quantisation the browser can actually run

The op inventory decides this, and it cuts against the obvious choice:

| variant | the matmul op it emits | WebGPU | size |
| --- | --- | --- | --- |
| fp16 | `MatMul` (126 in the encoder) | native | 762 MB |
| int8 | **`MatMulInteger`** (126) + `DynamicQuantizeLinear` (102) | **not implemented** | 384 MB |
| nbits4 | `MatMulNBits` (126) | accelerated | 206 MB |

Dynamic int8 quantisation emits `MatMulInteger`, which ORT's WebGPU backend does not implement, so
every matmul in the encoder would fall back to the CPU — the whole 390 GFLOP encoder on wasm. **The
best size-for-accuracy variant is the one that cannot run on the chosen backend**, and nothing about
it fails loudly: it loads, it answers, it is merely unusably slow. This is why Phase 0 produces
candidates and Phase 1 picks, rather than the other way round.

### The answer: weight-only 8-bit, and why it beats fp16

`MatMulNBits` at 8 bits — weight-only, block size 128 — was missing from this plan, and it wins on
every axis at once. Measured against fp32 PyTorch over ten two-neuron cases on one seed
(`pnpm probe:affinity-export`):

| variant | size | mean abs. error | max | pairs crossing t | ARI | same clustering |
| --- | --- | --- | --- | --- | --- | --- |
| **nbits8** | **396 MB** | **0.0029** | **0.045** | **0.071%** | **1.0000** | **10/10** |
| fp16 | 762 MB | 0.0219 | 0.245 | 0.793% | 0.9707 | 10/10 |
| int8 | 384 MB | 0.0260 | 0.338 | 1.036% | 0.9587 | 10/10 |
| nbits4 | 206 MB | 0.0476 | 0.571 | 2.052% | 0.8839 | 10/10 |

**nbits8 is 7.5× more accurate than fp16 at half the size**, and reproduces fp32's clustering
*exactly* in every case — ARI 1.0000, VOI 0. That reads as a mistake until you look at what each
one quantises. fp16 halves *everything* — weights, activations, the attention einsums, 24 layers
of residual accumulation at D = 1024 — and the error compounds down the stack. `MatMulNBits`
quantises **weights only**: activations and accumulation stay fp32, so the only error is the
block-wise weight rounding, and 8 bits with a block of 128 is plenty for that. The lesson
generalises to whatever model comes next, so it belongs here rather than in a commit message:
**on a deep residual stack, weight-only quantisation beats halving the arithmetic.**

So fp16 is both larger and worse and is now only a fallback; the real risk left is narrow: whether
ORT Web's WebGPU `MatMulNBits` covers 8 bits and not only 4. If it does not, the choice collapses
to nbits4 at 206 MB — whose clustering is visibly worse — or fp16 at 762 MB. Phase 1 settles it on
a real GPU.

### What these numbers do *not* say

**Phase 0 cannot measure accuracy loss on real data, and did not.** The inputs are synthetic
branching trees at 192 points against 4288 in training. On those fixtures the model separates the
two planted neurons in **5 of 10 cases** and merges them into one in the other five
(`VOI_m ≈ 0.69`, one cluster) — under-segmentation, which is the very error class the pack exists
to find. That is a statement about synthetic trees at a twentieth of the training point count, not
about the model: nothing here licenses a claim either way, and Phase 3 is where it is settled on
real skeletons.

What the measurement *is* good for is the comparison, because every variant sees the same clouds:
all four agree with fp32 on which cases separate and which do not, and the ranking by mean absolute
error is stable because it never passes through the clustering at all.

**An earlier version of this section reported worse and noisier numbers** — fp16 at ARI 0.866, one
case at −0.0006 — from a reference that omitted the paper's **global random rotation**. Upstream
applies it unconditionally, outside the `if self.train` guard, so it is part of the evaluation
distribution too; without it the probe was measuring a distribution the checkpoint had never seen,
and the model sat on its decision boundary. Fixing it raised every variant's agreement and is why
the clustering column above is 10/10 rather than ragged.

One thing this does say about the node, though: **the clustering is sensitive near the
threshold.** It is milder than the pre-rotation numbers suggested — every variant now agrees with
fp32 on how many objects each case holds — but nbits4 still moves 2% of pair decisions and lands
at ARI 0.884, meaning points change cluster even where the count does not. A card that presents
cluster membership as a crisp finding would be overstating what the model produces. That is a
design constraint on Phase 2, not just a caveat.
