# Splits fed back to Review Suggestions — plan

Drafted 2026-11-24. A plan, not a record of what is built.

## The problem

Reviewing a neuron's suggestions in **Review Suggestions** (`seam:review`) often turns up a false
merge. It can be in the neuron itself, where a branch belongs to another cell, or in a candidate,
where the piece that continues the neuron has something else stuck to it. Either can be split
today: with Neuroglancer's own multicut in the Neuroglancer card, or with Coda's split gallery
(K, `splitSession.ts` → `splitAccept.ts` → `splitWrite.ts`).

Nothing tells the review card about the split. What the reader sees afterwards:

- **The neuron split.** Its root is replaced, so the card's currency check (`rootCurrency.ts`)
  marks it outdated within five minutes. Submit is then greyed out and the foot says to run the
  suggestions again. The tips on the part that was cut off are still listed. The workaround is
  `Ignore` ("the right continuation, but the neuron has a false merge"), one row at a time.
- **A candidate split.** Its row gets a red **outdated** tag and Submit leaves it out. The part
  that touches the tip, which is the piece the reader wanted, has a new root that the card has
  never heard of. If the candidate was extended, the tips of the cut-off part are still listed
  under it.

The goal: after a split, the card carries on with the neuron's new root, drops the tips that
left with the cut-off part, and moves a split candidate to the part that touches its tip. The
reader's verdicts are kept, and nothing has to be searched again.

## What already does most of this

- **The card already follows its neuron through its own merges.** Verdicts stay keyed on the root
  that was reviewed (`verdictKey(neuron, candidate)`). The merge record (`mergeRecord.ts`, the
  `merges` param) says what that root is now: `mergedSoFar(...).currentRoot`. The scene,
  `Current`, Submit's check (`mergePlan.ts`) and the counts all read that one function. A split
  is one more way for the root to move, so it belongs in the same record, read by the same
  function.
- **A piece already has a root "now" that is not its own id**: `MergedSoFar.joined` and
  `rootNow(joined, id)`, for pieces merged onto each other but not yet into the neuron. A
  candidate that was split needs the same thing: listed as X, now X1.
- **A split never changes a supervoxel.** The chunkedgraph cuts the links between supervoxels
  and leaves the supervoxels whole. So a supervoxel taken from the neuron at a tip before the
  split names the tip's side after it: its root now is either the kept part or the cut-off part.
  This is the whole design. One batched `rootsForSupervoxels` call (`rootIds.ts`) places every
  tip of a neuron.
- **Suggest Merges already reads the supervoxels around every tip** (`rootedBox.ts`, a box per
  end with each supervoxel's root at the search's moment). It knows the neuron's supervoxel
  nearest each tip, and both supervoxels at each candidate's contact. Today it keeps neither.
- **Submit already finds supervoxels at a contact at the server's now** (`mergeAnchors.ts`). A
  candidate moved to its new root merges by the same path, with no change.

## The design

### 1. Anchors: one supervoxel per tip, one per candidate

Suggest Merges publishes two new columns:

| Table | Column | What it is | Found |
|---|---|---|---|
| Tips | `tip_sv` | the neuron's supervoxel nearest the tip, at the search's moment; empty where none lies within 300 nm | in TypeScript, from the end's box before it goes to the worker (`searchOne`): the tip is known before the box is read |
| Candidates | `cand_sv` | the candidate's supervoxel nearest the neuron, its side of the contact | **already measured**: SEAM's vendored `summarize_cutout` returns it as `rep_svid` ("the supervoxel of its voxel closest to the query"), and Coda's Python wrapper already sent it back 64-bit. The TypeScript wrapper dropped it; it is now carried through the rank, the cut and the own-tip rule |

The neuron's side of a contact needs no column of its own. Every candidate is listed at a tip,
and that tip's `tip_sv` says which side of a split the tip is on. A candidate found on an accepted
piece is listed at one of the piece's tips, which has a `tip_sv` on the piece.

They are ids, so they are text (invariant 8). `tip_sv` costs a scan of the voxels near the tip,
about 0.1 ms (phase 0); `cand_sv` costs nothing. The scan is the one Submit's anchors use
(`nearestVoxels`, `rootedBox.ts`), so there is one copy of it. A hand pick (J, `handPicks.ts`) records
`cand_sv` too, since its check (`pickCheck.ts`) finds that supervoxel already.

A table without these columns (a published set from `seam:suggestions`, or a workflow saved
before this change) can still be followed. That costs a box read per tip at the search's moment
(`Searched at`), measured at 0.7 s each, or about two minutes for a 1,600-tip neuron read eight
at a time. See phase 5.

### 2. Following an edit: a second kind of record entry

The merge record gains a `followed` entry:

```
{ kind: 'followed', deployment, datastack, reviewedRoot,
  from: <root before>, to: <root after>, at: <ISO time>,
  how: 'split here' | 'edited elsewhere', operation?: <id> }
```

and, for a candidate, the same with `candidate: <id as suggested>` and the root it moved to.

`mergedSoFar` reads it: a `followed` entry moves `currentRoot` (the neuron) or adds to an alias
map, `moved`, like `joined` (a candidate). Every reader of the record then sees the new roots
without being changed: the scene, `Current`, the count on Submit, and Submit's own check, which
refuses a neuron whose recorded root is outdated. A followed root is current, so Submit works
again.

The record is not undoable, for the reason the header of `mergeRecord.ts` gives: it describes
the server, and Ctrl+Z cannot undo a split. Undoing the split (the gallery's Undo, or Neuroglancer's)
gives the neuron a new root holding both parts. The card follows that as well, and the tips come
back, because which tips are dropped is never stored (next section).

### 3. Which tips are dropped: worked out, never stored

A tip is on the neuron when its `tip_sv`'s root now is the neuron's root now (or a root in
`joined`). A piece's tip is on its piece by the same test against the piece's path: its
`tip_sv` can be the parent piece's supervoxel where the tip lies within 300 nm of the join,
since the search box reads the path as one object (`tipSupervoxelOf`). That close to the join
both are on the same side of any split, so the test must accept a root anywhere on the path. An asker built like `rootCurrency.ts` reads these roots: it gathers new tips for
`GATHER_MS`, asks in batches, and remembers the answers. Because the answer is worked out rather
than written down:

- tips that arrive after the split (Suggest Merges still running) are placed like the rest;
- undoing the split brings the dropped tips back;
- a reload asks once again, which is one request per neuron.

Dropped tips leave the list, the counts, `Layers` and Auto-extend. The foot gives one line, for
example "34 tips went with the part split off at 14:02", and the line opens a folded list of
them. Their verdicts are kept, as Start over and eviction keep the record. An accepted piece on a
dropped tip is no longer counted for Submit or shown in the confirm dialog, and every piece
extended beyond it goes too (`piecesOf`).

The search is not told. Its remaining tips on the cut-off part are searched and then not shown.
Telling it through the `Extended` reference would change that reference's key and start the run
again (`asReference`: the key is the hash of what it returns). This can be revisited if the
wasted search is measured and found to matter.

### 4. Which side is the neuron (user, 2026-11-24)

A split of the query neuron leaves two or more roots, and the card follows **the one holding the
most of the neuron's tips**, counted by their anchors. Where two parts hold the same number, it
follows the larger, by level-2 chunk count (`l2ChunkCounts`). The foot says which it followed
("followed 720575…12, the part holding 210 of 244 tips").

On 120 past Aedes splits the two rules picked the same part in all but six (phase 0, item 4).
Five of the six were small objects (under 30 level-2 chunks), which are not neurons under review.
The sixth was an almost even split of a large object: 227 and 260 chunks, holding 72 and 67 tips.
On a split that even, neither rule says much: where the other part holds at least four fifths
as many tips, the foot offers to follow it instead, in one click (user, 2026-11-24).

Every tip on the other parts leaves the list (section 3).

### 5. A split candidate: trimmed, not judged again (user, 2026-11-24)

Splitting a candidate **trims** it. The assumption is that its join to the neuron is right, and
that the false merge is further out, in the part that is cut off. So the card follows the part
that touches what the candidate joins: the query neuron, or the accepted piece it was found on.
That is the root now of the candidate's `cand_sv`, the supervoxel at its contact, and it becomes
X's alias (X → X1).

**The verdict carries over.** X's verdict, extension and Submit carry on under X, now meaning X1.
The row is tagged `trimmed` and the scene draws X1. The tips found on X (`neuronId` X), if it was
extended, are kept or dropped by their `tip_sv` against X1, as the neuron's are.

Where X is listed at more than one tip, the alias comes from the contact of the tip where X was
judged. A tip whose contact lies on a part that was cut off lists that part as a new, unjudged
candidate.

### 6. How the card learns of a split

Three ways. All of them lead to the same follow.

| How the split was made | How the card hears of it |
|---|---|
| Coda's split gallery (K) | `splitAccept.ts` announces the edit (`from`, `kept`, `taken`, operation) on a channel. Every open review card whose neuron, or one of whose candidates, is `from` follows it **at once**. |
| Neuroglancer's multicut in a Neuroglancer card (**the main case**) | The frame reports it (phase 0, item 3): the card's selection loses the old root and gains every root the split made. When a report drops a root the review card shows (its neuron, or a listed candidate), the card asks at once whether that root is still current. If it is not, the card follows it as it follows the gallery's. The new roots in the report are not used: the anchors say which is which. A root dropped because the reader hid it is still current, so nothing happens. |
| Anything else: a multicut the frame did not report, or somebody else's edit | The currency check finds the root outdated, as today. The red **outdated** tag on the candidate's row, and the outdated line in the foot for the neuron, become buttons: pressing one follows that edit. |

The currency check believes "current" for five minutes (`CURRENT_FOR_MS`), so an unreported
multicut could take that long to show its tag. The row being looked at, and the neuron, are
checked again whenever the reader clicks a row. That is one small request, and it means the tag
is there by the time the reader looks for it.

A merge somebody else made is followed by the same path. Every tip stays (all anchors map to the
new root), and a candidate that is now part of the neuron reads `in this neuron`, as it does after
a merge made from the card.

A follow is refused while a Submit is out, or while the record has a merge whose answer was lost
(`MergedSoFar.unsettled`). The roots are not known until that merge is settled.

### What does not change

- **No new writer.** The review card still writes nothing to a chunkedgraph. A follow is reads
  only, and the split write stays on its one chain (`CHAINS` in `importGraph.test.ts`). The
  channel the gallery announces on carries a result, not a way to write.
- **Verdict keys.** Verdicts are still keyed on the reviewed root and the candidate as suggested.
  Nothing is re-keyed. The record says what each root is now.
- **The search's moment.** Suggest Merges still reads the neuron at its `Searched at`. The new
  end that a split leaves at the cut is not searched. Searching it is a later step (below).

## Phases

**Phase 0: measurements (done 2026-11-24, reads only)**

1. **The anchors are in hand during the search, and finding them costs almost nothing.** Each end's
   box (`end.box()` in `searchOne`) carries every supervoxel and its root at the search's moment.
   The box is handed to the Python worker and detached there, so `tip_sv` has to be found before
   that and `cand_sv` inside the wrapper (section 1). Tried on Aedes's published sets: for each of
   2,634 tips on the three neurons edited since (rv2's two, rv4's one), a box of 400 nm around the
   tip at the set's moment (base scale, 16 × 16 × 45 nm), then the neuron's voxel nearest the tip.
   Every tip found one, at a median of 14–17 nm from the tip and never more than 58 nm. The scan took a median of 0.07–0.12
   ms a tip, at most 2.6 ms. A contact's scan reaches further (up to 750 nm) but on the search's
   coarser scale, so it should be about the same cost. That is an estimate from these numbers, to
   be measured once phase 1 is built. Either way it is nothing beside the ~3 s an end costs now.
   The box read, which the search does anyway, took a median of 0.66–0.70 s a tip. That is what
   phase 5 pays for a table without anchors: 137 s for a 1,581-tip neuron, eight at a time.
2. **One root lookup places a whole neuron's tips.** All of a neuron's anchors at the server's now,
   in one `supervoxelRoots` call: 1,581 supervoxels in 374 ms, about 500 in 240–263 ms, 5 in
   127–151 ms. Each of the three neurons edited since the sets were made had kept every tip on one
   new root, so those edits were merges or tip-free trims, and nothing would have been dropped.
3. **Neuroglancer's multicut is reported to the card, so no sandbox write was needed.** Read from
   the vendored Spelunker build (`vendor/neuroglancer.tgz`, `datasource/graphene/frontend.js`,
   `submitMulticut`): on success it deletes the old root from the layer's selected segments and
   adds every root the split made (`splitRoots`), then calls `replaceSegments` on the state. Coda's
   frame (`src/ngframe/main.ts`) posts the layers' state to the card on every state change,
   whoever made it. So the card's next report has the old root gone and the new ones in. That
   report is the trigger in section 6. It should still be seen once live, on `fanc_sandbox`, when
   phase 3 is tried by hand (asked first).
4. **"Most tips" and "larger" almost always agree.** The neuron in `docs/find-path-plan.md` is on
   Aedes, not a sandbox copy, so 120 past Aedes splits were used instead (`operation_details`,
   ids drawn at random, splits that went through). For each, the root before it and the two roots
   it made, read with the same `splitOperation.mjs` steps the split gallery's probes use. Tips were
   counted as the old root's level-2 leaves, a stand-in for the skeleton's tips. Sizes were each
   new root's level-2 chunk count. The two rules picked the same part in 112 of 120; with ties in
   tips settled by size, as section 4 says, in 114. Where the smaller part had 50 chunks or more,
   they agreed in 20 of 21. The one exception was the near-even split in section 4.

**Phase 1: anchors (built 2026-11-24).** `tip_sv` on `Tips` and `cand_sv` on `Candidates`
(`searchTips.ts`, one field list for schema and value). `CandidatePool.repSupervoxel` carries
`rep_svid` through `rankPool` and `gather` beside `candRoot`; `SearchedEnd.tipSupervoxel` is
found in `searchOne` from the end's box just before the worker takes it
(`TIP_ANCHOR_REACH_NM`, 300 nm). The end memory charges the new array. A hand pick keeps both
supervoxels its check found, as the tenth and eleventh elements of its stored row:
`HandPick.candSv`, the picked piece's side, and `HandPick.tipSv`, the neuron's (or its piece's)
side — the `tip_sv` of a pick listed as a tip of its own. A pick saved before reads without
them. The export emitters for `seamReview` list no columns, so nothing changed
there. Nothing reads the columns yet: the review queue starts reading them in phase 2. Not yet
seen live: a run in the app, to check `tip_sv` is filled on real ends and `cand_sv` matches the
candidate's root at the search's moment.

**Phase 2: follow the neuron (built 2026-11-24).** A follow is a `FollowEntry` in the merge
record (`mergeRecord.ts`): `from`, `to`, the tip supervoxels found on another part (`away`), every
tip supervoxel asked about (`placed`), how many were kept, the other parts with their tip counts (`others`), and the
merged pieces that went with them (`left`). `mergedSoFar` reads it: `Groups` moves the neuron's
group to `to`, as a merge's new root, so the scene, `Current`, Submit's check and the merges made
afterwards all build on it; `followed` is the last follow, and `left` its lost pieces, out of
`pieces`. Like `away`, `left` is the last follow's: every follow places all merged pieces again.
A followed neuron's record is never shortened (`shortenedRecord`): a later follow places its
merged pieces by the supervoxels only their full entries hold. Follows are replayed with the merges, and is no row of
`Merges` (`mergeEntries`).

**Which tips leave is stored, not asked at every render** — a change from section 3. `evaluate`
cannot fetch, and `Layers` and Submit's plan have to agree with the card's list, so all three
read one function over the record: `cutOffTips` (`followEdit.ts`, dropped by `withoutTips`, as
`unreachedTips` is) takes the neuron's tips and
its merged pieces' tips whose `tip_sv` is in the last follow's `away`, then the tips of every
piece no longer reached through accepted pieces once those are gone (`piecesOf` over the
accepted pairs, as `unreachedTips` reads it — one derivation of where a piece sits). A later follow replaces the
earlier one's `away`, so following an undone split gives the tips back. What is lost: tips
searched after a follow are not placed until the reader presses **place N new tips** (a follow
to the same root; the tips counted are those not in the last follow's `placed`). A follow is
refused while a merge's answer is lost, since it moves the root the plan settles that merge by,
and a chosen part that holds none of the tips now is refused rather than emptying the list.

A merged piece a follow lost (`left`) is `mergedAs` **`split`**: drawn as no part of the neuron,
not counted for Submit, refused by the plan as `split-off`, and its tips leave with it whatever
their supervoxels say. The walk for what is still reached starts from the neuron and the pieces
still merged into it, as the plan's `acceptedTree` does. A part followed away from while it
stands leaves `roots`, so a search can offer it, and Submit merge it, back. Another neuron's
follow takes its lost pieces out of this one's `elsewhere`. Merged pieces the record keeps only
short (a neuron shortened before its first follow) cannot be placed; the notice says how many.

The reads are `followEdit` (one `supervoxelRoots` call at the server's now for every tip and
merged piece, plus `l2ChunkCounts` only at a tie), started from the card's foot: **Follow the
edit** beside the outdated note, **follow the other part instead** where `nearEvenOf` finds
another part with ≥ 4/5 the tips, and **place N new tips**. The entry is appended through
`holdForWrite`, as Submit appends, so it is refused while a batch holds the card. Not built here:
the folded list of dropped tips (the foot gives the count); making the candidate's **outdated**
tag a button (phase 4). A cut-off extended piece stays in the extend plan, so the search still
searches it and the foot's "N pieces extended" still counts it, until the reader rejects it or
stops extending it; re-deriving the plan from what a follow leaves would tell the search, which
section 3 decided against. Not yet seen live: a follow of a real split; that comes with phase 3's
sandbox split, asked first.

**Phase 3: the gallery announces (built 2026-11-24).** `data/cave/rootEdits.ts` (on `channel()`)
is a headless channel of
"these roots were replaced", certain or suggested, which carries a result and no way to write.
The split gallery says its write's and its Undo's retired roots, certain (`splitAccept.ts`'s
`edited`, beside the card's `showInCard`). A Neuroglancer card that can split says, as suggested,
the roots a frame report took out of its layer *while adding others*, which is what
Neuroglancer's multicut does (`submitMulticut`, phase 0). A neuron only taken out is the reader's
choice and is not said, nor is a pasted link; a scene's replacement is said once. A review card
whose neuron is among the roots follows at once where the edit is certain, or where the neuron is
already known to be outdated. A certain edit said while a follow is under way (an Undo pressed
straight after the split) is kept and followed once the record shows the new root. Where it is
suggested, and the reader is signed in, the card asks for an answer to a question sent from now
on (`rootCurrency.askAfter`: an age of 0, and once more after a question already out) and
follows if that answer is outdated within `SUGGESTED_WAIT_MS` (60 s). A card whose neuron was
merged into another reviewed neuron follows nothing by itself. A follow is written only where
the record still has the neuron at the follow's `from` (the card can be drawn twice, and both
copies hear the edit). Answers are stamped with when their question was sent. The neuron and the
candidate in view are asked about again on each row moved to, where their answer is over 20 s
old (`RECHECK_ROW_MS`); a merged candidate is not asked. The card the gallery was pressed over
keeps both parts in its selection (`replaceSegments`), so the reader sees what went. That card
is often the review card's `Current` viewer, and the parts stay until the reader takes them out.
Not yet seen live: a gallery split and a multicut on `fanc_sandbox`, each asked of the user.

**Phase 4: follow a candidate.** Aliases in the record, the `trimmed` tag, the verdict carried
over, and a candidate's extended tips dropped by the same rule.

**Phase 5 (optional): sets without anchors.** Anchors found by a box read at the search's moment,
for published sets and older workflows. It shows progress, because it can take a minute on a
large neuron.

**Later, not planned here:** searching the new end a split leaves; telling SEAM's verdict log
that a candidate held a false merge; stopping the search on dropped tips, if phase 2 shows the
time wasted matters.

Review: every phase gets the usual /simplify and /code-review rounds. None of them writes to a
server, but phases 2 to 4 change what Submit is given, so they get the second /code-review round
that write code gets (`docs/seam-merge-plan.md`).

## What will bite, quietly

- **A merged piece on the cut-off part.** The record says it is in the neuron
  (`MergedSoFar.pieces`), but after the split it is in the other root. Its anchor says so, and the
  record's reading has to take the follow into account, or the card shows `✓ merged` for a piece
  that has left.
- **Two splits in a row.** The second follow starts from the first follow's root, not the
  reviewed one. `from` must be the root now, the same rule `mergedSoFar` applies to merges.
- **Sandbox and production share roots** until one of them is edited. A follow is read only for
  its own datastack, as merges are (`RecordScope`).
- **Eviction.** Shortened record entries (`ShortEntry`) must keep the follows, or an old neuron
  reloads on its pre-split root. A follow is small, so it is kept whole.
- **A tip whose anchor has no root** (`0`, a supervoxel the graph does not list) is kept, not
  dropped, and counted. Dropping it would hide a tip without anything to show it was cut off.

## Decisions

Settled (user, 2026-11-24; 4 on 2026-11-24 after phase 0):

1. **The query neuron** keeps the part with the most tips, then the larger part (section 4). Tips
   on the parts cut off leave the list.
2. **A candidate** keeps the part joined to the neuron or to the accepted piece it was found on,
   and its verdict carries over (section 5).

3. **An edit Coda did not see made** is followed by pressing its **outdated** tag. That covers
   the reader's own multicut when the frame does not report it, and the rarer case of somebody
   else editing the same cell (few people edit these datasets). The reader's own multicut is the
   main target: where the frame reports it, it is followed at once (section 6).

4. **A near-even split of the query neuron** (phase 0, item 4: one in 21 splits with both parts
   large). The card follows the part with more tips as usual; when the other part holds at least
   four fifths as many, the foot offers **follow the other part instead** in one click.
