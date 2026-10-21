# Backends: ZapBench

ZapBench: a released zarr array rather than a server — its two layouts, the pyramid, the id seam.
[backends.md](backends.md) holds what all of them share — the geometry cache and streaming.

## ZapBench: a released zarr array, not a server

`src/data/zapbench/traces.ts` reads the ZapBench calcium-imaging traces for `neuprint-fish2`.
It is not a `DataSource` and has no listing, no credential and no schema: it is one released
array at a dated path, read by arithmetic.

**The layout is the whole design.** `gs://zapbench-release/volumes/20240930/traces` is zarr v3,
`shape [7879, 71721]`, `chunks [512, 512]`, `float32`, and **`codecs` is `bytes` and nothing
else** — no compressor. Every byte offset is therefore a multiplication, so a chunk can be read
in part with a range request and nothing has to be decoded. `zarr.json`'s codec list is checked
by `live.test.ts` for that reason: a compressor added upstream would not fail, it would return
noise shaped like a trace.

The axes are `['t', 'f']` — time down, neurons across — per zapbench's own `constants.SPECS`,
and that was confirmed independently before it was found: lag-1 autocorrelation is 0.54 along
axis 0 against 0.25 along axis 1, and decays to 0.12 by lag 20 where axis 1 stays flat.

**Neurons are on the contiguous axis, and everything follows from it.** A fixed `t` is 512
adjacent neurons in 2,048 contiguous bytes; a fixed neuron is 512 values 2,048 bytes apart. So
the unit of a request is a contiguous *row span* of one chunk, which necessarily carries all 512
of that chunk's neurons, and cost is blocks × timesteps rather than anything to do with how many
neurons were asked for. [limits.md](limits.md) carries the row.

Three measurements worth not re-taking:

- **A multi-range request is refused.** It would be the obvious win — one neuron's 512 values
  inside a chunk are 2 KiB of useful data inside 1 MiB — but GCS answers
  `Range: bytes=0-163, 2048-2211` with **400 InvalidArgument, "Multiple ranges"**. One range per
  request is the whole budget.
- **The bucket is reachable from a static deploy.** `access-control-allow-origin: *` on a GET,
  and `Range` is a CORS-safelisted request header, so a ranged read triggers no preflight — which
  matters, because the `OPTIONS` preflight comes back 200 carrying no `Access-Control-Allow-*`
  headers at all. Reads go through `precomputed/transport.ts`'s `fetchBytes` anyway, so the CORS
  fallback and route memory come for free rather than being written twice.
- **`traces_fluroglancer` is the wrong array for this**, despite being the one named for
  interactive use. Same shape, also uncompressed, but `chunks [32, 16384]` — thin in time and
  wide in neurons, which is the layout for "every neuron at one timestep". One neuron's full
  trace there is 247 chunks of 2 MiB against 16 of 1 MiB here.

**What is *not* readable at sensible cost is the stimuli.** `stimuli_features` is `[7879, 26]`
with `chunks [1, 26]` — **one object per timestep**, so the 820 kB table is 7,879 separate HTTP
requests. It is also blosc/zstd, though that turns out not to be the blocker: the chunks are
stored `MEMCPYED` (120 bytes for 104 bytes of data), so the payload is raw `float32` behind a
16-byte header. The request count is the blocker. A committed derived file is the only sensible
route if it is ever wanted.

### Two layouts, and why the reader chooses per request

The release holds the same numbers **twice**, transposed, and neither copy is better than the
other — which is why `readPlan.ts` costs both and takes the cheaper rather than a constant naming
a winner.

`traces` is row-major: a timestep is 512 adjacent neurons in 2,048 contiguous bytes, a neuron is
512 values 2,048 bytes apart. Reading any part of a chunk row costs all 512 neurons.

`traces_rastermap_sorted/s0` is the same values with neurons permuted into a 1-D activity
embedding, and — the part that matters — carries a **`transpose` codec** (`order: [1, 0]`), so a
neuron's timesteps are *contiguous*. Same shape, same chunking, same missing compressor. One
neuron costs 2 kB a chunk instead of a megabyte.

Measured on 36 scattered neurons over the whole recording, concurrency 6, identical request
counts: **576 MiB against 1.1 MiB, 60.5 s against 18.5 s.** Through the node end to end, 23.7 s
and byte-exact against direct reads.

The crossover is real and is why both are kept. Row-major wins on a **narrow window over many
neurons** — a whole block over four timesteps is 8 kB row-major and megabytes transposed, since
the transposed read must bridge hundreds of unwanted neurons to collect a few values each. So
plans are compared in bytes **plus requests priced in bytes**: `REQUEST_BYTES_EQUIVALENT` is
450 kB, derived from the same measurement (a request costs ~32 ms whatever its size; marginal
bandwidth ~13.7 MiB/s). That constant is also what decides whether to bridge a gap between two
wanted neurons or spend a second request on them.

**The pyramid is unusable for a neuron's trace, and that is the finding rather than an omission.**
The group is a real OME-NGFF multiscale (`multiScale: true`,
`downsamplingFactors: [[1,1],[2,2],[4,4]]`), but both factors apply to **both axes** — a level
down averages each neuron with its rastermap neighbours. A "trace" at `s1` is the mean of two
different cells and nothing in the value could tell. No level of it answers "the trace of neuron X"
more cheaply than `s0`, so `traces.ts` never reads one. `recording.ts` does, for the
whole-population overview — see below.

Three rules the route carries:

- **The permutation is checked, never trusted.** `sorting.json` is 491 kB and a clean permutation
  of 0…71,720 (verified in full, not sampled — a file that is *nearly* a permutation would give
  two neurons one trace and lose a third). But `traces` is the published contract, where the
  sorted copy is a derived visualisation product whose group metadata calls itself `"example"`.
  A re-sort would not fail: it would return a real neuron's real trace under another neuron's
  name. So `verifiedSorting` reads one cell from *each* array and compares before the route is
  used — two cells, and at least one non-zero, because the array's padding reads as 0 and two
  zeroes match perfectly well. Any disagreement falls back to row-major, which is a slower route
  to the identical answer.
- **`sorting.ts` imports nothing from `traces.ts`.** The two reference each other, and a cycle is
  safe only while every read is inside a function. Building the sorted path at module scope as
  `` `${ZAPBENCH_RELEASE}/…` `` silently produced the string `"undefined/traces_rastermap_sorted"`
  under the ordinary import order — vite-node hands a half-evaluated module's namespace back as
  an object rather than throwing, where a browser ESM build would throw a TDZ `ReferenceError`.
  Every test passed, because none asserted the base; `readPlan.test.ts` now pins it.
- **Only `traces` has a sorted copy.** There is no
  `stimulus_evoked_response_rastermap_sorted`, so the layout is chosen per *product*.

One bug worth recording because only the live test could see it: the sorted route engaged
nowhere for a round, because `sorting.json` was addressed by its `gs://` URI and `fetchText`
speaks HTTP. Nothing failed — `loadTraceSorting` answers `undefined` for any failure and the
reader fell back — so every value was still correct, by the slow path. The stub now refuses a
non-HTTP URL so it cannot hide that again.

### The pyramid: a row is a bin

`src/data/zapbench/recording.ts` reads every cell at once for `zapbench:traces`, and that is
what the pyramid is for. `s1` is `[3940, 35861]` and `s2` is `[1970, 17931]`, both
`chunks [512, 512]`, both `transpose` then `bytes` with no compressor. Measured against the
bucket rather than read off the metadata:

- **A level is the mean of the block under it.** `s1[0, 0]` against the mean of the 2 × 2 block
  of `s0`: 0.1668079 and 0.1668079; `s2[0, 0]` against the 4 × 4 mean, likewise.
- **`s2` is built from `s1`, not from `s0`**, and the two readings part only at a *partial* bin.
  The last `s1` step (t 7878 beside a padding step) is the mean of the one real step, not half of
  it. The last `s2` step is the mean of four `s1` cells, one of them that single-step mean, so
  t 7878 counts double: **0.068819** — the mean of the `s1` block to the digit — against 0.067784
  for the plain mean of its three real steps. So a partial **time** bin is dropped (`levelWindow`
  floors the end).
- **A partial row is exact at both levels.** 71,721 = 4 × 17,930 + 1, so the last `s2` row holds one
  real cell, which `s1` averaged alone: 0.181029 against that cell's 4-step mean of 0.181029, where
  a padded mean would be 0.045. So a partial row is kept, its label naming the one cell.

A row's *name* rests on two derived products — the permutation, and that a level still averages
the one below — so `verifiedLevel` reads two level cells and the `s0` blocks under them before a
reduced scale is used, beside `verifiedSorting`. Unlike the sorted route in `traces.ts` there is
**no slower way to the same answer** (every cell at full scale is 4.2 GB), so a failed check
refuses and names Full as the remedy. The probes sit at multiples of four, inside one chunk at
every level and away from the partial bins where the two ways of building `s2` differ. An abort
during the check is rethrown rather than remembered, or a Cancel would refuse every reduced scale
for the session.

Full scale reads the **row-major** copy and places rows through the permutation: every cell is
every block anyway, and over `flash` row-major is 179 MB where the transposed copy bridges nearly
whole chunks for 423 MB. At full scale a label comes from the column rather than the permutation,
so an unverifiable sort falls back to cell order with a warning and mislabels nothing.

`live.test.ts` checks both levels' shape and codecs, runs `verifiedLevel` at both scales, and
rebuilds one real quarter-scale row from sixteen independent row-major reads.

### The id seam

A fish2 body carries `zapbenchId` where somebody matched it to a ZapBench cell — 62,178 of
235,057 neurons, all distinct. **It is the 1-based segmentation label, so the trace column is one
lower**, and that was measured rather than assumed because getting it wrong returns the
neighbouring cell's trace: a real trace of a real neuron, entirely plausible on a heatmap.

`pnpm probe:zapbench` is the record, and the first half of it is that **the range cannot settle
it**: fish2's ids run 5…71,720, valid under both readings, and the top label being one of the 13%
of cells nobody matched is ordinary. The answer came from geometry — every matched neuron has a
`somaLocation` and the released dataframe has a centroid per label, so an affine was fitted
between the two frames and the residual read. The **offset sweep is what makes it mean
something**: over 20,342 neurons within 5 µm of a registration landmark, `row = id - 1` gives a
median residual of 522 against 1,453 for `row = id`, with ±3 around it at 1,473–1,995 — a unique
minimum, 2.8× sharp, rather than a fit that would have flattered any offset. It resolves cleanly
because labels run roughly in `z`: a wrong offset names a different cell at a similar depth,
whose `x`/`y` is anywhere.

`segmentation/dataframe.json` (52 MB) was also checked row by row: `label[i] === i + 1` for all
71,721 rows, no exceptions. The probe re-checks that before trusting any residual, since every
one of them is meaningless without it.
