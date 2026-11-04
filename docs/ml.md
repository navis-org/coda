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

Two probes, answering different questions.

**`pnpm probe:affinity-variants -- --exported <dir>`** drives ONNX Runtime directly to answer
"which recipe do we ship" — a one-off conversion decision. It writes its own page and serves ORT
from `node_modules`, so a clean checkout reproduces the numbers, and it reads the variants, file
paths and tensor names from the manifest.

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
