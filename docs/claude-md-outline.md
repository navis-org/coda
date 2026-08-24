# CLAUDE.md restructure — outline

Source: `CLAUDE.md`, 657,532 chars / 8,973 lines / 57 `##` sections.
Target: `CLAUDE.md` under 10,000 chars.

Classification:

- **ALWAYS** — a rule any change has to respect, whatever the task.
- **SOMETIMES** — correct and worth keeping, but only when working on that thing.
- **DEAD** — duplicated, superseded, or derivable from the code.

---

## The budget problem, before anything is moved

The four ALWAYS sections total **32,098 chars** — three times the whole target on
their own. Invariants alone is 16,925 and Gotchas 13,835, because each entry is a
one-paragraph *rule* followed by one to three pages of the incident that produced it.

So ALWAYS cannot go inline verbatim and also fit. **This is the one decision that
needs your call before I start**, and there are three ways to take it:

| | what inline CLAUDE.md holds | what moves | risk |
|---|---|---|---|
| **A** (recommended) | the 8 invariants + 12 gotchas as their **bold rule sentence only**, ~120 chars each | the war story behind each, verbatim, to `docs/invariants.md` and `docs/gotchas.md` | a rule read without its incident is easier to argue away; each keeps an `@`-link |
| **B** | all 8 invariants verbatim, gotchas linked | nothing else fits; file lands ~20k | misses the target 2× |
| **C** | rule sentences for the 5 highest-traffic only, rest linked | more moves out | the seldom-read invariants stop being enforced |

Under A the arithmetic works out at roughly: preamble + commands 0.6k, invariants
1.5k, gotchas 1.6k, chart colours 0.9k, ~52 `@`-links at ~85 chars 4.4k — **≈ 9.0k**.

Note that **invariant 8 (neuron ids as text) is 11k of the 16.9k by itself** — it is
eight rules braided into one entry. Under A it becomes ~6 sentences inline.

A second call, smaller: the instruction says one file per SOMETIMES section, which is
**52 files and 52 link lines**. Grouping them into ~14 area files (`docs/backends-cave.md`
holding CAVE + neuPrint + CATMAID + precomputed, etc.) costs ~1.2k instead of ~4.4k and
buys room to keep more ALWAYS text inline. Say which you want; the table below lists
both the per-section file and the group it would fold into.

---

## ALWAYS — stays in CLAUDE.md

| lines | chars | section | note |
|---|---|---|---|
| 1–6 | 243 | *(preamble)* | what the project is, two links out. Keep verbatim. |
| 7–20 | 414 | Commands | pnpm scripts + the Node/pnpm install note. Keep verbatim. |
| 21–250 | 16,925 | Invariants — don't break these silently | The 8 numbered rules are the core of the file. Rules inline, rationale → `docs/invariants.md`. |
| 251–438 | 13,835 | Gotchas found the hard way | 12 bullets; ~6 are cross-cutting (module init order, anchored regexes, jsdom `localStorage`, React Flow measurements, `erasableSyntaxOnly`), ~6 are the column-resolver saga. Rules inline, rationale → `docs/gotchas.md`. |
| 439–454 | 924 | Chart colours | Short, and a hard "don't do this by eye" rule. Keep verbatim. |

---

## DEAD — delete

| lines | chars | section | why |
|---|---|---|---|
| 5362–5363 | ~70 | `### Morphology: meshes and synapses, but not skeletons` | Empty orphan heading — a title with no body, immediately followed by the next heading. |
| 3084–3134 | 4,097 | `### What was measured, and what is still unexplained` | Superseded investigation. Its own second line says "none of the below explained it — see the section above for what did". Restates `.inspector__viewer` 320×300 and the `pageSize` story already given verbatim at 3015, and repeats its *own* "`table-layout: auto` … a guess until somebody points a browser at it" paragraph twice. The surviving conclusions are in the two sections above it. |

That is all I would delete outright — 4.2k, 0.6%. Everything else is either a live
rule or a finding that cost a measurement to get. Three further candidates I did
**not** mark dead, and why:

- `## Testing layers` (30k) — the left column is derivable from `ls src/**/*.test.ts`,
  but the right column is what each file *asserts*, which is not. SOMETIMES.
- `#### The earlier finding, kept because it explains the shape` (CAVE skeletons) —
  superseded, but the author kept it deliberately and says so in the heading. It
  explains why the L2 route exists. Moves with CAVE.
- The per-feature "+N kB on the main chunk" measurements — repeated in shape, never
  in content. Each is a different number about a different feature.

---

## SOMETIMES — one file each under `docs/`

Read-when column is the one line each will get in the rewritten CLAUDE.md.

| chars | section | → file | group | read when |
|---|---|---|---|---|
| 29,976 | Testing layers | `testing-layers.md` | testing | finding where a behaviour is already covered, or where a new test belongs |
| 38,051 | Exporting a notebook | `export-notebook.md` | export | touching `src/export/python` or the `.ipynb` goldens |
| 15,003 | NBLAST, and Python in the tab | `pyodide-nblast.md` | python | adding a Pyodide capability or touching `src/pyodide` |
| 19,438 | Clustering: Linkage, Cut Tree, Dendrogram | `clustering.md` | python | touching linkage, cut tree or the dendrogram viewer |
| 53,950 | Annotations, and telling backends apart | `annotations.md` | annotations | touching `src/data/annotations`, the Annotations socket, or SeaTable/Google Sheets |
| 4,634 | Two caches, and the two controls that clear them | `caches.md` | core | adding `dataCache` to a node, or touching `ctx.refresh` |
| 1,945 | Auto-run | `auto-run.md` | core | touching the run scheduling or the auto-run toggle |
| 2,997 | Framing a graph that was just opened | `fit-on-load.md` | canvas | touching `loadGraph`, `fitRequest`, or viewport framing |
| 19,462 | Automatic layout | `layout.md` | canvas | touching `src/layout`, ELK, or edge routing |
| 5,071 | The overview page | `page-overview.md` | pages | editing `overview.html` / `src/overview` |
| 4,807 | The tutorial page | `page-tutorial.md` | pages | editing `tutorial.html` / `src/tutorial` |
| 14,807 | The node guide | `page-node-guide.md` | pages | editing `nodes.html` / `src/nodeguide`, or the inspector's table readout |
| 4,059 | Collapsible panels | `panels.md` | ui-shell | touching the inspector, minimap, or the toolbar icon cluster |
| 5,162 | Fullscreen, and installing | `fullscreen.md` | ui-shell | touching ⛶ / `F`, or the web manifest |
| 16,607 | Canvas interaction | `canvas.md` | canvas | touching React Flow settings, node collapse/fold, resize, or the add-node surfaces |
| 3,152 | Dropping a node onto a wire | `splice.md` | canvas | touching `core/splice.ts` or the drag-onto-wire gesture |
| 6,761 | Reference edges — a port that names a node | `reference-edges.md` | core | adding a `reference` port, or touching `topoSort` / `wouldCreateCycle` |
| 4,362 | Breaking and re-routing links | `links.md` | canvas | touching the edge menu or the drag-off rewire |
| 4,178 | Grouped params — the styling sidebar | `param-groups.md` | ui-params | adding `paramGroups` or a composite param to a node |
| 24,694 | Output widgets | `viewers.md` | viewers | touching `ValuePreview`, export, tooltips, table filtering, or number formatting |
| 23,142 | Network Viewer + 3D widgets | `viewer-network.md` | viewers | touching the sigma network viewer, encodings, or the 3D view |
| 9,771 | Scatter plot | `viewer-scatter.md` | viewers | touching `out.scatter` or its canvas drawing |
| 12,890 | Heatmap: more cells than pixels | `viewer-heatmap.md` | viewers | touching `out.heatmap`, the fold, or any SVG export builder |
| 11,285 | Neuroglancer | `viewer-neuroglancer.md` | viewers | touching `out.neuroglancer`, scene patching, or the iframe |
| 8,071 | neuPrint | `backend-neuprint.md` | backends | touching `src/data/neuprint` |
| 42,694 | CAVE | `backend-cave.md` | backends | touching `src/data/cave`, FlyWire, or graphene meshes |
| 17,181 | CATMAID | `backend-catmaid.md` | backends | touching `src/data/catmaid` or the VFB relay |
| 6,006 | Precomputed meshes | `backend-precomputed.md` | backends | touching `src/data/precomputed` or Draco decoding |
| 8,578 | Dataset nodes | `dataset-nodes.md` | datasets | adding a dataset family, a Custom backend node, or touching version resolution |
| 4,404 | Attribution: the Description companion | `companion.md` | datasets | touching `core/companion.ts` or markdown rendering |
| 2,211 | Auto-wiring the Dataset socket | `autowire.md` | datasets | touching `core/autowire.ts` |
| 5,212 | Text notes | `text-notes.md` | nodes | touching `note.text` or the `annotation: true` flag |
| 2,342 | Pivot: a matrix and a wide table | `node-pivot.md` | nodes | touching `core.pivot` |
| 3,149 | Deduplicate | `node-dedupe.md` | nodes | touching `core.dedupe` or `rowKey` |
| 16,441 | Upload Table and Table from URL | `node-import.md` | nodes | touching either import node, `data/csv.ts`, or `data/uploads.ts` |
| 8,492 | Type column, and combining several into one | `node-combine.md` | nodes | touching `core.combineColumns` or the `type` rename |
| 7,370 | Select One: stepping through a collection | `node-select-one.md` | nodes | touching `core.selectOne` or `nodes/lib/iterables.ts` |
| 4,059 | Stack Tables: the vertical Join | `node-stack.md` | nodes | touching `core.stack` |
| 6,929 | Download: a side effect in a reactive graph | `node-download.md` | nodes | touching `out.download`, `exportValue.ts`, or the export registry |
| 4,210 | Connectivity Graph: hops and direction | `node-connectivity.md` | nodes | touching `neuron.connectivity` or `connectivityOps.ts` |
| 10,574 | Paths: how does this reach that? | `node-paths.md` | nodes | touching `neuron.paths`, `pathOps.ts`, or `T.layout()` |
| 5,976 | IDs from Label: the inverse query | `node-ids-from-label.md` | nodes | touching `neuron.idsFromLabel` or `LabelMatch` |
| 7,505 | Input IDs: the ids themselves | `node-input-ids.md` | nodes | touching `neuron.inputIds` or `nodes/lib/idList.ts` |
| 22,807 | Explore Dataset: the browsing widget | `widget-explore.md` | widgets | touching Explore Dataset, the neuron index, chips, or thumbnails |
| 5,427 | Neuron Profile: one neuron at a time | `widget-profile.md` | widgets | touching `out.profile` or `profileStats.ts` |
| 22,821 | Dataset Summary, and the two ROI nodes | `widget-dataset-summary.md` | widgets | touching `out.datasetSummary`, the ROI query nodes, or `datasetStats.ts` |
| 17,713 | ROI Viewer: the volume rather than the cells | `widget-rois.md` | widgets | touching `out.rois`, projection, rasterising, or mesh decimation |
| 3,842 | Run indicator | `run-ring.md` | ui-shell | touching the run ring or progress reporting |
| 15,988 | Sharing a workflow | `sharing.md` | persistence | touching share links, the codec, or the gist client |
| 9,876 | The autosave, and more than one tab | `autosave.md` | persistence | touching the autosave, tab slots, or `sessionStorage` |
| 4,174 | The workflow library | `library.md` | persistence | touching `store/library.ts` or the browser shelf |
| 8,109 | Starter graphs | `starters.md` | datasets | touching `examples/starters.ts` or the FlyWire bespoke starter |
| 3,295 | Start page | `start-page.md` | ui-shell | touching `StartPage.tsx` or `startCards.ts` |

52 files. Grouped instead, that is 14: `testing`, `export`, `python`, `annotations`,
`core`, `canvas`, `pages`, `ui-shell`, `ui-params`, `viewers`, `backends`, `datasets`,
`nodes`, `widgets`, `persistence`.

---

## What I need from you

1. **A, B or C** for the ALWAYS sections (A recommended).
2. **52 files or 14 grouped files.**

Then I move each section verbatim, delete the two dead ones, and rewrite CLAUDE.md.
`CLAUDE.md.bak` stays until you confirm.
