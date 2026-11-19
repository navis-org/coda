# Extending a neuron step by step — plan

Status: **all phases done** (2026-11-17). A neuron can be extended from the review card and Submit merges it as a tree; the sandbox write test passed, and a first real batch of 27 nested merges went through. Continuing through small flakes was tested and not built (below). Follows
[seam-merge-plan.md](seam-merge-plan.md), which made the single forward pass: pick a neuron,
generate candidates, review, merge.

This plan is for the loop: accept a piece, search *that piece's* open ends for what continues it,
review those, and repeat until the neuron is filled out. On-demand pipeline only.

## The workflow

1. Run the on-demand chain for the seed neuron and review it, as today.
2. Accept a piece. Its row gets an **Extend** button.
3. Press Extend. Suggest Merges finds the piece's open ends by re-running the chain above its
   `Tips` input — Meshes, Clean Meshes, Find Open Ends, Sort, Sample, whatever is there — for that
   piece alone. It then searches those ends, treating the seed and every piece between the seed
   and this one as a single neuron. The new rows stream into the same queue, under the same
   neuron.
4. Repeat from 2 on the new rows.
5. Submit at any point. The merges are sent from the seed outwards.

## Decisions (user, 2026-11-16)

| Question | Decision |
| --- | --- |
| Which node runs the search for a piece | **Suggest Merges**, told what to extend by a dotted wire from Review Suggestions. Not the review card itself, and not a visible loop of nodes. |
| When it starts | **By hand, unless `Auto-extend` is on.** An accept starts nothing; each accepted row has an Extend button, and only extended pieces are searched. `Auto-extend` (added later the same day, off by default) extends a piece as it is accepted — **except a large one** (41 level-2 chunks or more), which is left to its button, and **only pieces accepted from then on**: switching it on starts nothing. |
| When merges are sent | **Only at Submit.** Accepted pieces count as part of the neuron for searching and drawing; nothing is written before Submit. |
| Published sets (`seam:suggestions`) | **Left for later.** The card says a piece from a published set cannot be extended. |
| A table of what became of each piece (`Pieces`) | **Dropped**, after it was built in phase 4. Few pieces are expected to fail, and it was a third output on a node that is already hard to read. A failed piece is a warning on the Suggest Merges card. If failures mount up it can come back. |

## What is in the way today — read off the code

- **A graph has no cycles, and `For Each` does not fit.** A loop publishes no partial results
  (`derivePreviews` leaves loops out), so the card would not fill while the search runs. It also
  re-runs every pass when its collection grows, and is not adopted by a newer run.
- **Review Suggestions is `cheap` and re-runs on every click** — the cursor and the verdicts are
  data params. It cannot hold minutes of work, and making it `expensive` would put 700 ms between
  a click and the viewer.
- **The result cache holds one entry per node.** Anything that changes Suggest Merges' key makes
  it search the seed's ends again: 6.2 s an end in Chrome, 11.0 s in Firefox.
- **Suggest Merges searches one root per tip.** Searched on its own, a piece's best candidate at
  the end facing the neuron is the neuron it was just accepted onto.
- **Review's cursor is a bare `end_uid`,** resolved inside one root. `end_uid` is a counter of one
  run of Find Open Ends, so every piece starts again at 0.
- **The merge plan and the batch assume every merge's neuron end sits on the seed's root.** A piece
  accepted onto another piece has its neuron end on that piece.

## The design

Five parts. The first two are small core features; the rest is in the `seam` pack.

### 1. What is extended is a param on Review

A new param on `seam:review`, `extend`: a list of `parent/piece` pairs, the same shape as a
verdict key.

- **Pairs, not piece ids**, so the tree can be read from the params alone. That is the condition
  a reference rests on (part 2), and it is why the verdict key stays `parent/piece` rather than
  becoming `seed/piece`.
- **What counts as extended**: a pair that is in `extend`, still has the verdict `accept`, and can
  be reached from a seed through other such pairs. One function, `extendedTree(params)`, read by
  everything.
- **Un-accepting a piece drops everything beyond it** from the queue. The verdicts on those rows
  stay in the param, unread, and come back if the piece is accepted and extended again. The card
  says how many pieces go with it before the click lands.
- **The order must not depend on the order of clicks.** A piece reached by two routes takes the
  shorter one, then the lower parent id. Pieces are listed breadth first. A reload followed by Run
  must produce the same tables the session did.
- A data param (it is in the key), and an ordinary undo step.
- **The Extend gesture** is one `setParams` and then `runNode` on the Suggest Merges the card is
  wired back to, so it works whatever auto-run is set to. With auto-run on, the two runs are one:
  a newer walk adopts the evaluation (`core.md`, "supersedes the walk, not the work").

### 2. A reference that reads params

A new input on `seam:suggestMerges`, `Review`, marked `reference`, wired from a new `Extended`
output on `seam:review`. Drawn dotted, as references are, and running right to left.

Before this, every reference was a dataset: `gatherInputs` built the value with
`datasetIdentity(type)` and the key with `referenceKey(type)`. This is the second kind, so the mechanism has to say what a
reference to a non-dataset node reads.

- **`NodeDefinition.asReference(params)`** returns the value a reference to this node is handed —
  for Review, the extended pairs as a small table. Its hash is the key.
- **Sound for the reason dataset references are**: it is a function of the referenced node's
  params alone, so it is known without running anything downstream. Review's inputs never reach it.
- **The key moves only when `extend` or an accept inside the tree moves** — never on a click of
  the cursor or a reject. Keyed on all of Review's params, every click would re-key the search.
- Places to change, from `core.md`'s list: the value and the key in `gatherInputs` and
  `desiredKeys` (one function for both, as `referenceKey` is); `unresolvedReference` and
  `Scheduler.settle`, which are about a dataset naming itself and must skip this kind. Inference
  already resolves a reference by running the source's `inferOutputs` with no inputs, which
  Review's survives. `dataflowEdges`, `wouldCreateCycle` and the layout need nothing.
- The real `Extended` output and `asReference` call the same function, so they cannot disagree.

### 3. A node re-running the chain above one of its inputs

`ctx.rerunInput(portId, { neurons })`: run everything above this input again with a different
neuron on the wire, and hand back the value that arrives.

- **A private `Scheduler` over a changed copy of the graph** (`src/core/variantRun.ts`, headless).
  `Scheduler.run` already takes the graph per call and a `targets` list, so nothing inside the
  scheduler changes. The copy is the whole graph with the neuron wire cut and an `Input IDs` node
  put in its place; the run's target is the node feeding the port.
- **Which wire is "the neuron"**: going up from the port, the nearest wires whose type is
  `neurons`. In the attached workflow that is `Input IDs → Meshes`. Two such wires from different
  sources, or none at all, is refused in a sentence naming them. A picker is added only if that
  refusal turns out to be common.
- **Per-piece by construction.** Sort and Sample rank one piece's ends, not every piece's
  together, and an expensive node anywhere in the chain costs only the new piece. This is the
  reason for a private run over a visible loop.
- **Only an `expensive` node may call it**; it carries the caller's signal, so Cancel stops it,
  and passes inner warnings up with the piece's id on them.
- It is the loop's own idea — "a new pass is indistinguishable from somebody having edited a
  param upstream" (`loops.md`) — on a second scheduler, so it does not disturb the cards' states
  or their one cache entry each.
- Refused: a `For Each` in the chain above the port.
- **Memory**: the private scheduler is dropped when the value is in hand, and what it held goes
  with it. The memory meter cannot see it while it runs. The closure must be built in a function
  holding only the graph and the host, never the pass (`core.md`, the evaluation rule).

### 4. Suggest Merges searches a piece as part of the neuron

**The neuron so far**, for a piece, is the seed plus the pieces on the path from the seed to it.
Not its siblings and not anything accepted later. That is fixed by the tree, so an answer does
not depend on what else was accepted first, and "a published end is final" still holds.

- **A piece's tips** come from `ctx.rerunInput('tips', …)`, kept per piece for the session.
- **One object in the box.** Where `labelledBox` fills `roots`, the roots of the path are written
  as the seed's root. The pool measure, the sizes and the assessor's patches then see one neuron,
  and `queryRoot` is the seed's. One place, shared by the search box and the patch box.
- **The neuron's size** for the ranker's `l2x` feature is the sum of the path's chunk counts.
- **The end where the piece joins is not searched** — the **one** tip nearest the contact the piece
  was accepted at, where that is within `ownUm`. Published with `searched = false` and
  `junction = true`, and still counted in the own-tip rule, as an end outside the volume is
  today. Not every tip within `ownUm`, as this plan first said: phase 0 found a piece of one
  level-2 chunk is shorter than the radius, so both its ends went and nothing was searched.
- **The own-tip rule** is measured against the tips of the piece and of every piece on its path.
- **`forgetRoots` runs between seeds, not between pieces** — one seed's pieces overlap.
- **Published tables**: the seed's rows as today, then each extended piece's. `ID` stays the
  piece's own root, which the verdict key and the merge anchors need. New columns: `seed`,
  `parent`, `depth` and `junction` on `Tips`, `seed` on `Candidates`. Always declared, so a
  picker below sees one shape.
- **A memory of finished ends**, kept by the node for the session and bounded in bytes. Keyed on
  everything that decides an end's answer: ranker, assessor, `Assess top`, datastack and version,
  the path's roots, the positions of the competing tips, and the tip itself. Extend moves the
  node's key, the node runs again, and every end already searched is answered from here. The same
  memory makes a cancelled run resumable. The node declares `dataCache` and clears it on
  `ctx.refresh`, as Connection Compartments does for its own.
- **Order of work**: the seed's ends, then pieces breadth first, publishing after each end as now.
- **`warnOverWait`** is priced over the ends not yet in the memory.
- **Extend pressed during a run** retires the evaluation in flight and starts one on the new key.
  Lost: the end in flight, the chunk cache and the open model session. Measure before deciding
  whether to keep those across evaluations.

### 5. Review: one growing neuron, and Submit as a tree

**The queue**

- A neuron in the picker is a **seed**: rows are grouped on `seed`, falling back to `ID` where
  the column is absent, so a published set reads as it does now.
- The cursor (`current`) becomes the tip's key, `neuron|end_uid`. A breaking change to a saved
  param, accepted.
- A row says which piece its tip is on and how many steps that is from the seed.
- An accepted row shows **Extend**; then `searching 3 of 7`; then `7 ends searched` or
  `nothing to search` — which is all the card can say of a piece with no rows, failed or not
  (no `Pieces` table; see Decisions). Disabled with the reason as its title: no wire back to Suggest Merges, a
  published set, a piece already merged elsewhere.
- **Size is said before the press.** The button's title carries the piece's level-2 chunk count,
  and the card warns where a piece is bigger than the neuron it joins: extending it searches a
  whole neuron. A warning, not a refusal (`limits.md`).
- A candidate that is already in the tree by another route gets an `in this neuron` chip, and its
  verdict buttons are off.
- The scene's green pieces and the annotation layer read the whole tree under the seed.

**Submit**

- **Parents first.** The plan lists merges breadth first from the seed.
- **A merge's neuron end is anchored on the parent piece.** On the neuron's root now, where the
  parent is the seed or already merged by the record; otherwise on the parent's own root, which
  stays current until this batch merges it.
- **The dialog**: unticking a piece unticks everything beyond it; ticking a piece ticks the pieces
  before it. A refused parent refuses the pieces beyond it, with a reason of its own.
- **The batch's check is unchanged and still right**: the neuron-side supervoxel must be under the
  root the batch last made, which holds for a child because its parent went first. A child whose
  parent was not merged in the end is `not-sent`, in its own words, never "somebody else edited".
- **The record** keeps the seed as `reviewedRoot` on every entry, so `mergedSoFar` reads as now,
  and adds the parent's root.
- This is write-path code: `/simplify`, then `/code-review medium`, a second review if the first
  finds something big. No live write without asking. The sandbox test is a chain of two on
  `fanc_sandbox` — merge A, merge B onto A, undo both — proposed and approved pair by pair.

## Phases

Each lands on its own. Nothing before phase 6 touches the write path.

0. **Measure, reads only** (`pnpm probe:seam-extend`). **Done 2026-11-16** — results below.
   What the chain above `Tips` costs for one piece; how many of its tips fall within 2 µm of
   the contact; whether the search, with the roots written as one, puts a real continuation
   first.
1. **Core: a reference that reads params.** **Built 2026-11-16** — `NodeDefinition.asReference`,
   `referenceOf` in the scheduler. Tests in `reference.test.ts`, each rule checked by breaking it.
2. **Core: `variantRun` and `ctx.rerunInput`.** **Built 2026-11-16** — `core/variantRun.ts`,
   `rerunnerFor` in the scheduler, `NodeDefinition.rerunsInputs`. Tests in `variantRun.test.ts`.
   Both are recorded in [core.md](core.md). Changed from the plan above:
   - the walk also stops at a wire carrying a **dataset**, so a dataset's own label chain is
     never taken for the neuron;
   - the caller hands over the node to put in (`NeuronSwap`), since `src/core` knows no node
     types — the pack will pass `neuron.inputIds`;
   - it returns the inner nodes' warnings beside the value, for the caller to pass on;
   - progress is a `report` callback fed by the inner nodes' own progress notes;
   - the copy is cut down to what the run reaches, and `asReference` is told which output the
     wire leaves from (both from the /simplify pass).
   - after two /code-review rounds: the copy keeps a node the chain only *names* on its own, so
     the caller cannot end up inside its own re-run; a loop is looked for in everything the run
     needs; the old source still feeding the chain by another output is refused; a failure is
     blamed on the chain's own nodes; a dataset output beside a hook is still read as a dataset;
     a muted source says nothing.
   **Decided (user, 2026-11-16): the nearest neuron wire stays.** It leaves out a transform
   sitting on that wire, such as Update Root IDs between Input IDs and Meshes, without saying so —
   but a piece should not need updating, so this is not a problem in general. Noted in
   [core.md](core.md) with the two ways out, should one ever be needed.
   **For phase 4 to settle:** Clear Cache on Suggest Merges does not reach a piece's re-run chain
   (`ctx.refresh` is one node's flag); and "run this node" on Suggest Merges also runs Review.
3. **Suggest Merges: the memory of finished ends**, with no other change. **Built 2026-11-16** —
   `packs/seam/endMemory.ts`, used by the node's loop through `recalled`. The node still runs
   and still walks every tip; an end it has finished before is answered from the memory, in the
   order an unremembered run would publish it.
   - **The key** is the forest, the assessor and `Assess top`; deployment, datastack and
     materialization; the neuron; *every tip of that neuron the run was given* (the own-tip
     rule); and the end's own position and `e_tip`. Not the tip's row, so a remembered end is
     handed back with its row written again.
   - **A refused end is not kept** — a refusal is a request that failed. An end whose box holds
     none of its neuron is kept: that is the segmentation's answer.
   - **Clear Cache** (`dataCache`, `ctx.refresh`) forgets every end of the run before measuring
     any (`forgetStale`) — the whole run's, not a neuron's at a time, or a run cancelled in its
     first neuron would leave the rest answering from before it.
     **Invalidate Results no longer re-searches** — it clears the result cache, and the ends
     come back from the memory. The card shows the age of the oldest end behind its answer.
   - 64 MB, least recently used first; an end is about 25 kB. On `ByteLru`, a shared helper in
     `core/lruMap.ts` written for this rather than a fourth hand-made copy.
   - **The models are in the key by id.** A manifest republished under the same id while a tab
     is open would mix ends from before and after; a reload or Clear Cache starts clean. A
     digest of what was loaded would be exact, at the price of reading both manifests before
     the wait can be priced. Left.
   - **A run answered wholly from memory opens no assessor** — no GPU session, no download
     tick — so it cannot fail on "no usable GPU" with every answer in hand. The forest and the
     volume are still opened.
   - **A lifetime chosen on the card is honoured up front** (`ctx.maxAgeMs`, new in core): ends
     measured longer ago than that are forgotten before the run measures anything. Left to the
     scheduler's backstop, a node reporting data past its lifetime is evaluated twice — and for
     this node the second pass would redo the ends the first had just measured. The backstop
     itself now asks whether the data was too old when the node *started*, so a run that takes
     long is not run again for crossing the edge while it worked.
   - **The run answers from what the memory held when it started** (`heldEnds`), taken once.
     The wait is priced and the assessor opened, or not, on the same reading the loop then
     uses; and a run larger than the budget cannot push its own later ends out as it re-measures
     its earlier ones.
   - **Known, and left:** a result that *lapses* past a chosen lifetime re-measures every end
     of the run, not only the old ones — a lapse reaches the node as `refresh`, the same as
     Clear Cache. A tip outside the volume is counted as an end to measure, so a run of
     remembered ends holding one still opens the assessor. The Memory dialog cannot see or free
     these 64 MB.
   - The wait is priced over the ends not remembered, and the timing line over the ends this
     run measured.
   - Remembered ends are published at most every 250 ms (`PUBLISH_INTERVAL_MS`), since each
     publish rebuilds both tables — 20–40 ms at a neuron's 505 ends — and the browser is let in
     after each, so Cancel works through a long stretch of them.

   **Checked in Chrome** on the on-demand workflow's own chain (seed `648518347558097460`, four
   ends, no assessor), one `Scheduler`, Suggest Merges' own time:

   | Run | Seconds | Bucket reads | Chunkedgraph calls | Candidate rows |
   | --- | --- | --- | --- | --- |
   | First | 22.3 | 144 | 30 | 271 |
   | After Invalidate Results | 0.22 | 0 | 0 | 271, identical |
   | After Clear Cache | 8.3 | 32 | 8 | 271, identical |
   | After Invalidate Results again | 0.22 | 0 | 0 | 271, identical |

   Run again after the /simplify pass reworked the loop: the same rows and reads. Sampling six
   ends in place of four measured all six (the other tips of the neuron are in the key) and
   going back to four read nothing; the age followed the oldest end each time.

   And with the workflow's own assessor (`n3_mal_mask_s0`, three ends, real GPU): 22.6 s the
   first time, 0.23 s after Invalidate Results with the same `r` on every tip and no session
   opened; with no assessor, another key and 6.5 s; back to the assessor, 0.22 s.

   Run once more after two /code-review rounds, assessed: 23.1 s, then 0.45 s and no reads
   after Invalidate Results (the bar reading "already searched"), then 10.5 s after Clear Cache,
   `r` the same each time.

   The 0.22 s is the forest and the volume being opened, which a run answered wholly from memory
   still does — it needs the volume to say which tips lie outside it. (The first run's extra
   fourteen seconds are Python's packages and a cold chunk cache.)
   **For phase 4:** a piece's path joins the key, and `forgetRoots` moves from between neurons to
   between seeds.
4. **Suggest Merges: the `Review` port and pieces.** **Built 2026-11-16.** The pure parts are
   `packs/seam/pieces.ts` (tested, each rule checked by breaking it); the node does the reading.
   - **The port**: `Review`, a reference, handed a table of `parent`/`piece` pairs
     (`EXTENDED_FIELDS`). Unwired, the node behaves as before and gains the new columns.
   - **The tree** (`piecesOf`): seeds are the neurons of the tips table. A piece belongs to one
     tree, at its fewest steps from any seed; at a tie, the parent with the lower id; breadth
     first, a level in its parents' order — and a seed at a time, since one neuron's pieces
     overlap in the volume and two neurons' do not. Not dependent on the order of clicks. An id
     of 0 is never a piece (`isNodeId`): 0 is the root of every supervoxel the chunkedgraph does
     not list.
   - **A piece's tips** come from `ctx.rerunInput('tips', …)` with `Input IDs` put in, kept for
     the session by the chain's key and the piece, warnings and all. **A failure is kept too,
     for five minutes**: a piece that failed was found out by running its chain, and every Extend
     runs the node again.
   - **One neuron, as one value on each end.** `aliasOf(piece)` — the path's roots, to be written
     as the seed's — rides on the end (`endToSearch`), into every box read for it
     (`labelledBox`' `alias`, required of every caller) and into the assessor's (`EndToAssess`).
     The search sums the neuron's size over the same roots (`queryCountOf`) — all of them, or
     the end is refused, as a neuron's own end is whose root has no count. It was a mutable field
     on the shared volume for a round, sound only while nothing read ahead across pieces.
   - **The junction** (`junctionOf`, `pieceContacts`): the piece's one tip nearest the contact it was
     accepted at, within `ownUm`; published `junction = true`, `searched = false`, still a
     competitor under the own-tip rule. The contact is read off the parent's finished ends, at
     the smallest gap.
   - **The tables grow**: a piece's tips are added beneath (`concatBatches`) and published
     *before* they are searched, so a reader sees them waiting. `ID` stays the piece's root.
     `seed`, `accepted_on`, `steps`, `junction` are new on `Tips` (`LINEAGE_FIELDS`, written by
     `tipsWithFirsts` and nothing else — a test holds the run's table to `tipsSchema`); `seed`
     on `Candidates`. Not `parent` and `depth`: the four are written over whatever the incoming
     tips carried under the same name, and those two are names a reader may have joined on.
   - **A piece that goes wrong is a warning on this card, and the run goes on.** One that cannot
     be extended, one whose search fails, one whose chain answers with rows that are not its
     own tips, and one that is not among its parent's candidates each say so in a sentence
     naming the piece. A third output, `Pieces` — one row per piece with its state and the
     reason — was built here and **taken out again** (user, 2026-11-16; see Decisions).
   - **Clear Cache reaches every piece before anything is measured** (`foreseePieces`): its
     tips and its ends. The flag is spent when the run starts, so forgotten piece by piece a run
     cancelled early would leave the rest answering from before it.
   - **The wait warning counts the pieces**: the unremembered ends of those whose tips are
     known, and for the rest a chain (1.5 s) and two ends each — phase 0's medians. What the
     memory holds of a known piece is taken then, once, and is what the loop answers from.
   - **A failed search of one piece stops that piece alone** — it has a signal of its own, and
     the ends it never reached are taken off the rows the run attempts, so they do not read
     "not yet" on a finished run. **A run that cannot score at all is the run's failure**: no
     usable GPU, found on the first end of a piece, stops the run with its remedy, as it would
     on a neuron's own end.
   - **A piece's tips keep the data-cache contract too**: Clear Cache and a chosen lifetime
     reach them, and their age counts towards the card's.
   - **A piece whose joining end was not found** — a contact, but no tip within the radius —
     has every end searched, and nothing says so now that `Pieces` is gone. Phase 0 met it in
     one piece in nine.
   - **Order of work**: every neuron's own ends, then the pieces breadth first — through one
     function, `searchRoot`, since a neuron is a piece with nothing read as it but itself.
   - **The assessor is opened on the first end that needs scoring**, or up front where a
     neuron's own end is unremembered — a piece's ends are not known until its tips are.
   - **The memory's key** for a piece's end adds its path, and takes every tip of the piece and
     of its path as "the other tips".
   - **A piece already remembered is shown on the clock**, like a remembered end: with two
     hundred pieces extended, every Extend would otherwise rebuild both tables two hundred
     times in one task.

   **Checked in Chrome** on the on-demand workflow's chain (seed `648518347558097460`, three
   ends, its own assessor, real GPU), with a stand-in for Review handing over the pairs. Every
   table came out in the shape inference promised.

   | Run | Suggest Merges took | Tip rows | What was new |
   | --- | --- | --- | --- |
   | No pieces | 22.9 s | 3 | the seed's three ends |
   | Its best candidate extended (`…680055`, r 0.98) | 5.6 s | 5 | the piece's 2 tips: one the junction, one searched |
   | That end's candidate extended too (`…349370`) | 9.4 s | 8 | 3 tips: one the junction, two searched (r 0.98 and 0.62) |
   | A piece with no mesh beside the first | 0.9 s | 5 | a warning naming the piece, with Clean Meshes' reason (and, until it was dropped, a `failed` row in `Pieces`) |
   | The same again | 0.9 s | 5 | the failed piece is not run again |
   | Back to one piece | 0.1 s | 5 | nothing — all remembered, no chain run, no assessor opened |
   | After Clear Cache | 12.9 s | 5 | the seed's ends, the piece's chain and its end, all again |

   The seed's ends came from memory in every run after the first.

   **What the Chrome run caught that no test had**: after the /simplify pass moved the alias
   from a field to a parameter, the assessor's patch box was read without it. The second-level
   piece failed outright ("the query neuron has no voxel in the box") and the first-level one
   scored against the wrong box. The parameter is now required, so a caller that leaves it out
   does not compile.

   **Known, and left** (from the two /code-review rounds):
   - `seed` is written over an incoming column of that name, as `searched` and the first
     candidate's columns are. `parent` and `depth` were renamed for this; `seed` is the word
     this whole plan uses.
   - The loop yields to the browser by hand (`showSoon`) where CLAUDE.md asks for `sliced`,
     which takes a synchronous body and a known count. An async form in `core/slice.ts` would
     be the way to share it.
   - The table is copied once per piece (`concatBatches`), and each piece's parent's ends are
     found by a scan. Measured as a fraction of a millisecond a piece.

   **For phase 5 to know:**
   - There is no table of piece states. What the card can show of a piece comes from `Tips`:
     rows with the piece as `ID` and a `first` not yet filled are waiting; all filled is
     searched. **A piece with no rows once the run has finished reads "nothing to search"** —
     that covers a piece with no open ends and a piece that failed alike, and the reason for a
     failure is on the Suggest Merges card.
   - A candidate that is already in the tree by another route is listed like any other.
   - Add `producedBy: { type: 'seam:review', port: 'extended' }` to the `Review` port once that
     output exists.
   **For phase 6 to know:**
   - A piece's `contact_*` and `min_dist_um` are measured to the neuron *and its path*, on a
     row whose `ID` is the piece. The merge anchors look for the neuron's root near the contact;
     for a piece they have to look for any root on the path.
   - Until phase 6, Submit should be off for a neuron that has rows deeper than 0: the plan
     would anchor a piece's rows on the seed and refuse them for the wrong reason.
5. **Review: `extend`, the seed grouping, the cursor key, the Extend button and its states.**
   **Built 2026-11-16.** The rules are in `reviewQueue.ts`, with a test each
   (`reviewQueue.test.ts`, "a neuron and the pieces it is extended with"); the node in
   `review.ts`; the card in `ui/seam/ReviewBody.tsx`.
   - **`extend`** is a param of verdict keys (`parent/piece`), written sorted. **What is
     extended is one rule**, `extendedPairs`: a pair in `extend` whose verdict is still
     `accept`. The `Extended` output, the reference Suggest Merges holds (`asReference`) and
     the card all read it. Suggest Merges' `Review` port now names that output (`producedBy`).
   - **Which rows there are to review comes from the params, not from the rows**
     (`liveTree` → `piecesOf`, the derivation the search uses; `liveQueue`). A piece that is
     un-accepted or no longer extended is off the list on that click, whether or not the search
     has run again. Its rows still pass through the node's `Tips` output, which is a tap.
   - **A piece's joining end is not listed.** It was never searched and is nothing to review.
   - **A neuron in the picker is a seed**; its tips are its own and its pieces'. The picker,
     the counts, the scene's green pieces, the annotation layer and `Current` all read the
     tree under the seed. A table with no `seed` column reads as before.
   - **The cursor is `root|end_uid`.** Every piece has a tip 0. A cursor saved as a bare number
     resolves to nothing (accepted as a breaking change).
   - **Un-accepting takes the pair out of `extend` in the same edit** (`judgedParams`), so
     accepting it again does not start a search nobody pressed Extend for. The pieces beyond
     it keep their entries: unreachable until it is extended again, and back when it is. The
     verdict buttons and the Extend button say how many pieces go with it, before the click.
   - **The Extend button** is on an accepted row. Off: it writes the pair and runs the Suggest
     Merges node the card's `Extended` is wired back to — one undo step, whatever auto-run is
     set to. On: it says how far that search has got and a second press stops extending,
     running nothing. Disabled with the reason: no wire back (which is also every published
     set), merged by Submit, edited since.
   - **How far the search has got is read off the rows** (`extendProgress`), there being no
     table of piece states: `waiting…`, `searching 3 of 7`, `7 ends searched`,
     `3 of 7 ends searched` for a search stopped part way, `no open ends`,
     `nothing to search` (a finished search that published no row: no tips, or it failed —
     the reason is on the Suggest Merges card) and `not searched yet`.
   - **The list is a tree** (user, 2026-11-16; `arrangeTree`): a piece's tips are drawn
     directly beneath the row the piece was accepted on, a step in for every piece between them
     and the neuron, behind an arrow. Each level is narrowed and sorted on its own by the
     card's filters and `Sort by`. Rules that go with it:
     - the row a piece hangs beneath is the parent's tip that lists it at the **smallest gap**,
       which is where Suggest Merges takes the joining end from;
     - that row is **listed whatever the filters say** — filtered out, the rows beneath it
       would hang from nothing;
     - one row per tip, that row **shows the extended piece** rather than the tip's first
       candidate, and a click opens on it — or the rows beneath would be about a piece the row
       above does not name;
     - a piece none of its parent's rows lists goes after the parent's rows and says
       `on piece …` in words;
     - the indent stops growing after six steps, so a long chain keeps room for the id.
     The first version listed every tip flat, each saying `on piece …, n steps out`; sorted by
     confidence a piece's ends were then scattered through the neuron's.
   - **`Auto-extend`** (user, 2026-11-16) is a card param, presentational: `evaluate` never
     reads it. With it on, a press that *accepts* a piece writes the pair into `extend` in the
     same edit and runs the search — where the piece can be extended (the wire back, not
     merged, not edited since) and is not large (`isLargePiece`, 41 level-2 chunks). A large
     piece is accepted and keeps its `Extend (large)` button, whose title says why. Switching
     the toggle on is not a press: pieces accepted earlier keep their button.
   - **A candidate accepted already on another piece of the neuron** has an `in this neuron`
     chip and its verdict buttons are off: a second accept would be a second merge.
   - **Submit is off for a neuron with extended pieces**, with the reason, until phase 6.

   **Changed from the plan**
   - **The size warning is not "bigger than the neuron it joins".** The neuron's own chunk
     count is not published anywhere the card can read, and adding a column for it is a
     change to Suggest Merges' tables. What stands in: the button's title carries the piece's
     chunk count, and from 41 chunks — phase 0's top band — the button reads
     `Extend (large)` and the title says what a piece that size cost when it was measured.
     Never a refusal. The comparison with the neuron can come with a `neuron_n_l2` column.
   - **Extend is a toggle**, which the plan did not say: there has to be a way to stop
     extending a piece without un-accepting it.

   **Checked in Chrome** on the on-demand workflow (seed `648518347558097460`, 25 ends, its own
   assessor, real GPU, auto-run on), with `Extended` wired back to Suggest Merges, by pressing
   the card's own buttons. Reads only.

   | Step | Took | What the card showed |
   | --- | --- | --- |
   | The first run | 156 s | 25 tips |
   | Accept a candidate | — | an `Extend` button; nothing ran |
   | Extend it (`…114680055`, 1 chunk) | 5.0 s | `waiting…`, `searching 0 of 1`, `1 end searched`; 26 tips, `1 piece extended` |
   | Accept and extend that end's candidate (`…773349370`, 4 chunks) | 8.4–8.6 s | `searching 0 of 2`, `1 of 2`, `2 ends searched`; 28 tips, `2 pieces extended`; rows `2 steps out`; one row lit; the scene is the neuron and both pieces |
   | Reject the first piece | 1.0 s | the title said `…and those of the 1 piece extended beyond it`; one undo step; `Tips` back to 25 rows |
   | Undo | 0.8 s | everything back, from memory |
   | Extend a 15-chunk piece instead | 9.1 s | `1 end searched` |
   | Extend a 1,721-chunk piece instead | 169 s | `Extend (large)` first; then `searching 0 of 25` up to `25 ends searched`; 50 tips |

   Each rule in the list above was also checked by breaking it: 34 breaks, each failing a test.

   **The run book was reviewed the same way** (2026-11-16/17): two rounds of /simplify, two of
   /code-review. The first asked for more than was built — neurons and pieces as one kind of
   record, and the book answering where a piece joins and what is still wanted — which is
   what it is now. Found and fixed after that: a piece whose search failed while it went ahead
   kept its draft join; the last pass over the pieces did not let the browser in; the
   "outside the volume" warning counted a joining end.

   **Reviewed** (2026-11-16): two rounds of /simplify, then two of /code-review, over phase 5
   and what followed. What changed: the rules that had gathered in the card component — what a
   press on a verdict writes and whether it starts a search (`judgedParams`), the Extend
   button (`extendPress`, `extendBlocked`), the verdict buttons (`verdictPress`), a piece in
   the neuron already (`acceptedElsewhere`) — are in `reviewQueue.ts` with tests; the card
   finds the search by who reads `Extended` by reference (`referrerOf`) and no longer by a
   type id; a verdict that extends nothing no longer rebuilds the list (3 ms a click at five
   hundred tips, 100 ms at two thousand with two hundred pieces, before); the tree finds every
   piece's row in one walk per parent (104 ms to 3 ms at that size). Found and fixed: a
   cursor cut short read as tip 0; the count of tips still to search counted a dropped
   piece's rows; a second piece accepted on one tip hung under a row naming the first; a
   failed search read `not searched yet`; the piece a tip is on was missing from the viewer
   with `Show accepted` off; `Tips` carried verdicts on rows nothing else reads.
   The table below was taken before the list became a tree; the tree was looked at in Chrome
   afterwards, on the same workflow.

   **Extending while the neuron's own search is still running.** The pair moves Suggest
   Merges' key, so the scheduler retires the evaluation under way and starts another; the
   ends already finished come back from the memory. It does not run alongside.
   - **First built**, the new run took the neuron's remaining ends first and the pieces after.
     Measured in Chrome (a piece accepted with 6 of 25 ends done): the piece's button read
     `waiting…` for 65 s and its two ends were searched last.
   - **Now a piece goes ahead of the ends the run has left** (user, 2026-11-16). Where the run
     still has ends to measure, the order of work is, a neuron at a time: the ends the memory
     holds; every piece that can be joined by what those found, breadth first; then the rest
     of the neuron's ends. Asked of the run, not the neuron: a piece of a finished neuron does
     not wait for the next neuron's ends either.
     Measured the same way: the piece's tips were listed 2.5 s after the press and both its
     ends searched 13 s after it, where it had been 77 s.
   - **What goes ahead is a draft, put right at the end.** Taken early, a piece is joined by
     the ends its parent has so far, and an end not yet measured may list it at a smaller gap.
     So once every neuron's ends are in, every piece is taken again in order — and for nearly
     all of them nothing has changed and nothing is done.
   - **The run keeps a book, one record per root** (`runBook.ts`, 2026-11-16): a neuron or a
     piece alike, numbered within itself, and the tables are put together from the records in
     the plain order every time they are published. So the order the work is done in is not
     the order it is published in, and a piece can be taken as often as wanted. What follows
     from a root's ends — which tips are still wanted, where each of its pieces joins it — is
     asked of the book, which knows when the ends have moved; nothing is kept beside it.
     **The first version** handed out table rows as the work was done, and put the pieces
     right by taking them off seven lists and doing them again; a cache added beside that loop
     went stale after Clear Cache, in the one case nobody was looking at. Two review rounds
     asked for this, and it replaced that.
   - **Tested without a browser** (`runBook.test.ts`): a piece taken early on half its
     parent's ends — joined at the wrong end, the piece beyond it not reached — and settled
     again ends on the tables a plain run ends on. **And checked in Chrome**: the tables at
     the end of such a run were byte for byte those of a run answered from the memory in the
     plain order, and those of a run after Clear Cache with the piece still extended (371 kB
     of `Tips` and `Candidates`, the same bytes as before the book).
   - A neuron with nothing left to measure takes no detour: an Extend pressed after the search
     has finished takes every piece in the plain order, after the memory pass below.
   - **What the memory answers is taken first and published once** (user, 2026-11-18). Every
     Extend starts the run again from an empty book, and the card keeps the answer it had only
     until the first publish. Published on the clock as the book refilled, that first publish
     held the neurons' rows and whichever pieces had been reached, so the other extended
     pieces' rows left the list and came back a tick at a time, or all at once behind a
     piece whose chain had to run. Now the run starts with a quiet pass — every neuron's
     remembered ends, then every piece whose tips an earlier run kept, with the ends of it the
     memory holds (`fromMemory`, one flag for "measure nothing" and "publish nothing") — and
     only then runs a chain or measures an end. A piece taken in that pass is a draft like any
     other, put right by the last pass. A piece whose kept tips were forgotten (Clear Cache,
     an eviction) still leaves the list until its chain has run again, as an end forgotten
     since does until it is measured — and so does a piece whose parent's end that lists it is
     not remembered, since where it joins cannot be told before that end is measured.
     Measured in Chrome (scratch probe, reads only; neuron `648518347585551219`, its six best
     ends, three small pieces extended, a fourth then extended): before, the three pieces' rows
     went from 4 to 0 at 2.6 s, when the fourth piece's chain published, and came back at the
     end of the run (7.7 s); after, they stayed at 4 throughout (7.9 s).
   - **And an Extend pressed while the last search is still running** blanked the list and the
     Neuroglancer card for a moment (user, 2026-11-18). Not this node's doing: the press retires
     the evaluation in flight, and its partial was dropped then, so every reader fell back to
     the last run that *finished* until the new run's first publish. Fixed in the scheduler —
     a stopped run's partial now stays until the run replacing it publishes — with the
     measurement in [core.md](core.md), "A partial result, while the node is still running".

   **Known, and left**
   - **An end that was refused is not remembered**, so a refused end of a piece that went
     ahead is in its record and is not measured again in that run, but is on the next.
   - **A piece taken ahead can measure one end it then drops.** Joined by what its parent had
     so far, it searches every other tip — the tip that turns out to be the real join among
     them. The tables are right; the cost is one end (seconds) spent before the reader's own
     piece, and that end's age and patches stay in the card's "cached … ago" and the timing
     line though the tables no longer hold it.
   - **A tip that becomes wanted late is judged against the clock then**, not at the start of
     the run like the rest of its piece: an end a minute inside the card's lifetime at the
     start may be past it by the final pass, and is measured again.
   - **The headless test of "early, then again, ends where a plain run ends" drives its own
     copy of the rule** (`runBook.test.ts`), not the node's `settle`, which needs a volume and
     a model. The book's part of the rule is the node's; the branches around it — a failed
     piece, one whose chain could not be run, what the memory holds — are checked only in
     Chrome.
   - **`tipsOf` and `gaveUp` are still the node's**, beside the book: the first is shared with
     the pricing done before any book exists, the second is a piece that never got a record.
   - **Between an undo and the run it starts, the button reads `not searched yet`** for the
     moment auto-run takes to fire. True, and brief.
   - **The card runs the first node that reads `Extended` by reference** (`referrerOf`). Wired
     into two search nodes, Extend runs one and the button reports on that one.
   - **The tree is derived from the neurons that reach the card.** A Filter Table between the
     search and the card that drops a whole neuron can place a piece two neurons share
     differently on the two sides, and its tips are then not listed.
   - **`Auto-extend` sits with the filter fields**, which fold away. Folded, nothing on the
     card says an accept will start a search; the row's button does, once pressed.
   - **Where a piece is attached is stated three times** — the search's joining end
     (`pieceContacts`), the row it hangs beneath (`arrangeTree`) and Submit's first row
     (`acceptedPieces`). The first two now agree on a tie and on a listing with no contact
     point; the third breaks a tie by rank. It matters once Submit sends a tree, and is phase
     6's to settle, with a test that holds all three together.
   - **A candidate that is another neuron's extended piece** would be flagged by Submit's plan
     as a neuron under review. Submit is off wherever that could matter, until phase 6.
6. **Submit as a tree.** **Built and tested 2026-11-17.** Nothing was sent to any chunkedgraph
   in building it; the one write test was on the sandbox, with the user's go-ahead.
   - **The plan is a tree from the neuron outwards** (`mergePlan.ts`, `acceptedTree`), placed
     by `piecesOf` — the rule the search and the card use: fewest steps, then the lower parent
     id. So two pieces accepted on each other cannot hold each other up. **It grows from the
     neuron as it stands**: the reviewed root *and* every piece this workflow merged already,
     so a piece accepted on a merged piece is one step out and never waits for a piece that is
     still its own root. `merges` lists a piece after every piece between it and the neuron,
     whatever order the queue lists tips in.
   - **A merge's neuron end is looked for on the neuron and on the unmerged pieces between**
     (`AnchorPair.alsoNeuron`): the search measured the contact to all of them read as one
     object, so the voxel the candidate touches is on whichever is there. `Anchors.onRoot`
     says which, read back from the chunkedgraph with no alias; `PlannedMerge.needs` names it
     where it is a piece of this plan. Usually the piece it was accepted on (`parent`), not
     always. **Only the pieces on its own way count, never a piece beside it**: the first
     review round widened the side to every piece planned so far, and the second showed what
     that does — two pieces on neighbouring tips of the neuron merged onto each other, an
     edge nobody accepted. A merge point on any other root refuses that row (`neuron-absent`)
     and the piece's next row is tried; it does not fail the whole plan.
   - **A piece is refused where a piece on its way to the neuron is** (`parent-refused`), and
     no box is read for it. A piece this workflow merged already is part of the neuron's root:
     nothing to wait for, and the anchor is looked for on the neuron as it stands.
   - **The batch's check is unchanged, with one rule added** (`mergeBatch.ts`). The neuron end
     must be under the root the batch last made — which holds for a piece's child because the
     piece went first. A merge waits for both the piece its end is on (`needs`) and the piece
     it was accepted on (`parent`) — `waitsFor`, one spelling read by the batch and the
     dialog's ticks. Where one of those did not land, the merge is `not-sent` in
     those words and the batch goes on; read as it stands, that end would be "somebody else
     edited the neuron" and stop everything. `prepareMerges` refuses, before anything is
     sent, a merge whose piece is not confirmed before it.
   - **The dialog's ticks follow the tree** (`tickedWith`, `withoutOrphans`): unticking a
     piece unticks what was accepted beyond it, ticking one ticks the pieces before it, and a
     piece hidden in the viewer takes those beyond it along. What is ticked can be sent.
   - **The record** keeps the neuron as `reviewedRoot` on every entry, as before, and adds
     `parentRoot` (column `accepted_on`) where a merge was of a piece accepted on a piece.
     On a merge not sent because a piece it waits for did not land, `neuronRoot` is the root
     it *would* have been checked against — no check was made.
   - **The dialog's row says both** where they differ: `onto` the piece the end is on, `after`
     the piece it was accepted on.
   - **The sandbox script** reads with the batch's time limit, and does not undo an earlier
     merge from under one whose outcome is unknown — it says both may be standing instead.
   - **Submit is on again** for a neuron with extended pieces.
   - A piece of this neuron is no longer taken for "another neuron under review"
     (`joinsNeuron` reads the queue's seeds, not the roots its tips are on).

   **Checked, reads only**, on `fanc_sandbox` (table `mar2021_test`):
   - `pnpm probe:sandbox-pair -- --chain` lists three touching roots in a row, anchored the
     way the merges would be. In the box it reads: 819 chains, and for each one shown the
     second merge's neuron end lands on the middle piece.
   - `pnpm probe:cave-merge-chain` without `--i-asked` runs **the shipped `planMerges`** over a
     queue that says "A accepted on N, B accepted on A" and stops before the batch. For the
     chain proposed below: the plan merges A then B; B's `parent` and `needs` are A; the four
     supervoxels belong to N / A / A / B at the server's now.

   **The write test, run 2026-11-17 with the user's go-ahead** (`pnpm probe:cave-merge-chain
   -- … --i-asked …`): the shipped batch on that plan — A merged onto N (operation 106480),
   then B onto A (106481), the second checked against the root the first made — then both
   undone, last first (106482, 106483), the three pieces apart again at their old sizes
   (2 / 1 / 1 level-2 chunks). Four writes, all on the sandbox table. The chain was N
   `648518346496356483`, A `648518346511843775`, B `648518346500999958`; after the undos the
   same three pieces are `648518346472387337`, `648518346483097022`, `648518346517248810`.

   **First real batch (user, 2026-11-17, `wclee_aedes_brain`)**: 27 merges onto
   `648518347558097460` in 37 s, every one `merged`, six steps deep (8 pieces on the neuron,
   then 6, 5, 5, 2, 1). Read off the record: each merge was checked against the root the one
   before made, and every piece came after the piece it was accepted on. Read off the server
   afterwards: the last root, `648518347585551219`, is current, and all 51 supervoxels the
   merges named are under it.

   **Not checked yet**: the confirm dialog on a real tree in a browser (the on-demand workflow
   has no dataset wired into the review card, so Submit is off there); and the anchor search
   through an alias is covered by the sandbox reads above, not by a unit test — it needs a
   volume.
7. **Docs.** **Written 2026-11-17.**
   - **Suggest Merges has a help page** (`help/suggestMerges.md`; it had none), and its `guide`
     is cut to the two or three sentences the overlay prints above one.
   - **Review Suggestions' page** has a section on extending — the wire, the Extend button's
     states, how the tree list reads, changing your mind, `Auto-extend` — and one on submitting
     a neuron that was extended. Three places that said Merge Suggestions where the on-demand
     search was meant now say Suggest Merges.
   - **A help figure can draw the dotted wire** (`help/figures.ts`, recorded in `help.md`): both
     pages show `Extended` wired back into `Review`. Looked at in Chrome.
   - `core.md` had references and `rerunInput` from phases 1 and 2. CLAUDE.md has two rules
     under the scheduler and a short SEAM section.
   - **No example workflow** (user, 2026-11-17): the on-demand workflow is the user's own file,
     the pack ships none, and the two help figures show the wiring.

## Continuing through a small piece — tested, and not built (2026-11-16)

The ask: a candidate is sometimes a small flake that clearly goes on, and Extend on it finds
nothing. Ideally the search treats the neuron and the flake as one object and puts the end on
the far side of the flake.

**The outcome: neither change that was proposed is worth building.** The neuron and the flake
are already read as one object (`aliasOf`), and the ends the chain finds on a small true piece
do as well as an end made up from the segmentation, or better. The record is kept because the
proposal is the obvious one and will be made again.

### What was proposed

- **B — the consumed tips stop competing.** The tip the flake was accepted on, and the flake's
  joining end, are left out of the own-tip rule for the flake's ends: both are inside the
  neuron now, and a piece touching the flake nearer the old tip is dropped from the flake's
  list today.
- **C — a made-up end.** No mesh: read the segmentation box around the contact, take the
  flake's voxel farthest from the contact, and search there. For a piece that fits in the box,
  instead of the chain; and wherever the chain finds no open end.

### The test (`pnpm probe:seam-flake`)

Phase 0's ground: the neuron `648518347622603652` rewound to 2026-01-01, when it was 287 roots,
and an oracle that knows which of them belong. It started from the 33 true pieces of 9–200
chunks, searched up to 16 of each one's ends, and took every true piece of **at most 8 chunks**
an end listed as a case — the flake a reader would have accepted there, with the tip it was
accepted on and the contact. Cases found from a case are cases too. **96 cases**: 62 of 1–2
chunks, 34 of 3–8; 45 one step from a start, the rest up to five. Chrome, no assessor, reads
only.

For each case, the best place a true piece *not yet in the tree* takes on any of its lists:

| | Nothing to search | First | Within three | Anywhere |
| --- | --- | --- | --- | --- |
| **A** — today | 3 | 37 | 44 | 69 |
| **B** — A, consumed tips not competing | 3 | 34 | 44 | 70 |
| **C** — made-up end, old tip competing | 0 | 26 | 33 | 51 |
| **C** — made-up end, old tip not competing | 0 | 25 | 33 | 52 |
| A and C together (one more end a piece) | 0 | 39 | 47 | 71 |

Of 96 cases. And for the 62 pieces that **fit in the box**, which is where C was meant to
replace the chain: A 22 / 26 / 41, C 21 / 27 / 40, the two together 24 / 29 / 42.

- **Today's ends find a true piece first on 39% of small true pieces, and somewhere on 72%.**
  The rest include every flake that is the last of its chain, which no variant can score on.
- **B changes almost nothing, and what it changes is for the worse**: 2 cases better, 7 worse,
  87 the same. Its lists are longer and the true piece sits lower in them. The hole it was
  meant to close is real by the rule and does not cost anything measurable.
- **C is no better where it applies and much worse where it does not.** On the pieces that fit
  in the box it is level with A (9 cases better, 10 worse). On the 34 that do not — a piece of
  eight chunks can be a neurite many micrometres long — its end is on the box wall, not on an
  end, and it finds a true piece first in 4 where A does in 15.
- **Searching both is a small gain for one more end a piece**: 3 more cases within the first
  three, of 96. Of the 27 cases where A lists no true piece at all, C lists one in 2, never in
  the first three.
- **"Nothing to search" is rare on true pieces: 3 of 96**, all single chunks 0.4–1.2 µm long.
  C searched all three and listed 29–69 candidates, none of them a true piece — though three
  cases and a truth that is a lower bound say little.
- The chain costs a flake 1.4 s (median); the box read for C 0.27 s. So C is not slow; it is
  not better.

### What the first look got wrong

Before the test, fourteen flakes of 1–3 chunks were extended on the on-demand workflow's own
neuron (`648518347558097460`): 3 gave nothing to search, and for 7 of the other 11 both tips
lay within 0.7 µm of the contact, on meshes of 15–40 vertices. That read as "the chain's answer
on a flake is close to arbitrary".

**Those fourteen were the first two candidates of each end, taken whether they belonged or
not** — most of them are not pieces of the neuron at all. On pieces that do belong, the open
tip the chain finds sits a median 2.4 µm from the contact, and what is searched there is right
as often as the table says. A sample of what a search lists is not a sample of what a reader
accepts.

### What is left

- **The 3%.** A piece with no open end reads `nothing to search`. A made-up end there would
  give the reader a list to look at; nothing here says the list would hold the right piece.
  Not built. If it is asked for, it is C as a fallback only.
- **An example from real use.** The cases a reader meets — "clearly goes on, and Extend finds
  nothing" — were not found by this test at any rate that explains the complaint. A root id or
  two where it happens would say whether it is the 3%, a piece that is right and listed low,
  or something this ground does not hold.

## Phase 0 — results (2026-11-16, reads only)

`pnpm probe:seam-extend` (`scripts/probe-seam-extend.mjs`, truth from
`scripts/lib/seam_extend_truth.py`). Chrome, no assessor, one neuron.

**How it was measured.** The fixture neuron `648518347622603652` has 166 merges in its history.
Read at 2026-01-01, before 154 of them, it is 287 separate roots, median size 2 level-2 chunks.
Those roots are the truth: a candidate is right when it is one of them. An **oracle** stands in
for the reader — it accepts the best-ranked true piece within the first three of a tip's list,
then extends it. Each step ran the real chain (Meshes, Clean Meshes twice, Find Open Ends, then
sort on `e_tip` and keep twelve) on a private `Scheduler`, and the real `searchEnds` with the
path's roots read as the start's.

**It started from nine mid-sized true pieces** (27 to 496 chunks), not from the largest. The
largest rewound piece (2,704 chunks) gave 2,537 tips, took 150 s of chain, and its twelve best
ends listed nothing true — a poor seed for a test, since its few true neighbours are lost among
thousands of ends. Two starts were reached from another start's tree; each piece is counted once
below: 7 starts, 26 accepted pieces, down to four steps from a start.

| | Ends of a start | Ends of an accepted piece |
| --- | --- | --- |
| Ends searched | 80 | 86 |
| A true piece is first | 5 (6%) | 16 (19%) |
| … within the first three | 9 (11%) | 21 (24%) |
| … anywhere in the list | 26 (32%) | 31 (36%) |
| Where one is listed, it is first | 19% | **52%** |
| Where one is listed, it is in the first three | 35% | **68%** |

- **17 of the 26 accepted pieces led on** to a further true piece within the first three.
- **Extending from a piece is at least as good as from a start**, under the same truth. The low
  share of ends with anything true is expected: most ends of a correct piece are real ends. And
  the truth is a lower bound — a piece that belongs but was never merged reads as wrong.
- **No end of an accepted piece listed a piece already in its tree** (0 of 86).

**What a step costs**, by the piece's size (first time each piece was run):

| Level-2 chunks | Pieces | Chain above `Tips` | Tips found | Ends searched | Search |
| --- | --- | --- | --- | --- | --- |
| 1–2 | 13 | 1.5 s | 2 | 1 | 2.0 s |
| 3–8 | 7 | 1.4 s | 3 | 2 | 3.0 s |
| 9–40 | 8 | 1.9 s | 15 | 11 | 22.9 s |
| 41 and up | 5 | 5.9 s (21.3 s at 496) | 73 | 12 | 35.4 s |

Medians. An end costs 2.0–2.9 s to search, as `SECONDS_PER_END` says. For the 26 accepted
pieces together: 40 s of chain and 179 s of search. So a step on a typical fragment is a few
seconds, and the search, not the chain, is what a larger piece costs.

**The junction.** The piece's nearest tip sits a median 0.25 µm from the contact it was accepted
at; 23 of 26 pieces have one within 2 µm. Of the three that do not, two are larger pieces (19 and
39 chunks) where only twelve of the tips were kept, so the joining end may not have been among
them; the third is a two-chunk piece whose nearest tip is 2.2 µm away, and so was searched.
**6 of 26 pieces — every one a single chunk — have all their tips within 2 µm**, which is why the
rule in part 4 is now "the nearest one".

**What it also showed**

- **A private scheduler runs the chain**, 42 times in one session, old roots included, re-using
  its own cache for the dataset node and the geometry cache for a piece met twice (0.5 s against
  1.5 s). Phase 2 rests on this.
- **A rewound root has no nucleus row**, so Find Open Ends cannot mask its cell body. A probe
  concern only; a seed in real use has one.
- **A failed package download was silent.** Two runs in a row, the search's first call failed
  with "No module named 'pandas'" on every end. Pyodide's `loadPackage` reports a failed fetch to
  the console and resolves, and `callPython` kept the half-loaded module for the session. It came
  back the same afternoon, in the probe and in the app at once. **Fixed 2026-11-16**
  (`pyodide/loadPackages.ts`): one retry, then the reason, and nothing kept — see
  [python-pyodide.md](python-pyodide.md). Why the download fails was not found.

**Not measured:** the assessor's effect on the ranking (it re-orders the list, so "first" should
improve); Firefox; a second neuron. The truth is mostly one scripted batch of merges from January
2026, joining small fragments in chains — the case this plan is for, but not a proofreader's
hand-made merges.

## What will bite, quietly

- **An answer that depends on click order.** Anything that reads "the pieces accepted so far"
  rather than a piece's own path gives a different table after a reload.
- **`end_uid` read without its neuron.** Every piece has a tip 0.
- **A memory key missing one input.** A changed assessor served yesterday's ends looks like a
  very fast run.
- **`ID` is the piece, `seed` is the neuron.** A node below that groups on `ID` sees each piece as
  its own neuron.
- **`Sort` above Suggest Merges** already costs locality; with pieces it also decides which of a
  piece's ends make the cut, per piece.
- **A reference keyed too widely** re-runs the search on every click; keyed too narrowly, Extend
  does nothing. Both look like a slow or a stuck node, not like a key.

## Not in this plan

- **Published sets.** Two ways in, later: look the piece up in the same set, if the remote source
  covers fragments; or a published seed with in-browser continuations, which needs the mesh chain
  on the canvas and a way to join two sources in front of the card.
- **Roots at the server's now.** Pieces are searched under their own roots at the dataset's
  materialization, as the seed is. A Submit part way through does not stop further extending,
  since unmerged pieces keep their roots.
- **Starting automatically on accept**, and a cap on how many merges one Submit sends.
- **Extending on and on by SEAM's cutoff**: built later as Auto-extend, in
  [seam-auto-extend-plan.md](seam-auto-extend-plan.md).
