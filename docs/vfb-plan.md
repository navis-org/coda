# Plan: the `vfb` pack — Virtual Fly Brain beside the connectomes

Status: **Phases 0, 1, 1b and 1c are built** (the data layer; VFB Neurons, Publications and VFB
Info; Driver Lines, Expression Images, Line Gallery and Load Expression). Decisions already taken
are marked ✔, and the open ones are listed at the end. When the pack lands, this file becomes
`docs/vfb.md`, the area's design record.

## What this is

This pack is a **prototype and a test bed**. It is for working out which workflows link Virtual
Fly Brain (VFB) to the connectomes, and which UIs make those workflows possible. We work closely
with the VFB team, and both sides want a tighter integration, so the pack runs in both directions:

- **What Coda is missing** to run these workflows end to end is recorded as it is found
  (*Gaps in Coda*, below). Some gaps are pack-local and some belong in the base.
- **What VFB could change** to make a workflow cheaper or more correct is recorded as a concrete
  ask, with the measurement behind it (*Asks of VFB*). We can ask for changes and fixes on their end.
- **What Coda could give back** — links out of VFB into a workflow, and curation reports VFB could
  act on — is recorded as an offer (*Offers to VFB*). Anything we build that is useful may be
  integrated into the VFB website, or linked out from it.

The organising idea, measured below: **VFB's FBbt types are a shared index across datasets and
the literature.** A neuron in any connectome VFB holds is an individual typed to FBbt classes. Those
classes cite papers and contain neurons from every other connectome. Each use case is one or two
hops through that index. What makes a hop hard is choosing the right class, never reaching the
data.

## Use cases

Each one was walked against the live data on 2026-10-14. The chains use the node names from
*Nodes*, below.

### 1. A MaleCNS neuron or type → the papers that describe it

`MaleCNS → Find Neurons (type MBON01) → VFB Neurons → Publications → Table`

Measured: body `10013` → `VFB_jrmc2094` → `FBbt_00100234` (mushroom body output neuron 1) → 23
reference edges, each carrying a DOI and, where FlyBase has curated the paper, a PMID and an FBrf.

- **A reference has a role**, on the edge as `r.typ`: `def` (the paper that defines the type),
  `syn` (the source of a name) and `nlp` (text-mined). Across all of VFB there are 50,978 `def`,
  254,624 `syn` and 1,992 `nlp`. Publications carries `role` as a column and defaults to `def` +
  `syn`.
- **These are papers about the type, not about that neuron.** The node says so, and its output is
  keyed by `fbbtId`, not by `neuronId`. A neuron's *own* paper is its dataset's, which is
  already on the dataset's Description card.
- **A neuron has several types at once.** Across male-cns there are 252,336 `INSTANCEOF` edges over
  166,693 individuals: MBON01 sits beside generic classes such as `adult cholinergic neuron`
  (21,520 male-cns members). A type that generic cites papers about every cholinergic neuron, so
  VFB Neurons picks the **most specific class** (*Choosing the class*).

### 2. A paper → its neurons in FlyWire

`Find Terms (Paper: 10.7554/eLife.04577, Role: def) → VFB Neurons (reverse, FlyWire) → Skeletons → 3D View`

Measured, as classes citing the paper and the FlyWire 783 neurons typed to them:

| Paper | Role | Classes | FlyWire neurons |
| --- | --- | --- | --- |
| Aso et al. 2014 | def | 111 | 3,328 |
| Aso et al. 2014 | syn | 108 | 3,342 |
| Li et al. 2020 | def | 104 | 5,330 |
| Park et al. 2022 | **nlp only** | 53 | **37,139** |

- **`nlp` is the trap.** Text-mined mentions land on generic classes, and a paper about one circuit
  returns a quarter of the brain. Role defaults to `def`. `syn` is a tick box, and `nlp` stays
  available but off, with the count shown before Run.
- **A paper is found by DOI, PMID or FBrf.** Recent preprints have no FBrf: they are keyed
  `doi_10_1101_…`. Measured: `'10.7554/eLife.04577' IN p.DOI` matches. DOI is a list property, so
  the lookup tests membership.

### 3. A hemibrain type → the corresponding neurons in BANC

`Hemibrain → Find Neurons (type PFNa) → VFB Neurons (forward) → VFB Neurons (reverse, BANC 888) → Table`

Measured, as hemibrain neurons and BANC 888 neurons on the most specific shared class:

| Hemibrain type | Class | Hemibrain | BANC |
| --- | --- | --- | --- |
| MBON01 | mushroom body output neuron 1 | 2 | 2 |
| LHPV5e1 | adult lateral horn PV5e1 neuron | 2 | 2 |
| SMP108 | adult superior medial protocerebrum neuron 108 | 2 | 2 |
| AVLP001 | adult anterior ventrolateral protocerebrum neuron 001 | 1 | 1 |
| LC4 | lobula columnar neuron LC4 | 71 | 114 (both hemispheres) |
| PFNa | eight per-glomerulus classes | 58 | **0** |
| PFNa, one class up | `FBbt_00111396` (PB 1 glomerulus–FB–NO3 anterior) | 58 | **58** |
| PFNa, two classes up | `FBbt_00003634` (every PFN) | — | 473 |
| PFNa via `adult cholinergic neuron` | — | 49 | **5,996** |

- **The climbing rule.** Use only each neuron's most specific class. If the target has no
  neurons in it, climb `SUBCLASSOF` **one step at a time** and stop at the first ancestor the target
  populates. Never step onto a generic class. Report the climb and both counts per type, so 58 → 58
  reads as a match and 58 → 473 reads as an overshoot. `Max climb` defaults to 1.
- **The typing depth differs by dataset, and that decides how often a climb is needed.** For each
  neuron, take the size of its tightest class:

  | Site | ≤ 30 members | 31–300 | > 300 | Neurons |
  | --- | --- | --- | --- | --- |
  | hemibrain v1.2.1 | 13,375 | 7,147 | 2,183 | 22,705 |
  | male-cns v1.0 | 43,136 | 31,252 | 92,305 | 166,693 |
  | BANC 888 | 44,371 | 24,039 | 77,533 | 145,943 |
  | FlyWire 783 | 28,761 | 23,938 | 86,556 | 139,255 |

  "> 300" mixes large real types (Tm3: 2,054; photoreceptors: 3,377) with generic ones, so it is an
  upper bound on coarse typing, not a count of it.
- **This is a second opinion, not the only one.** `Match Cell Types` already derives
  correspondences from connectivity ([comparative.md](comparative.md)). VFB's are curated, so the
  two are independent evidence, and disagreement between them is a finding (*Offers to VFB*).

## Decisions taken

| | Decision |
| --- | --- |
| ✔ Pack | `vfb` (permanent), `defaultOn: false`, shortcut `/vfb`. It requires nothing: the bridge to a connectome is an id column plus a Dataset wire, both built in. |
| ✔ VFB CATMAID stays put | The FAFB and L1 CATMAID datasets remain a part of Connectome. |
| ✔ Scope | The bridge and publications first (use cases 1–3), then driver-line expression, stocks, and ontology plus neurotransmitters. scRNAseq is not in scope. |
| ✔ Entry points | From EM neurons, a type or term, a paper, a line name, and a region. |
| ✔ Image stacks | **Points first, volume later.** VFB's `volume.obj` is an intensity-weighted point cloud and reads as `points`. A `volume` kind is the last phase. |
| ✔ Transport | VFBquery where it answers. The **PDB** (anonymous Cypher) for batch lookups, choosing a class and climbing, none of which VFBquery has a form for. Whether that is acceptable is the first ask. |
| ✔ Read only | Every call is a GET or a read-only Cypher `MATCH`. |

## Nodes

All ids are `vfb:*`. VFB ids are **not neuron ids**: they are their own text columns, `vfbId` and
`fbbtId`. Neuron ids appear only at the bridge, as text in and text out (invariant 8). Every node
that fetches is **`expensive`**, because the server is shared and a cold query has taken over 90 s
(invariant 6).

| Node | In | Out | Phase |
| --- | --- | --- | --- |
| **`vfb:neurons`** VFB Neurons | `Direction: forward` — a neuron table from any connectome VFB holds, and its Dataset | the table plus `vfbId fbbtId fbbtLabel fbbtClimbed` | ✔ 1 |
| | `Direction: reverse` — a terms table plus `Target` dataset; `Max climb` | a **neuron table** of the target (`neuronId` as `str`, `ID_COLUMN_NAME`), plus `fbbtId climbed fromCount toCount` | 3 |
| **`vfb:publications`** Publications | a table with `fbbtId`; `Cited as` | table: `fbbtId fbbtLabel neurons reference title year doi pmid roles` | ✔ 1 |
| **`vfb:info`** VFB Info | any table of VFB ids | a viewer, one term's page at a time; passes through | ✔ 1 |
| **`vfb:terms`** Find Terms | `Kind`: type, line, region, **paper**; text or a column of names | table: `vfbId label kinds` (types for a paper, with `role`) | 1 (type), 2 (paper) |
| **`vfb:lines`** Driver Lines | a table with `fbbtId`; `Kinds`, `Max targets` | table of expression-pattern classes | ✔ 1b |
| **`vfb:images`** Expression Images | lines; `Templates`, `Fragments` | one row per image, with file URLs and `license` | ✔ 1b |
| **`vfb:expression`** Load Expression | images; `Points per image`, `Min intensity` | `points` (JRC2018U brain, nm, `intensity` attribute) | ✔ 1b |
| **`vfb:gallery`** Line Gallery | images | passes through; `Pinned` | ✔ 1c |
| **`vfb:stocks`** Stocks | lines | table of stocks | 6 |
| **`vfb:hierarchy`** Term Hierarchy | terms; `Relation`, `Direction`, `Depth` | network plus edge table | 6 |
| **`vfb:types`** Neuron Types | region terms; `Relation` | table of types | 6 |
| **`vfb:transmitters`** Neurotransmitters | types; `Source` | table | 6 |

### Choosing the class — built and measured in Phase 0

One function, `typeClass` in `src/data/vfb/classes.ts`, which every node that needs a neuron's
type reads, so no two of them can disagree. **The rule: a neuron's type is the most specific
class, at or above its asserted classes, that some connectome names.** FBbt records each
dataset's own name for a class as a synonym (`fbbt#name_in_hemibrain`, `name_in_banc`, …). A class
somebody named in a connectome is a cell type by construction, and `adult cholinergic neuron` is
named in none, so no size cut-off is needed:

1. Drop any asserted class that is an ancestor of another asserted class.
2. From each remaining class, walk `SUBCLASSOF` upward and stop at the first level holding a named
   class.
3. Drop any candidate that is an ancestor of another candidate. Exactly one left is the answer,
   with how many steps it climbed. Two left is reported as a **tie**, never resolved by choosing.
   None is **no type**, never the generic class. Either way it is counted with `ctx.warn`, and the
   row is kept.

`VFB_SYMBOL` is a synonym type as well, and it is deliberately **not** a dataset name: VFB gives
its own short label to generic classes as readily as to cell types.

**How many names there are** (synonym edges, 2026-10-14): male-cns 16,269, BANC 14,998,
FlyWire 6,970, hemibrain 5,459, MANC 5,370 and Optic Lobe 1,023, plus 6,248 `VFB_SYMBOL`.

**Measured against hemibrain's own typing** (`pnpm probe:vfb-classes`, all 22,705 hemibrain
v1.2.1 individuals VFB holds; about 4 s for the whole set, of which `fetchIndividuals` takes 2.3 s
and `fetchClassGraph`, over 5,744 classes, 1.1 s). "Exact" means the chosen class's
`name_in_hemibrain` is the neuron's own type. The type is read off its neuPrint instance as the
longest hemibrain name it equals, or starts with followed by `(`, `_` or a space.

| Outcome | Neurons | Share | What it is |
| --- | --- | --- | --- |
| exact | 19,517 | 86.0% | 18,881 asserted directly, 553 one step up, 83 two steps up (the PFNa case) |
| named, not in hemibrain | 1,670 | 7.4% | the chosen class is named by other datasets but carries no `name_in_hemibrain` (FB columnar FS/FC types, `KCab-m` → *alpha/beta Kenyon cell*) |
| no named class | 1,025 | 4.5% | nothing at or above the asserted classes is named (`aSP10A`, `LC31`, `FB2F_c`) |
| instance matches no hemibrain name | 491 | 2.2% | spelling, not typing: `KCa\'b\'-ap1` against `KCa'b'-ap1`, `v2LN34c` against `v2LN34C` |
| unrelated class | 2 | 0.0% | a curation error (A12) |
| tied | 0 | — | |

**Of the 2,163 that are not exact or a spelling difference, 2,039 sit at 0 steps climbed**: VFB
asserts the coarse class directly. So the misses are gaps in VFB's names and assertions, not the
rule overreaching. That answers open question 1, and turns A3 from "mark the type" into "confirm
`name_in_*` is the signal, and fill its gaps" (A11).

### A second bridge: by name, needing no neurons and no version

The same synonyms make UC3 a pure ontology lookup: (dataset, type name) → the class named that in
the dataset → the target dataset's name for the same class. hemibrain `PFNa` → `FBbt_00111396` →
BANC `PFNa`, with no individual neurons involved, and therefore **no version to match** (G3 does
not arise). The neuron route stays, for neurons whose own type a dataset has not assigned, and for
counting what each side holds. The plan's reverse direction of VFB Neurons gains a `By` control:
neurons (the version-exact route) or names (this one). Which is the default is a Phase 3 decision,
made against the six types in the UC3 table.

### The bridge is version-exact

VFB cross-references each materialization separately: male-cns v0.9 *and* v1.0 (166,681 and
166,693), BANC 626 *and* 888 (80,505 and 145,948), FlyWire 783 and hemibrain v1.2.1. A root id at
a different materialization is a different neuron (backends.md), so `sites.ts` maps a Coda dataset
version to a VFB site only on an exact match. Anything else is refused by name. Getting a table to
VFB's version is a separate, explicit step (*Gaps in Coda*, G3).

## Data layer — `src/data/vfb/`

A data module that nodes call (the precedent is `data/zapbench` and `data/neuronbridge`), not a
`DataSource`.

- **`client.ts`** ✔: VFBquery GETs through `common.ts`' `vfbJson` (an `AbortSignal` and no
  timeout: a cold query is slow, and time is never a refusal), and `readTermInfo` (the
  plan's `termInfo.ts`), which reads a term's page: images per template, the named queries, the
  parents, relations, names and papers VFB Info shows. URLs that are not VFB's or not `http(s)` are
  dropped.
- **`pdb.ts`** ✔: read-only Cypher. Parameters are always passed as `$params` and never spliced into
  the query.
- **`classes.ts`** ✔: `typeClass`, pure over a `ClassGraph`.
- **`bridge.ts`** ✔: every PDB read the nodes make, through one `rowsFor` (up to 200,000 ids a
  statement): `fetchIndividuals` (a batch cross-reference), `fetchClassGraph` (labels, parents and
  `name_in_*` names, walked up to `MAX_CLIMB`), `fetchReferences`, `fetchLines` and
  `fetchLineImages`.
- **`markdown.ts`** ✔: `markdownSpans`, the one reader of VFB's markdown (`[label](id)`).
  Fixtures of the real responses live in `__fixtures__/`.
- Publications reads a term's papers from the PDB rather than term info (`fetchReferences`),
  because the PDB's edge carries the role.
- **`sites.ts`** ✔: nine releases, with `siteRefusal` naming the releases held when one is not.
- **`live.test.ts`** ✔ (`VFB_LIVE=1`): every site still exists, MBON01 and PFNa still resolve as
  measured, a term's definition still parses, and an LM `volume.obj` is still faceless.
- **`templates.ts`** ✔ (the templates listed, which has a Coda space, which is stored turned),
  **`pointCloud.ts`** ✔, **`stacks.ts`** ✔ over the format reader `data/nrrd.ts`, and
  **`common.ts`** ✔ (`vfbJson`, `vfbUrl`/`vfbFileUrl`).
- Next, **`regions.ts`**: a committed snapshot of JRC2018U's painted domains, so the region picker needs
  no peek.

## Gaps in Coda

What these workflows need that Coda does not have yet. The *Where* column says whether a gap is
the pack's to fill or the base's.

| | Gap | Found by | Where |
| --- | --- | --- | --- |
| G1 ✔ | **Tables draw no links.** Fixed in Phase 1 (`ui/LinkedText.tsx`); identifier columns since 1c through `ColumnSchema.link` and `ui/ColumnLinkCell.tsx`, labelled with the identifier (the exception `ui/linkify.ts` records). `TableViewer` renders text, so a DOI, a PMID or a VFB term page cannot be clicked. The fix is a link-rendering rule for URL-shaped cells or a declared link column, under `IssueText`'s rule: the visible text is the href, and only `http`/`https`. | UC1 | base |
| G2 | **No inbound link can name a term.** A shortcut only switches packs on, a share link carries a whole graph, and `demo://` builds from node types. An "Open in Coda" button on a VFB page needs something like `/vfb?term=FBbt_00100234&dataset=flywire` that builds a chain on arrival — a wizard answer or a recipe filled from the URL. pages.md's rule holds: *a link names a thing, it never carries one.* | O1 | base + pack |
| G3 | **Getting a neuron table to VFB's materialization.** FlyWire is pinned at 783, but a BANC or male-cns workflow on a newer version has ids VFB does not hold. The CAVE root-id nodes exist; whether they can take a table to a named older version and say what was lost is unmeasured. | UC3 | base (CAVE part) |
| G4 ✔ | **A term id has no hover.** Done in Phase 1c (`ui/vfb/TermHover.tsx`, `ColumnSchema.link: 'vfb'`). A neuron id gets `NeuronThumbnail`, but an `fbbtId` gets nothing. A term panel (label, definition, thumbnail, a link to VFB) through `useHoverPanel` would make every table above readable. | UC1–3 | pack, with a base seam for "a column of this kind gets this hover" |
| G5 | **Two correspondences cannot be compared.** UC3 produces VFB's mapping and `Match Cell Types` produces a connectivity-derived one, but no view shows where they agree and disagree. | UC3 | pack or comparative |
| G6 | **A count before Run.** The `nlp` trap is visible only once a run returns 37k neurons. A role or climb option that shows the count it would return needs a cheap count query, which is exactly the thing invariant 6 says not to fire per edit. A design question, not yet a gap with a fix. | UC2 | pack |
| G7 | **No `volume` kind.** Points cover v1. | images | base |

## Asks of VFB

Each ask comes with the measurement behind it. All are "would make this simpler or more correct",
not "blocks the prototype": every use case runs today against the PDB.

| | Ask | Why |
| --- | --- | --- |
| A1 | **May a browser query the PDB directly, and at what rate?** Or would VFB rather expose the few queries below? | The bridge, the class choice and the climb all need it. It works anonymously, but the docs present it as low-level access. |
| A2 | **A batch cross-reference endpoint:** `POST /xref` with a site and a list of accessions → individuals plus their most specific class. | `/xref` takes one accession per call, and 1,000 neurons would be 1,000 requests. |
| A3 | **Confirm `name_in_*` is the cell-type signal.** Coda reads "named in some dataset" as "is a cell type" (*Choosing the class*). Is that what VFB intends, and will every curated type carry one? | It gives 86.0% exact on hemibrain with no tie. Without it, 252,336 `INSTANCEOF` edges over 166,693 male-cns individuals carry no flag saying which is the type. |
| A4 | **A correspondence query:** types (or individuals) plus a target site → the target's neurons at the most specific shared class, with the climb and the counts. | UC3. VFB would then own the rule rather than each client re-deriving it. |
| A5 | **Paper → types by DOI or PMID, with the role.** Check whether `TermsForPub` already takes a DOI. | UC2. The role (`def`/`syn`/`nlp`) is on the PDB edge but not obviously in VFBquery's rows. |
| A6 | **Structured rows from `run_query`.** An option returning `{id, label}` instead of `"[label](id)"` markdown. | Every client re-parses the markdown, and that is the part of the format most likely to change without notice. |
| A7 | **Which materializations VFB keeps, and the policy.** One dataset version is also labelled two ways: `list_connectome_datasets` says male-cns v1.0 while `run_query` rows cite v0.9. | The bridge is version-exact. Knowing what will be kept decides whether Coda shows "VFB holds this version" or tries to translate. |
| A8 | **Coverage notes.** Hemibrain v1.2.1 has 22,705 cross-referenced individuals. Is that the full traced set VFB intends to hold? | A reverse lookup has to say what it cannot find, and whether the absence is VFB's choice or a gap. |
| A9 | **Cold-query latency.** `TransgeneExpressionHere` on MBON01 returned nothing within 90 s. | Coda now waits for an answer, with no timeout; a warm cache would make the first Run as fast as the second, and decides whether the pack can offer the query at all. |
| A10 | **Document `volume.obj` for LM images** as a point cloud with an intensity, and state its threshold. | It is a mesh format carrying no faces; the docs never say so. |
| A11 | **Fill `name_in_hemibrain` gaps.** 1,670 hemibrain neurons (7.4%) land on a class other datasets name but hemibrain does not, at 0 steps climbed, e.g. FB columnar types (`FS4A`, `FC2B`) and `KCab-m` asserted as *alpha/beta Kenyon cell*. 1,025 (4.5%) have nothing named at or above them (`aSP10A`, `LC31`, `FB2F_c`). The full lists come from `pnpm probe:vfb-classes`. | The same rule applied to any dataset; hemibrain is just where the type to check against is to hand. |
| A12 | **Two hemibrain PFL2 neurons are typed as PFL3.** `VFB_jrchk3cq` (body 948333783, `PFL2(PB12b)_R3_C3`) and `VFB_jrchk3cz` (979752365, `PFL2(PB12b)_L3_C7`) are `INSTANCEOF FBbt_00051263`, a PB-glomerulus-**2** subclass of PFL3 (`FBbt_00111443`, unilateral). FBbt's PFL2 is `FBbt_00111451`, and their siblings are typed under it. Their instances say glomerulus 3, too. | Found by the probe as the only "unrelated class" outcome. A single curation error, and the shape of what O2 would report in bulk. |
| A13 | **480 hemibrain symbols carry a backslash before a quote:** `KCa\'b\'-ap1`, where neuPrint and FBbt write `KCa'b'-ap1`. | An escaping step stored rather than undone. Any client matching on symbols misses these. |
| A14 | **Name case differs from the dataset's:** FBbt's hemibrain name `v2LN34C`, the instance `v2LN34c_R`. Which is authoritative? | 491 instances (2.2%) match no hemibrain name, and these differ only in spelling. |
| A15 | **The male-cns v1.0 site's `link_base` has a typo:** `qr%5B0%5D%5Bds%5D=male-cns%3Av01.0` (`v01.0`, not `v1.0`). | Every "open in neuPrint" link VFB builds for a male-cns v1.0 neuron carries it. |
| A16 | **Publish a signal-only projection beside `thumbnail.png`.** Both `thumbnail.png` and `thumbnailT.png` draw the template under the colour-depth projection; in `thumbnailT.png` only the background is transparent, the template pixels being as opaque as the signal (measured on `VFB/i/0010/2chl`, 2026-10-14). | Seeing an expression pattern without the template then takes the whole stack (0.15–26 MB) where one image would do, and the projection Coda makes from it is grey, not colour-depth. |
| FYI | `data/EM/catmaid.json` is now `max-age=300`, no longer a year `immutable`. | Coda's `publicTokens.ts` still says a year. Harmless, but the note is stale. |

## Offers to VFB

What Coda could give back, to be shaped with VFB once the use cases run.

- **O1 — "Open in Coda" links** from a VFB term or paper page: *this type across every connectome*
  (UC3), *this paper's neurons in FlyWire* (UC2), *these lines beside the EM* (images). Needs G2.
- **O2 — Curation reports, generated rather than written:**
  - types where two datasets never meet at a specific class (PFNa: hemibrain's eight classes and
    no BANC member);
  - neurons whose only classes are generic, per dataset (the table above, made exact);
  - cross-reference gaps, i.e. neurons a Coda dataset has and VFB does not;
  - **disagreements between VFB's curated correspondence and `Match Cell Types`'
    connectivity-derived one** — each disagreement is a candidate error on one side or the other.

  These are Coda workflows whose output is a table VFB could act on, so they test the pack as much
  as they serve VFB.
- **O4 — The reverse lookup, in VFB.** A type page saying "this type in FlyWire, BANC, male CNS:
  N neurons each", answered by the name route (*A second bridge*) with the climb as a fallback, and
  linking into Coda for the analysis (O1). The rule and its measurements are in *Use case 3*.
- **O3 — Connectivity as evidence for typing.** Where a neuron has only a generic class, its
  connectivity profile beside typed neurons is a suggested type. This is speculative, and it is
  listed so the conversation can start.

## Possible future: VFB dashboards built in Coda

Coda can be reconfigured entirely by switching packs on and off, so a further step is to rebuild
the individual widgets of the VFB website as Coda nodes and viewers. Users could then assemble
their own VFB dashboards: a term's information beside the lines that label it, their images in 3D
beside the EM, and the type's connectivity across datasets, laid out in Coda's grid view
([dashboard.md](dashboard.md)) and saved or shared like any workflow.

Candidate widgets, from VFB's website features: Term Info, the query result tables, the 3D
viewer, the slice viewer, layers, the circuit browser, the template ROI browser, thumbnails, and
NBLAST similarity and upload. Several already have a counterpart or a start here:

- **Query tables**: the `vfb:` nodes, with `TableViewer`'s links (G1) and the term hover (G4).
- **3D viewer and layers**: the 3D View, with Load Expression's points beside transformed EM.
- **Thumbnails**: the Line Gallery (Phase 1c).
- **Circuit browser**: Coda's own connectivity nodes, once VFB types bridge to connectome neurons.
- **Slice viewer**: the Line Gallery's Slices view for one image; a slice viewer as a node still
  needs the volume kind (G7).

What it would need, beyond the widgets themselves:

- **A shortcut that narrows.** Today a shortcut only ever switches packs *on*
  (`packs/shortcuts.ts`), so `/vfb` adds VFB's nodes to everything else rather than presenting a
  VFB-shaped Coda. A "VFB edition" means a shortcut, or an inbound link (G2), that also opens a
  dashboard and stands the other packs down, which that file's header currently rules out.
- **A dashboard as the entry point.** Arriving from a VFB term page (O1) should open a ready-made
  dashboard for that term, not a canvas. This is a starter built from the term, in the way the
  wizard builds workflows ([wizard.md](wizard.md)).
- **Agreement with VFB on which widgets to mirror.** A widget rebuilt here but maintained there
  drifts. The ones worth doing are those Coda adds something to: composing them, wiring them to
  connectome data, saving and sharing the result.

## Phases

Reordered on 2026-10-14. **Connectome → VFB is the pack's main use case**: start from neurons
somebody already has on the canvas and bring in what VFB knows about them. The inverse
(VFB → connectome) may be better placed inside VFB itself, so it is deferred here and offered to VFB
instead (O4).

0. ✔ **Data layer** (2026-10-14). `client`, `pdb`, `classes`, `bridge`, `rows`, `sites`,
   fixtures, unit tests, a gated `live.test.ts`, and `pnpm probe:vfb-classes`. The rule measured
   86.0% exact on hemibrain (*Choosing the class*).
1. ✔ **Connectome → VFB** (2026-10-14). `vfb:neurons` (VFB Neurons, forward only) and
   `vfb:publications` (VFB Publications, UC1), the pack manifest (`src/packs/vfb/`, off by default),
   `/vfb`, glyphs, See also, help, and export excuses (Python and R refuse until Phase 5). **G1** is
   done in the base, at two depths: `ui/LinkedText.tsx` draws `splitLinks`' spans for `IssueText`
   and `TableViewer`, so an `http(s)` URL in a text cell is a link whose text is its href; and
   `ColumnSchema.link` lets an identifier column (a bare DOI, a PMID) be drawn as a link while the
   data stays the identifier (`ui/columnLinks.ts`). G4's term hover is the same seam's next kind. Measured end
   to end against VFB: four male-cns ids typed in 1.0 s, their papers in 0.1 s. Publications reads
   the PDB rather than term info, because only the PDB edge carries the role.
   - ✔ **1b. Lines and images** (2026-10-14). `vfb:lines` (VFB Driver Lines), `vfb:images` (VFB
     Expression Images), `vfb:expression` (VFB Load Expression), with help, glyphs and export
     excuses. Measured end to end on male-cns body 10013 (MBON01): 2 split lines → 19 JRC2018U
     images, 6 with a point cloud → 162,181 points in 2.6 s, nm, `JRC2018U`. What the measuring
     found:
     - **A line labels a type** via `(type)<-[:INSTANCEOF]-(part)-[:part_of]->(line)`: VFB's
       curated assertions and its typed single-neuron images. Not split-only — MBON01 has 2 splits
       and 15 GAL4/LexA lines this way; 1,235 split and 2,783 other patterns across VFB. Lines for
       1,000 FlyWire types: 1,509 in 3.2 s. `targets` counts FBbt classes only, a line's image
       fragments being typed `VFBext_0000004`.
     - **An image's template is read off its file folder.** Following the template's `depicts`
       edge took 9.4 s for one line (and timed out at 120 s for 45); the folder test 0.18 s.
     - **56% of registrations have no `volume.obj`** (101 of 180 for MBON01, PFNa and the giant
       fiber), only NRRD — listed and counted, not drawable until the volume phase.
     - **A cloud is 16,508–482,191 points (0.95–28 MB, 0.3–5.5 s)**, so Load Expression thins to
       `Points per image` (50,000) at an even stride. VFB has already thresholded them (lowest
       intensity 0.07–0.34), so `Min intensity` defaults to 0 — open question 4 answered.
     - Licences vary by collection (Gen1 GAL4 is CC-BY-NC-SA), so `license` is a column.
     - VFB's file URLs are `http://`; the host serves https, so they are upgraded, and any other
       host is dropped.
   - ✔ **1c. Gallery and term hover** (2026-10-14). `vfb:gallery` (VFB Line Gallery), a `cheap`
     viewer: one tile per line at its first whole-line image, `+N` for the rest, lines in steps, a
     detail pane with specimen, dataset, licence and links (a large view since the 1c iteration). ☆ pins an image into `Pinned`, the input's
     rows for the pinned ids, so `Expression Images → Line Gallery → (Pinned) → Load Expression`
     loads only what somebody chose — the answer, for now, to how many images a 3D View gets
     (open question 6). The tile is NeuronBridge's, extracted to `ui/viewers/ImageTile.tsx`, with
     the shared classes renamed `.image-tile*`. **G4** is done: `ColumnSchema.link` gained `vfb`
     (VFB's own term page), every VFB id column the pack emits carries it, and the table viewer
     labels such a link with the identifier rather than the URL — safe because the host is a fixed
     prefix in `ui/columnLinks.ts` — and answers a rest on a VFB term with `ui/vfb/TermHover.tsx`: its
     name, VFB's definition and a thumbnail, asked of VFBquery when the panel opens and once per
     term per session.
   - ✔ **1c iteration** (2026-10-14). The Line Gallery is laid out like NeuronBridge: a large view
     on top (`ui/vfb/ImageStage.tsx`) and the grid below, an opened line drawn as one outlined band
     (`TileGroup`, shared with NeuronBridge). What made the large view cheap: **VFB's "thumbnail"
     is a full-resolution colour-depth maximum projection** over the template — 1212×566 for a
     JRC2018U brain image, 1292×660 for the VNC — so the projection, zoomable, costs one image
     request. **Without the template it is drawn from the stack**: `thumbnailT.png` was read at
     first as the projection without the template, and the checkbox did nothing visible, because it
     is the same picture with only the background transparent (its template pixels as opaque as the
     signal). VFB publishes no template-free projection (A16), so unticking downloads the stack and
     projects it in the browser — 125 ms for a brain stack, 330 ms for a VNC one, grey. Only the
     projection (under 1 MB) is kept; the stack is held only while Slices shows, and loading it
     again is cheap because VFB serves stacks with `max-age=31536000`. The same layout bug cut off
     the tiles: a 660×1290 VNC image laid out 150×293 in a 64 px tile, so one shared fill rule
     covers the tile and the stage (NeuronBridge's tiles included). **VNC stacks are stored a
     quarter turn from VFB's pictures** (660×1290 standing against 1292×660 lying), so whatever is
     drawn from one is turned clockwise (`VfbTemplate.turnedClockwise`): of the turns, clockwise
     lines the projection's features up with the thumbnail's and its mirror does not (correlation
     0.29 against 0.24, the asymmetric cell bodies settling it by eye; `VFB/i/0010/2mv4`). **Slices** load the stack on
     request (`data/vfb/stacks.ts`, `data/nrrd.ts`): every stack is 8-bit gzip, 0.15–26 MB and 0.2–0.8 s to download,
     115–325 MB decoded (VNC 660×1290×382), so one is held at a time. VFB's own slice viewer is slow
     because it renders slices of the Woolz files server-side per view; the NRRD is one fast
     download. Expression Images lists **brain and VNC** by default (SS02268, the giant fiber's
     split, has 7 brain and 5 VNC whole-line images; the VNC ones were hidden by a brain-only
     default). Load Expression keeps the images in a template Coda can place and counts the VNC
     ones out, so a brain scene stays aligned. **Open: placing VNC images in 3D.** Coda places a
     nerve cord into JRC2018U with a fixed affine (`JRCVNC2018U_TO_JRC2018U` in
     `scripts/gen-transforms.py`); the same matrix applied to a VFB VNC cloud would put it beside
     transformed MANC or BANC neurons. It lives only in the generator, which could not run here
     (navis fails to import), so the manifest should carry it on the next regeneration rather than
     by a hand edit.
   - ✔ **VFB Info** (`vfb:info`, 2026-10-14). VFB's page for each term in a table, one per page:
     the hover's name and definition, plus what it leaves out — parent types, relationships,
     **each connectome's own name for the type** (FBbt's `name_in_*` synonyms: male-cns, banc,
     flywire_fafb and hemibrain all name MBON01), other names, example images, papers with DOI and
     PubMed, cross-references. A `cheap` viewer whose `evaluate` passes its input through: the card
     asks VFBquery for the page on screen only, through the hover's per-session `termInfo`. Terms
     named in the text are `ColumnLinkCell`s labelled with the term's name, VFB-prefixed links with the
     hover on them; VFB has pages for
     papers, GO and PATO terms but not RO relations, so only FB/VFB ids are linked. Checked in a
     browser at the default card width against live VFB: nothing scrolls sideways, every image loads
     inside its frame.
2. **Paper → neurons (UC2)** and Find Terms, if still wanted once Phase 1 is in use.
3. **VFB → connectome (UC3) — deferred.** The reverse bridge and the climb report. The measurements
   above stay as the case for O4.
4. **Stocks, hierarchy, region types, transmitters.**
5. **Inbound links (G2 / O1), exports, wizard answers.**
6. **Volume kind (G7).**

## Open questions

1. ~~**The generic rule.**~~ Answered in Phase 0: "named in some dataset" replaces any size
   cut-off, and measured 86.0% exact (A3 asks VFB to confirm it).
2. **Stocks for a split.** `find_stocks` takes `FBco`, and a split class id spells its two `FBtp`s.
3. **JRC2018U VNC.** Whether VFB's `VFB_00200000` shares Coda's nerve-cord frame closely enough to be
   labelled with a space.
4. ~~**Is `volume.obj` thresholded?**~~ Yes (Phase 1b): lowest intensity 0.07–0.34 by collection.
5. **Driver kind from structure, not from a name.** `split` is VFB's `:Split` label; GAL4 and LexA
   are read off the construct name with a regex, so a lone hemidriver reads as GAL4 and QF or GAL80
   fall into `other`. The `VFBexp_` ids embed FBtp ids, and FlyBase types what a construct encodes
   through FBto terms — probe for that edge and read the kind from it.
6. **Points per image, or a budget across images?** Load Expression thins each image to a cap
   (50,000). Meshes' `Downsample` records the opposite lesson — a target for the whole set, since no
   factor suits two inputs at once. Decide once the 3D View has been looked at with a dozen lines.
7. **Where the inbound link builds from** (G2): a wizard answer, a recipe, or something new. To be
   settled with VFB, since it is their button.
