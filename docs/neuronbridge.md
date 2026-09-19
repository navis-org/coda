# NeuronBridge

The `NeuronBridge` node (`out.neuronbridge`) and the module behind it (`src/data/neuronbridge`).
[NeuronBridge](https://neuronbridge.janelia.org) is Janelia's precomputed match index between EM
neurons and FlyLight's light-microscopy images: for every neuron of hemibrain, male CNS, MANC,
FlyWire and BANC, the split-GAL4 and MCFO images whose colour-depth projections resemble it. This is
the first light-microscopy data on the canvas.

## The bucket is the API

NeuronBridge has no query service. Its data is a public S3 bucket whose keys are predictable and
whose objects are JSON under a published, versioned schema (`<version>/schemas/`), and it answers
`Access-Control-Allow-Origin: *` with no credential. So a browser reads it the way it reads a
precomputed volume: no proxy, no token, no auth failure to route anywhere. Measured on `v3_10_0`:

| Key | Size | Time |
| --- | --- | --- |
| `current.txt` | 8 B | — |
| `<v>/config.json` | 7 kB | — |
| `<v>/metadata/by_body/<id>.json` | 0.8–2.2 kB | ~0.35 s |
| `<v>/metadata/cdsresults/<imageId>.json` | 2.9–3.2 MB, ~2,000 matches | ~1.0 s |
| `<v>/metadata/pppmresults/<imageId>.json` | ~250 kB | — |

The custom search (upload your own image) is **not** part of this: the web app sends it through
AppSync and Cognito with mandatory sign-in. Coda reads precomputed matches only.

## Not a `DataSource`

It answers no `findNeurons` and no `fetchConnectivity`, the two methods the seam requires, and an
annotation provider fetches a dataset's labels *whole*, where this is one 3 MB file per neuron —
hemibrain's 44,477 bodies would be ~130 GB. So it is a data module a node calls, `data/zapbench`'s
precedent, and it is registered nowhere.

## Four rules from mapping the bucket

- **The key is the bare body id.** `by_body/1734350788` answers;
  `by_body/hemibrain:v1.2.1:1734350788` is a 404.
- **A bare id is ambiguous across libraries.** `by_body/11442` is three neurons: MANC, male CNS and
  the VNC pilot. A lookup is a list, and `libraries.ts` filters it to the wired dataset's libraries
  — never by position. The library list itself comes from `config.json`'s `publishedNamePrefix`;
  only the family names are mapped by hand (`flywire_fafb` is Coda's `flywire_fafb_public`), so a
  release adding a new version of a dataset Coda knows needs no change.
- **File paths come off the record, prefixed by its store's prefix in `config.json`.** Built by hand
  they 404 on every nerve-cord library, which lives under a different alignment space.
- **Absent is an answer.** Most segments have no record, so a 404 on a lookup is an empty list.
  `fetchText` throws `NotFoundError` on a 404 for this; its message is unchanged for every other
  caller.

## The card is Neuron Profile's shape

`cheap`, and **`evaluate` never fetches**: every request belongs to the widget, per neuron *viewed*,
through `keyedCache` + `useSettledFetch` (`ui/viewers/useNeuronBridge.ts`). The lookup settles
before fetching, so holding down › does not request every neuron passed; the match file is fetched
only for the record on screen, and its cache is budgeted in matches, not files — 12,000, about
17 MB parsed at ~1.4 kB a record, where 40,000 had held ~56 MB for a card that draws one neuron.

A step through the lines re-renders **two** lines' tiles, not all of them: `LineTiles` is memoised,
handed the selection only when it holds it, a pin key prefix rather than a closure, and callbacks
whose identity never changes (`useLatest`). Unmemoised, every tile on screen — up to all 746 after
a long scan — rebuilt its URLs and re-reconciled at key-repeat rate.

Browsing is presentational — `page`, the collection chips, the method, `Lines per step` and the data
version change no output. **A pin carries the whole match** into the `pins` param (one JSON object
per `ids` entry, `nodes/lib/neuronbridgePins.ts`), so the `Pinned` port is built from params alone:
nothing is fetched at Run, and a pinned match cannot change because the bucket moved on. The
NeuronBridge version it was read from travels with it.

`Collections` and `Method` are `advanced`: the card already draws them as chips and a CDS/PPPM
switch, and a node with a viewer draws its non-advanced params as rows on the card too. Found in a
browser — the first screenshot had both controls twice.

## One tile per line

2,085 CDS matches of one hemibrain neuron are **746 lines**, up to five images each, and the top
twenty images are twelve lines. So `groupByLine` files matches by line, ranks lines by their best
image, and keeps the others behind a `+N` that draws them only when opened. Every tile is an
`<img>` from Janelia's bucket, so an image not shown is a request not made; lines arrive in steps
of `Lines per step` for the same reason.

Collections are classified from the library *name* (`collectionOf`), because that is all a match
carries and the names are not one spelling — brain MCFO is `FlyLight Gen1 MCFO v1.1`, VNC MCFO has
no version, and config uses underscores. An unrecognised collection is `other` and **shown**, so a
collection a later release adds cannot disappear behind chips that predate it.

PPPM exists only for hemibrain among Coda's datasets and publishes a *rank*, 0 best, beside a score
not documented as comparable across files. So PPPM is ordered and printed by rank, and the switch
appears only on a neuron that has PPPM. A stored `method: pppm` on another neuron draws CDS without
rewriting the param.

## Comparing a match

An opened match is `data/neuronbridge/views.ts`' decision (`comparisonFor`) and
`ui/viewers/NeuronBridgeCompare.tsx`'s drawing. Two independent choices: **Compare** — `side`, `lm`,
`overlay` — and **LM image** — `hit`, `line`, `both`. Both, with the EM opacity and `Keep in view`,
are presentational params, so they are remembered with the workflow and change no output.

Measured on real files before any of it was built, and each finding is a rule:

- **Every CDS image of one match is the same size in the same space** — the EM search image
  (`CDMInput`), the segmented hit (`CDMMatch`) and the whole sample (`image.files.CDM`) are all
  1210 × 566 for a brain, 573 × 1209 for a nerve cord. Stacking is drawing one over another.
- **`mirrored` means the EM must be flipped to land on the LM.** On a mirrored hemibrain match, 51%
  of the hit lies within 6 px of the EM neuron once flipped against 24% as published; on an
  unmirrored one, 79% and 0%. The **EM** is flipped, never the LM: the LM is a real sample, and
  its whole-line context mirrored would misstate its anatomy.
- **A flipped image flips its scale bar and "Max" label too**, a block about 260 × 70 px in the
  top-right of every CDS image, brain or nerve cord — in pixels, not proportions. So a flipped
  layer, and the grey whole-line layer under a hit (whose label otherwise overprints the hit's with
  a different number), lose that corner through `cornerClip`. `clip-path` is in the layer's own
  coordinates, i.e. applied before the flip.
- **PPPM is a different product**: 1427 × 668, no standalone EM image, and a hit on grey that
  cannot be laid over anything. Its overlays are NeuronBridge's own (`CDMSkel`, `SignalMipMaskedSkel`,
  EM skeleton drawn in); `both` is unavailable and says why; the opacity control is disabled.

**The overlay draws the EM in white by default.** In its own depth colours a good match coincides
with the hit colour for colour — which is what CDS scores — so the first overlay drawn in a browser
showed no EM at all: a `lighten` of two nearly equal pixels is the same pixel. White is
`grayscale(1) brightness(14)`, not `grayscale()` alone, because that weights by luminance and pure
blue, the deep end of the depth ramp, is 7% luminance — the deep half of the neuron would vanish.
`EM in colour` (`emTint`) stays, since coincidence in depth colour is exactly what a reader checking
a CDS score wants to see.

Three drawing rules. **A stack is sized to its first image's aspect ratio** and every layer fills
it: `object-fit: contain` would letterbox each layer, and a percentage `clip-path` would then clip
the letterbox rather than the image. **A layer with a hidden corner stays invisible until its size
is known**, or a mirrored scale bar flashes for a frame. **The opacity slider writes on release**
and draws live from a draft, or a drag is a hundred edits, undo steps and saves.

Frozen, the comparison sits in `.nbridge__top` above `.nbridge__scroll`; the top may shrink and scroll
inside itself, and the tiles keep at least 96 px. Full screen is a portalled `Modal`, which renders
into the fullscreen element when there is one — a hand-built copy portalled to `document.body` would
open invisibly under a fullscreen viewer — is on `useOverlayEscape`'s stack, so Escape closes it
before the expanded card, and stops the card's React events at its root: click, double-click, bare
keys and, since this card needed it, context menu, which `Modal` now stops for every portalled
dialog (React Flow's node menu is on the card's wrapper, and a portal's events bubble to it).

## Stepping through lines

← and → step to the previous and next **line** — on the card, the expanded card and full screen,
which keeps whichever image is full screen, so lines can be scanned by their LM image alone. The
step is over lines in the tiles' own order under the ticked collections, never over images: from
a line's second image, → goes to the next line's best rather than back to the same line. Stepping
past the tiles on screen shows the next batch, as "Show more" would, and the tile stepped to is
scrolled into view by hand inside `.nbridge__scroll` — `scrollIntoView` would also scroll the
canvas's overflow-hidden ancestors.

Four things make it work, each a way it silently would not:

- **The keys are owned at the card's root and stopped there.** React Flow moves a selected node with
  the arrows from the node wrapper above; the editor's own shortcuts listen on `window` in the
  bubble phase and skip typing targets. So a slider under focus keeps its arrows, through the
  shared `isTypingTarget`, and nothing else hears them. Full screen handles its own, its root
  already stopping every bare key.
- **The comparison takes the focus when it opens**, unless something in the card has it. Chrome
  focuses a clicked button and Safari does not, so without this the keys worked after a click in
  one browser and reached the page body in the other.
- **The next two lines and the previous one are fetched ahead** (`preloadImages`), exactly the layers
  they would draw under the current modes — once the selection has rested 150 ms, since a held
  arrow key passes lines nobody looks at and a started image load cannot be taken back. The bucket sends `Last-Modified` and an `ETag` and no
  `Cache-Control`, so the browser keeps the image and the `<img>` asking next is answered at once.
  Without it every step drew a black frame while its PNG loaded. `pnpm probe:neuronbridge` asserts
  each step's images were requested *before* its key, and times the key to the image drawn.
- **The EM/LM switch in full screen moved from the arrows to its buttons**, the arrows being the
  lines' now.

## Pinning from the image, and the pinned download

`☆ Pin` sits beside the opened image — the comparison's header and full screen's — as well as on
each tile, because scanning lines full screen with ← and → is exactly when the tile is out of
sight. One toggle (`togglePin`) behind all three, so a pin made full screen shows on its tile.

`Pinned matches (CSV)` in the card's download menu is every neuron's pins, built by `pinnedTable` —
the function the Pinned port is built by, so the file and the port cannot disagree about a column
(the test byte-compares them). It arrives through `ExportSource.tables`, a list of further CSVs a
viewer can offer as rows of its own; card-only, and deliberately not relayed to the Download node,
whose capability check is about the one `csv`. With nothing pinned it says so through the notice
channel rather than writing an empty file.

## Versions

The data version is `Latest (v3.10.0)` by default, read from `current.txt` through a peek that
announces itself through `reportSourceLearned`, the way a dataset node's version dropdown fills in.
Versions before 3.0 are real data in a layout nothing here parses, and are not offered.

A wired dataset on a different version from NeuronBridge's (male CNS `v1.0` against NeuronBridge's
`v0.9`; a FlyWire materialization other than 783) is **looked up anyway**, and the card says both
versions. An id present in both releases names the same body, and one that is not has no record —
but a body edited while keeping its id is shown as it was, which is what the note says.

## Images and CORS

Thumbnails come from `janelia-flylight-color-depth-thumbnails`, which sends **no** CORS headers;
the full-size images in the detail view come from `janelia-flylight-color-depth`, which does. An
`<img>` needs neither, and nothing here draws to a canvas. Anything that later wants the pixels —
a PNG export of the card, a colour picker — has to use the full-size bucket.

A colour-depth projection's hue *is* depth, so every image frame is black in both themes.

## Tests and probes

- `data/neuronbridge/neuronbridge.test.ts` — the client against recorded responses in
  `__fixtures__/` (the two match files are file-order samples of the recorded ones; the real CDS
  file is 3 MB).
- `data/neuronbridge/live.test.ts` — the bucket itself, including HEAD requests for the images a
  tile and its detail view draw. `NEURONBRIDGE_LIVE=1`.
- `ui/viewers/neuronBridgeViewer.test.tsx` — the wiring: requests per page, what a pin and a chip
  write, what `+N` adds.
- `pnpm probe:neuronbridge` — what only a browser shows: thumbnails load, nothing scrolls sideways,
  the detail view draws both images, paging fetches once per neuron. Needs a dev server on 5193 and
  a neuPrint token for the hemibrain dataset node. **Start it after your last edit**: a dev server
  that has hot-reloaded `graphStore.ts` serves the probe's `import()` a second, disconnected store,
  and the probe builds its graph into that one — an empty canvas with every step reporting success.

## Not done

- **Export.** Both exporters carry a `NO_EMITTER` reason. The `Pinned` table is written wholly into
  params and could be emitted as a literal frame; that is the obvious first emitter.
- **Aligned skeletons.** `files.AlignedBodySWC` on each record is the neuron registered into
  JRC2018U — Coda's common space — in micrometres. Brain libraries land in Coda's frame as they are
  (checked against Coda's own landmark targets); nerve-cord libraries are in raw `JRCVNC2018U`,
  before the affine that places a VNC beside the brain.
- **LM → EM**, `by_line/<line>.json`: from a driver line to the neurons it labels.
