# The model runtime (`src/ml`)

What `src/ml` is, what it refuses to know, and what was measured. Read this before adding a model
or a second task. The point affinity transformer that drove it out is in
[seam-plan.md](seam-plan.md) until the pack lands; the numbers below are facts about the
runtime and belong here.

`src/ml` runs an ONNX model in the browser on WebGPU. It is **one worker, one manifest and a
verified cache** — and it is deliberately ignorant of what any model is for.

## The seam: what a manifest may and may not carry

A manifest is written by a conversion script and served beside its graphs. Everything about a
model is in it, and it is split in two:

| `src/ml` reads | `src/ml` never reads |
| --- | --- |
| `id`, `manifestSchema`, `task`, `parts`, `signatures`, `files` (path, `url`, `bytes`, `sha256`, `quantisation`), `datasets`, `license`, `citation`, `source`, `upstreamCommit`, `randomWeights` | `config` |

`config` is an opaque blob the converter copies verbatim and the owning pack parses. A point
affinity model's point sampling, global scale and clustering threshold live there.

**This split was learnt one level down.** The converter's `VARIANTS` table claimed to be keyed per
part and was not, so the one mixed recipe that turned out to be right could not be expressed. A
seam that names one task's vocabulary makes the same mistake a level up, and the test for it is
the next model: a one-graph DeepSet head on the encoder's latents. So:

- **A part is a string the manifest declares**, not a union this code fixes. `parts: ['encoder',
  'decoder']` for the affinity model, `parts: ['embed']` for the type head. `manifest.test.ts`
  pins that a one-graph model loads, because that is the property the directory exists for.
- **A required `preprocessing` block would force a schema bump on every new task**, and a schema
  bump refuses every manifest already built. Hence `config`.

**A file resolves against the manifest's own URL** (`new URL(file, manifestUrl)`), so one uploaded
directory works at any host, behind any path, without a converter or a human knowing where it will
live. `url` on a file entry overrides that, for a file not served beside its manifest.

**Re-typing a tensor name is how a renamed output becomes an error nobody connects to the rename.**
`signatures` carries the names and dynamic axes per part; the worker, the session and the probes
read them rather than spelling them.

## Weights

**Verified before they are kept.** A downloaded body is hashed and compared with the manifest's
`sha256` before it is cached or used — a truncated or proxy-mangled body otherwise produces a
session that loads and answers *wrongly*, which is worse than one that fails. The Python probe on
the other side of this seam caught exactly that from a one-byte difference.

**A cache hit is not re-hashed.** The key contains the sha256, so a hit was verified when it was
written; hashing 385 MB again costs 0.2 s with SHA extensions and over a second without, on every
open, to detect a corrupted store the caller can do nothing about. The length is checked instead,
and ONNX Runtime refuses a mangled graph anyway.

**Never fatal, and its own database.** A cache that cannot be opened, written or read looks exactly
like a miss — `src/data/cache.ts`' rule. The store is `coda-models`, separate so a quota refusal on
400 MB of weights cannot evict the dataset cache, and it declares `SizedBy` so the Memory dialog's
Storage tab can add it up without deserialising a single 385 MB record.

**One download per key** (`memoPromise`, `keep: 'inflight'`): two cells opening one model are one
fetch. Only while in flight — a resolved entry would pin 385 MB for the tab's life. The write is
**not awaited**, because nobody is waiting on it and the structured clone plus disk write is
seconds between the download finishing and the session being created.

**The buffer is allocated once, at the size the manifest declares.** Accumulating chunks and
joining them peaked at twice the body — 770 MB for this encoder — with a 385 MB memcpy on top.
`Content-Length` is deliberately not used for the size: absent under chunked encoding, wrong behind
a recompressing proxy.

## The worker

**`onnxruntime-web` is ~20 MB and is reached only by a dynamic `import()` inside
`infer.worker.ts`.** A static import in a module the main thread can reach would put it in the main
chunk, and through `src/packs/**` into the MCP build and the static pages.

**That rule is a test, not a comment, and only because `session.ts` owns the worker literal.**
`src/test/importGraph.test.ts` finds every worker by scanning for `new Worker(new URL('…'))`. While
that literal lived in a doc comment and the factory was passed in by the caller, this worker was
not in `WORKERS` and its import graph was never walked — the rule was stated and unenforced. Every
module here that owns exactly one worker writes its own literal (`pyodide/engine.ts`,
`nodes/lib/arborDaylight.ts`, `data/files/client.ts`); only a *generic* helper takes a factory.

**Big tensors do not cross the boundary.** A graph's output can be held in the worker under a name
(`hold`) and fed into the next graph (`use`). The encoder/decoder split exists so the latents are
computed once; a protocol that returned them would ship 6.3 MB back and forth *per decode call* —
hundreds of megabytes over one run, re-uploaded to the GPU each time. Worse, feeds are
**transferred**, so a returned tensor is detached on the main thread and a second call with it
throws. What crosses is the pair indices in and the affinities out.

**Long-lived and multiplexed**, so not `data/workerJob.ts`' one-shot shape — that file says why
Pyodide keeps its own, and this is the same reason: one encoder pass, then thousands of decoder
calls against its latents.

**Cancelling terminates.** A `session.run` inside ONNX Runtime has no interrupt point a message
could reach, which is the conclusion `workerJob.ts` came to for Python.

**A messageless `onerror` has two readings** and they are told apart, not merged: before the worker
has answered anything it is `notLoaded` (its code failed to fetch — a page open across a deploy);
after, it is `stopped` (its code ran and something killed it, nearly always memory). A 385 MB
WebGPU session is the likeliest OOM in the app, so always blaming a stale deploy would be wrong
most of the time. `onmessageerror` is set too: a result the page cannot deserialise arrives as
neither a message nor an error, and without it the request never settles.

## WebGPU, and why there is no CPU fallback

`support.ts` refuses before anything is downloaded, in one sentence, and the sentence distinguishes
"this browser has no WebGPU" from "this page is not on a secure origin" — they are fixed
differently. `navigator.gpu` is absent on an insecure origin, **including `about:blank`**, which
cost a false negative while measuring.

The CPU path is not a degraded mode but a different product. Measured on an Apple metal-3
adapter, best of five per timing, and every figure below reproduced across two independent runs:

| variant | matmul op | size | encoder @ N=1024 | pairs/s | full 1024² decode |
| --- | --- | --- | --- | --- | --- |
| **mixed** (nbits8 encoder, fp16 decoder) | both | **406 MB** | 500 ms | **~90,000** | **~11.5 s** |
| fp16 | `MatMul` | 762 MB | 122 ms | ~93,000 | ~11.3 s |
| nbits4 | `MatMulNBits` | 206 MB | 488 ms | ~37,700 | ~27.8 s |
| nbits8 | `MatMulNBits` | 396 MB | 498 ms | ~32,000 | ~32.5 s |
| int8 | `MatMulInteger` | 384 MB | **8,050 ms** | ~2,600 | ~404 s |

**int8 is the trap.** WebGPU does not implement `MatMulInteger`, so it falls to the CPU — and it
does not fail, it answers, 16× slower on the encoder and 35× on the decoder. Which variant a
browser can *run* cannot be read off a fidelity measurement.

**Two surprises worth carrying to the next model.** fp16 is the *fastest*, not the slowest:
weight-only quantisation dequantises on the fly and costs ALU, where fp16 hits native
half-precision throughput. And a narrower quantisation buys no speed — nbits4 and nbits8 are
within 15% of each other and both ~3× slower than fp16 — so four bits buys size alone. Together
those say the decoder, 2% of the bytes and ~95% of the runtime, should not be quantised at all.
That is what `mixed` is, and its fidelity is identical to nbits8 (ARI 1.0000 against fp32)
because the error lives in the 24-layer encoder, not the 2-layer decoder.

### Fidelity on WebGPU, which the table above does not measure

**Every fidelity number in this file was taken on the CPU** — `probe:affinity-export` drives ONNX
Runtime in Python — and the timings above are WebGPU. For a long time nothing checked that the two
describe the same answers: `probe:affinity-runtime` asserts only that affinities land in [0, 1],
which a badly wrong kernel satisfies as well as a right one.

The reason to check was a sibling project. SEAM (`~/Github/SEAM`) exported the **same backbone
family** and found fp16 **correct on WASM and wrong on WebGPU** from one file — 34% agreement,
mean logit error 0.32 — and concluded "use fp32 for now". `mixed` has an fp16 decoder carrying
~95% of the runtime.

`pnpm probe:affinity-backend` settles it: one set of files, two execution providers, identical
inputs, on apple/metal-3 at N = 1024.

| | mean abs. error | worst pair | pair decisions moved |
| --- | --- | --- | --- |
| nbits8 encoder, WASM vs WebGPU | 4.5e-5 | 0.015 | — (no cut on latents) |
| fp16 decoder, same latents | 0.0025 | 0.065 | **0.233%** |
| the whole chain | 0.0025 | 0.063 | **0.233%** |

**Two independent runs agree exactly** — the same 2,441 and 2,439 pairs, every figure identical —
which is more than this file's usual "two runs agree" bar asks for and is itself a fact: the
divergence is a deterministic property of the two backends' kernels, not GPU nondeterminism, so a
rerun on this adapter will not wander. It says nothing about another adapter.

**SEAM's failure does not reproduce.** 0.233% of pair decisions depend on which backend answered,
against the 66% of points SEAM saw flip — three orders of magnitude apart. Read against the pairs
that could move at all, 9.2% sit within 0.05 of the cut and **2.5% of those** change side.

**Every pair that moved was one of those.** All 2,441 crossings had their CPU affinity within
0.05 of the cut — not one pair the model was confident about changed side. So the backend
difference does not reach a decision the affinities themselves made firmly; it redistributes the
ones that were already on the line, which is the same population any rerun of the clustering at a
slightly different threshold would move.

**Why it does not reproduce is not settled, and an earlier draft of this section got the reason
wrong.** SEAM reports **two** fp16 failures, and they are different. A naive fp16 conversion
flipped 13% of points *on the CPU*, and that one was traced to the Fourier projection, where the
coordinate × frequency `Einsum` loses phase before `sin`/`cos`; keeping those ops in fp32 fixed
it. **The file with that fix in it is still 34% wrong on WebGPU while being fine on WASM** — so
the WebGPU failure is a second, undiagnosed fault in that backend's fp16 kernels, and it is not
the phase loss.

That matters for what our result can claim. The phase loss cannot occur here, because the Fourier
op sits in the encoder, which `mixed` quantises weight-only (`point_emb` comes back bit-identical
across backends). But the failure we were actually looking for is the *other* one, and the only
honest statement is that our fp16 decoder does not hit it — not why. An export, opset or ORT
version that lowers things differently from SEAM's predicts the same observation, and so does a
decoder too shallow to accumulate the error. Settling it needs a run against a **full fp16
variant**, which is not exported. Note too that what keeps the Fourier op out of fp16 is per-part
quantisation, which the split *enabled*; two fp16 graphs would be just as split and just as
exposed.

**What the number is not.** It is a distance from WASM, not from fp32, so it cannot be added to
the CPU figures above or read as a distance from full precision. Measuring that would need an
fp32 reference run on WebGPU, which this probe does not do.

**`preferredVariant`'s rule is weaker than it reads.** "Smallest runnable" treats runnable as a
property of the op inventory, and int8 already showed that a variant can run and be useless. This
adds the other half: every fidelity figure a manifest carries was taken on the CPU, so a variant
can be complete, fast and accepted while being measurably less accurate on the backend that will
run it. Fidelity per backend is not in the manifest and must not be inferred from it.

### Trusting a timing on a noisy machine

**Every timing is the best of five, and the probe publishes its spread.** A single-shot run of
this probe read 12× slow and *inverted the ranking* — slow enough to have chosen the wrong
variant — because this machine runs corporate endpoint security that takes 80% of the CPU in
bursts, at a standing load average of 14–20. The minimum is the least contaminated sample;
`spreadMs` and `decoderSpread` say how noisy the run was, so a bad set is visible in the report
rather than silently believed.

**Two cross-checks catch what best-of-five does not.** `mixed`'s encoder is byte-identical to
`nbits8`'s, so their encoder timings must agree — in one run they read 6,040 ms and 496 ms, which
is how that run was known to be contaminated before anything was written down. And a number is
only kept here if two independent runs agree; the ones above agree to 0.4–6.5%.

**The caveats that remain.** One adapter. Cold-cache download over a real network is measured
below; peak GPU memory and whether a discrete NVIDIA or an Intel iGPU changes the ranking are not,
and nothing above should be read as cross-platform.

## Measuring

**Five probes, answering different questions.**

**`pnpm probe:affinity-variants -- --exported <dir>`** drives ONNX Runtime directly to answer
"which recipe do we ship" — a one-off conversion decision. It writes its own page and serves ORT
from `node_modules`, so a clean checkout reproduces the numbers, and it reads the variants, file
paths and tensor names from the manifest.

**`pnpm probe:affinity-backend -- --exported <dir>`** answers "does the shipped recipe mean the
same thing on the backend it runs on": one set of files on two execution providers, on the cloud
`scripts/probe-affinity-cloud.ts` builds with the pack's own `pointCloud()`. The section above is
its result, and the reason it has two halves is written in that file — its first version minted
uniform noise at ten times the real coordinate magnitude, and the crossing rate it reports is
decided by the input.

**`pnpm probe:seam-model -- --exported <dir>`** is the same question for a *SEAM* model — the
checkpoint `seam:findMerges` will run — and it compares against **PyTorch's own logits**, carried
in a `fixture.json` the exporter writes, rather than against another ORT build. On apple/metal-3,
`A_d256_e80` fp32 agrees to **4e-6 on WebGPU** and 9e-6 on WASM with **no point changing the side
PyTorch put it on**, and runs warm in 49 ms against WASM's 370 — which is also the only signal
available that the graph ran on the GPU at all, since onnxruntime-web falls back per node in
silence. So fp32 is sound there for a single graph with the Fourier projection inside it.

**`pnpm probe:affinity-export`** is the Python one: every variant against fp32 PyTorch, on the
CPU, which is where the fidelity table's numbers come from.

**`pnpm probe:affinity-runtime -- --manifest <url>`** drives *this code*: `openModel`, the weight
cache, the worker protocol. It needs `pnpm dev --port 5178` and checks six things — that the
encoder returns nothing because its outputs stayed **held** in the worker, that the decoder answers
from them, that every affinity is in [0, 1], that a cold open downloads and a warm one does not,
and that warm beats cold. Nothing here is reachable from vitest: it all needs a real `Worker`, a
real IndexedDB and a GPU.

Measured on an Apple metal-3 adapter, N=256, a 16,384-pair decode chunk:

| | files on localhost | files on a real host |
| --- | --- | --- |
| cold open (406 MB) | 2.7 s | **17.1 s** (~24 MB/s) |
| warm open (cache) | 1.0 s | **1.1 s**, 0 bytes fetched |
| encode | 0.54 s | 0.53 s |
| decode, 16k pairs | 0.31 s | 0.28 s |

So a reader pays about **17 seconds once** and about a second on every later open.

**Headless Chrome is a real GPU for WebGPU on macOS**, unlike WebGL ([canvas.md](canvas.md)), so
these timings are honest — but both probes report the adapter every run, so a software adapter can
never be mistaken for one.

## Three things that only running it could find

Every one of these loads, typechecks and passes lint. None is reachable by a unit test, and each
would have shipped — which is why `src/ml` sitting unexecuted was treated as a defect and not a
formality.

- **`onnxruntime-web` must be in `optimizeDeps.exclude`.** Pre-bundled by vite, its wasm
  resolution breaks and the fetch comes back `<!doctype`, which reads as a corrupt runtime rather
  than a missing file. The same treatment neuroglancer already gets.
- **Do not set `env.wasm.wasmPaths`.** It looks like the fix for the above and is not: the
  package's default export is the *bundled* build with its wasm inlined, so pointing at an
  external binary makes `InferenceSession.create` **never settle** — no error, no rejection, a
  model that opens for ever. The fix for the symptom is the line above.
- **`env.wasm.numThreads = 1`.** Threaded wasm needs `SharedArrayBuffer` and so cross-origin
  isolation this app does not set. The compute is on the GPU regardless.

A fourth, in the probe harness rather than here: `evaluate` in `scripts/lib/browserProbe.mjs` used
to drop CDP-level errors, so a page that died under a probe reported `undefined` instead of
failing. That is what kept the first of these hidden for an hour.
