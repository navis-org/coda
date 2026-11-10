# The `seam` pack — plan

A plan, not a record of what is built.

**This pack and its one node were renamed on 2026-11-04** — `proofread` → `seam`,
`proofread:findMerges` → `seam:affinityClusters` — when SEAM's Model A arrived and the plain name
went to the model that works. Nothing had shipped under the old ids, so there is no `formerTypes`
entry and no migration. [seam-model-a-plan.md](seam-model-a-plan.md) is the plan for that.
The identifiers below are the current ones. Pack id **`seam`**, label **SEAM**: nodes that
look for segmentation errors in a reconstruction and hand the reader somewhere to fix them.

The first node runs Troidl et al.'s **point affinity transformer**
([repo](https://github.com/jakobtroidl/neuron-shape-reasoning), MIT;
[preprint](https://doi.org/10.1101/2024.11.24.625067), CC BY-NC) over a neuron's skeleton points in
the browser, clusters the predicted affinities, and draws the clusters in the Neuroglancer card so
the reader can see where one segment holds two neurons. Later nodes bring other models. The point
of writing the seam down now is that the *second* model must cost a manifest entry, not a rewrite.

> **The pack's live work is now [seam-suggestions-plan.md](seam-suggestions-plan.md)** — SEAM's
> merge candidates (false *splits*), `seam:suggestions` and `seam:review`. This file is about the
> false-*merge* nodes, both of which are retired.
>
> **Both nodes are retired as of 2026-11-09** — `hidden: true`, registered, nothing deleted. The
> models are the reason, not the nodes; the measurements are in
> [Why both nodes are retired](#why-both-nodes-are-retired) at the foot of this file. Everything
> below is the plan as it stood, kept because a retrained checkpoint would walk the same path.

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
src/packs/seam/
  index.ts         the PackDefinition: id 'seam', defaultOn: false
  affinityClusters.ts the node
  affinityOps.ts   preprocessing, pair batching, agglomerative clustering, cluster→label
  pointCloud.ts    skeleton → sampled, centred, scaled point cloud (pure, testable)
  scene.ts         clusters → a neuroglancer local annotation layer + the deep link
  glyphs.ts seeAlso.ts help/affinityClusters.md
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

`seam:affinityClusters`, **`expensive`** — invariant 6 is not negotiable here; a `cheap` node would
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

The reader's path: a `Skeletons` node → **Affinity Clusters** → Neuroglancer. The card shows the segment
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

**Phase 2 — the node and the pack.** `seam` registered, off by default, shortcut `/seam`;
the node, the preprocessing, the clustering, the annotation layer and the deep link; glyph, See
also, help. Help says plainly what Phase 0 and Phase 3 measured, including the training-distribution
caveat. Pack and node tests join `packs.test.ts`'s sweeps.

**The node, as decided.** `seam:affinityClusters`, `expensive`.

- **In:** `Skeletons` (required), and an optional `Layers` so it chains like `Neuroglancer Source`.
- **Out:** `Points` (the sampled cloud, cluster per point — what the model actually saw),
  `Skeletons` (the input re-emitted with a `cluster` attribute, so `Split Neurons`, `Filter` and
  the 3D View work on it with nothing new), `Table` (**one row per neuron**: clusters found,
  background share, mean confidence and the weakest placed point), and `Layers` (the Neuroglancer
  annotation layer). Confidence is the **mean affinity to a point's own cluster**, not to its
  medoid as an earlier draft said: a medoid is one point's opinion, the mean is the cluster's. The per-point
  table the earlier draft named is `Points`; shipping both would be two views of one thing.
- **Several neurons:** each is run, with `ctx.progress` per neuron and Cancel between them, and a
  warning past a measured ceiling. ~20 s each is the thing being bounded.
- **The 406 MB download is opt-in.** A param gates it and the node refuses until it is set — but
  only when the weights are not already cached, so the gate is a first-use question and not a
  permanent mode. `weights.ts` grows a "do you already have this" so the node can tell.
- **The model is a registry entry**, not a URL: `src/ml` holds the known manifests and the node's
  `Model` param is an enum over the ones whose `task` it can read.

**The three numeric params cannot take their defaults from the manifest, and the shape that
works is decided now.** `Points`, `Threshold` and `Minimum cluster size` have authoritative values
in the model's `config` — but `defaultParams` runs at insert and cannot fetch, and invariant 4
forbids `ctx.params.x ?? literal`. So the param table carries **static literals** (1024 / 0.8 /
30, the shipped checkpoint's), and the parsed config is used to **check** them: a model whose
config disagrees with what the card is set to earns a `ctx.warn` naming both numbers. Discovering
this while writing the param table costs the param table.

**The manifest URL is not revision-pinned, and that is a known hole.** `models.ts` names
`…/affinity-flywire-mixed/manifest.json`. Reconvert at that path and every cached result keeps its
provenance key while the answer underneath changes — the weight *cache* is safe, since the sha is
in its key, but the *scheduler* cache is not. Either the URL carries a revision or the row does
and it goes in the key. Settle it before a graph saved by a reader bakes in the unpinned one.

**Two modules the node needs**, named here so they were not improvised inside `evaluate`. Both
exist now, with the shapes below unchanged:

- **`affinityRun.ts`** — build the pair tensor, chunk it, call the runner, assemble the matrix,
  report progress, check `ctx.signal`. Taking the runner as an argument makes all of that testable
  with a fake that returns a known matrix, and it is the only place with a Cancel story: **Cancel
  belongs per chunk** (~0.3 s), not per neuron (~12 s) — `limits.md`' distance row treats six
  seconds as the thing that needed fixing.
- **`checkAffinitySize.ts`** — the wait, priced over the set, through `warnOverWait`, plus a
  refusal derived from `CRASH_FLOOR_BYTES` rather than a minted `MAX_POINTS`. Note the allocation
  is **two** n² Float32Arrays, the matrix and the clustering's working copy.

**Sampling is the model's, not `skeletonPoints.ts`'.** That module samples for *analysis* — equal
spacing so a row count means something and `cable` sums exactly. The model's input distribution is
whatever its training sampler produced: uniform node indices **with replacement**, sorted. Those
are different jobs and only one of them is parity-checked against the checkpoint.

**Units: nanometres, and `voxels` is refused** in `skeletonPoints.ts`' own words. The model's
constants are in µm and a voxel skeleton cannot be converted without a voxel size, so there is
nothing to do but say so.

**And one parity probe, whose shape is decided now because discovering it late costs the phase.**
Preprocessing and clustering will then exist three times: upstream's Python, `probe-affinity.py`'s
`merged_cloud`/`cluster`, and the pack's `pointCloud.ts`/`affinityOps.ts`. The probe's two
functions are the **declared reference** — `probe-affinity.py` says so in its docstring — and
`pnpm probe:affinity-parity` runs `vite-node` over the TypeScript and Python over the reference on
one seed, comparing the cloud point-for-point and the labels label-for-label. **Not a golden
file**, for the reason `scripts/probe-skeletonize.py` already gives: a fixture pins whatever the
implementation happened to produce. The `t`-is-a-distance-threshold trap below is exactly what a
second author re-reading `eval_affinity.py` gets wrong, and exactly what this catches.


## Phase 2 findings — what the node turned out to need

**Built**: `seam:affinityClusters` with `affinityRun.ts`, `checkAffinitySize.ts`,
`affinityTables.ts`, `scene.ts`, `nodeValues.ts`, the pack manifest, the glyph, See also and
`help/affinityClusters.md`. The pack is registered off by default behind `/seam`. Four things the
plan did not have:

- **The `cluster` answer has two forms, and the asymmetry is forced.** A per-node value is a
  `Float32Array` (`SkeletonGeometry.nodeValues`), so the skeleton carries a *number*; a point's
  cluster is categorical and a numeric column would be drawn on a continuous ramp, so the `Points`
  table carries a *word*. `clusterName` is the one spelling of the word half.
- **The per-neuron summary is published twice, from one pair.** It is folded into the `Skeletons`
  output's attributes as well as being the `Table` output, because `Split Neurons` and `Filter
  Table` read an attribute table — so "keep the neurons with more than one cluster" works with
  nothing new only if the finding is a column there.
- **A fifth rail**, `MAX_ANNOTATIONS`, on a tier `limits.md` already had and the plan had not
  looked at: a local annotation layer is a **drawing**, and tens of thousands of points is a frame
  a second. The tail is dropped and counted; the data outputs stay whole.
- **An emitter excuse, in both exporters.** `coverage.test.ts` fails a registered type that is
  neither emitted nor excused, and this one cannot be emitted: a cell would fetch the original
  PyTorch weights and then reimplement the sampler and the cut — a fourth copy of what
  `affinity_reference.py` declares, answering on the notebook's GPU rather than on the card's.

**Open, and deliberately not fixed in Phase 2.** `validate` raises the "tick `Download the model`"
issue whenever the box is off, while `evaluate` refuses only when the box is off **and** the
weights are not already cached. So a reader who has downloaded once and left the box alone sees a
warning on a node that runs perfectly well. `validate` is synchronous and the answer is in
IndexedDB, so the honest fix is a **peek** — start the read you cannot answer, answer `undefined`
meanwhile, re-run inference when it lands (`reportSourceLearned`; `neuronbridge/client.ts` is the
precedent for a non-source using that channel). That is a module and a `peeks.test.ts` entry, which
is a feature rather than a cleanup. Until it exists the symptom is cosmetic — the issue is
`severity: 'warning'`, not a block — but it is a warning that means nothing, which is the thing
this app's warnings are not supposed to be.

**Still open from the plan**: the unpinned manifest URL (above), and `knip-baseline.txt` is down
from ten findings to three — writing the node consumed most of what `src/ml` had sitting unused,
which is the honest test of whether a seam was built too early.

**Phase 3 — validation against reality.** Real merged segments from a dataset where ground truth
exists (proofreading history gives before-and-after root ids), run through the node, scored the way
the paper scores — VOI split/merge and ARAND. This is the phase that decides whether the help
document says "finds merge errors" or "suggests where a segment may hold more than one neuron".
Nothing here writes to production.

**Phase 4 — the second interaction and the second model.** Query-conditioned affinity; and the
contrastive DeepSet head (~5 MB on top of latents we already have) for neuron-type suggestion, which
costs almost nothing once Phase 1 exists and is the cheapest proof that the manifest seam works.

## Phase 1 findings — the browser half

**The measurements moved to [ml.md](ml.md)**, which is where a record of what is built belongs;
CLAUDE.md is explicit that this file is not one. What is left here is only what it means for the
node still to be written.

**The variant is `mixed`** — an nbits8 encoder with an fp16 decoder, 406 MB. int8, which this plan
originally chose, falls off WebGPU onto the CPU and is 16× slower; fp16 is the fastest but twice
the download; and the decoder, at 2% of the bytes and ~95% of the runtime, should not be quantised
at all. [ml.md](ml.md) has the table and how it was measured on a noisy machine.

**What that sets for the node.** A run is the encoder once plus an N² decode, at ~90,000 pairs/s:

| points N | decode | total |
| --- | --- | --- |
| 256 | 0.7 s | ~1.2 s |
| 512 | 2.9 s | ~3.4 s |
| 1024 | 11.6 s | ~12.1 s |
| 2048 | 46 s | ~47 s |

Phase 0's FLOP arithmetic predicted 15–45 s at N=1024 against ~11.6 s measured, so the shape of
that estimate held. **N=1024 is the default** — the training point count, and about ten seconds.

**The guard rail is a wait, priced over the set.** `limits.md`'s tiers put a warning on time and a
refusal only on an allocation, and the allocation here is nowhere near `CRASH_FLOOR_BYTES`: at
N=1024 the affinity matrix is 4 MB and the clustering's working copy another 4 MB, so 512 MB is
not reached until N≈8,000. What binds is N²/90,000 seconds **per neuron, times the neurons** —
`MESH_WARN_SECONDS`' recorded lesson that a cost warning is priced over a set and never over the
one you happen to measure alone. A refusal still exists above it so the tier is not empty.

**Still to measure:** cold-cache download over a real network, peak GPU memory, and a second
adapter. The ranking above is one GPU, files served from localhost.

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
`docs/seam.md`, the derived ceilings to [limits.md](limits.md), the two conversion traps to
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

## Why both nodes are retired

Written on 2026-11-09, after the first end-to-end run of `seam:findMerges` on a neuron somebody
had already proofread by hand. **Neither retirement is about the node.** The input path, the
window geometry and both heads were checked against PyTorch and agree to 4e-6 on WebGPU
(Phase B). What failed is the checkpoint, each in its own way, and that is why the code stays.

### The affinity transformer (`seam:affinityClusters`)

Already known and already in that node's help: trained on synthetic merges — two neurons each
centred on the origin and then offset by about 20 µm — and scored **at chance** on real FlyWire
merges by SEAM's own measurement. A real merge is two neurons in their true positions touching at
one place, which is not the distribution it saw.

### Model A (`seam:findMerges`)

Measured with `pnpm probe:seam-merge`, which fetches a mesh through Coda's own `CaveSource`, tiles
it, scores every cell and prints the scores against a coordinate the reader names. It is the
end-to-end probe Phase D never had.

**The test case.** `648518347586074143` in `wclee_aedes_brain`, a segment with a false merge the
user had already found, at 597152, 333088, 131625 nm. 1,107,768 faces, 105 cells, scores
0.003–0.98, median 0.28.

| cell | distance from the merge | score | minority share |
| ---- | ----------------------- | ----- | -------------- |
| 98   | **1.06 µm**             | 0.28  | 0.21           |
| 84   | 3.7 µm                  | 0.42  | 0.22           |
| 64   | 6.0 µm                  | 0.20  | 0.06           |
| 17   | 7.4 µm                  | 0.04  | 0              |

The cell centred 1 µm from the merge scores 0.28. The three highest-scoring cells on that neuron —
0.98, 0.95, 0.93 — are 18, 49 and 10 µm away from it. Eight of 105 cells score above 0.88 on a
neuron with one known merge.

**The control says the pipeline is sound.** Two FlyWire v783 neurons, in distribution for this
checkpoint: 32 cells with median 0.69 and max 0.996, and 543 cells with median 0.093 and max 0.99.
Both are plausible shapes. So the aedes numbers are the model's answer, not a bug in the tiling or
the scaling.

**The obvious confound, stated rather than resolved.** Model A was trained on FlyWire merges and
aedes is a different volume, a different segmentation and a different animal. Nobody has run this
probe on a FlyWire neuron with a *known* merge, which is the measurement that would separate "the
checkpoint does not generalise" from "the checkpoint does not work". That is the first thing to do
when this is picked up again.

**The per-point head is a second signal and it was never tested.** Cell 98 scored 0.28 and still
put 21% of its points on the minority side, so the two heads disagree where the merge is. `balance`
exists in the window table for this reason. Whether it lands on the crossing neurites is unknown —
it needs looking at in the scene, not more numbers.

### What is kept, and what un-retiring costs

Nothing was deleted. `windowRun.ts`, `windowConfig.ts`, `mergeTables.ts`, `mergeSummary.ts`,
`scene.ts`, the vendored `src/pyodide/seam/` and `seamWindows.py`/`.ts`, both help documents and
all four probes stay, registered and under test. A retrained checkpoint costs an entry in
`models.ts` and the removal of two `hidden: true` lines — which is the thing this pack's seam was
designed for, and the one part of it that was worth the work.
