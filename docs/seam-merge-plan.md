# Submitting reviewed merges to CAVE — plan

Status: **all phases built** (2026-11-16); the sandbox merge test passed, and **the first Aedes merge
was made through the card** by the user (below). Docs: the node's help (`packs/seam/help/review.md`),
[backends-cave.md](backends-cave.md)'s writing section, and a rule in CLAUDE.md.
The first feature in Coda that writes to a segmentation. Everything below is ordered by what could
go wrong on a shared production server.

## The workflow

1. Suggestions arrive — published (`seam:suggestions`, "Merge Suggestions") or computed in the
   browser (`seam:suggestMerges`, "Suggest Merges").
2. The reader reviews one neuron in `seam:review` ("Review Suggestions"), accepting candidates.
3. The reader presses **Submit**; Coda checks every accepted merge, shows the list, and on
   confirmation performs the merges on the chunkedgraph, one at a time.

## Decisions (user, 2026-11-15)

| Question | Decision |
| --- | --- |
| Route | **Coda calls the chunkedgraph API itself**, with the reader's own CAVE token. Not Spelunker's merge queue. |
| What one Submit sends | **The picked neuron's accepted candidates.** A dialog lists every merge and every check result; nothing is sent until the reader confirms there. |
| A merge fails partway | **Stop the batch.** Report what was done and what was not; nothing more is written until the reader presses Submit again. |
| The neuron's root is outdated | **Reject all of that neuron's merges**; the suggestions need re-running on the new root. An outdated candidate is rejected on its own; the rest go ahead. |
| Which datastacks | **Any CAVE datastack**; whether the reader may edit is the server's decision (and is asked of it read-only first — see pre-flight). |
| Afterwards | **Record each merge** with the workflow (never sent twice), **a `Merges` output table**, and **the viewer shows the new root**. No Undo button for now. |
| Live testing | **`fanc_sandbox` only** (was `flywire_fafb_sandbox`; changed after phase 0 found undo refused there). Claude proposes a pair found with read-only queries; the user approves that exact pair; the test **undoes its own merge**. **Every run that writes is asked about first, every time.** |

## Decided before phase 2 (user, 2026-11-16)

- **Supervoxels, not root ids.** Both established clients send supervoxels: Spelunker's merge
  body carries `segmentId`, the supervoxel under the mouse (`baseValue`; "The selected supervoxel
  is of an unselected segment"), and caveclient's `do_merge` takes "a list of supervoxels". With a
  supervoxel the server merges exactly the piece Coda chose and checked; with a root it would pick
  one itself, at the root's creation time, so an outdated root would merge silently. **The server
  does not check currency for a supervoxel either** — a layer-1 id is taken as given — so the
  latest-root guarantee is Coda's own per-merge re-check (phase 5), as it is Spelunker's; the window
  between that check and the server's lock is not closed by any client. What the server does add:
  it refuses to merge two supervoxels already under one root (`allow_same_segment_merge=False` →
  400), so a merge re-sent after an unknown outcome is refused, not applied twice. The root-id
  attempt is dropped from the sandbox probe, and phase 1's anchors stay.
- **`priority=True`**, as Spelunker sends it by omission: a reviewer merging one neuron wants the
  merged mesh soon. The cost is that a batch of merges all goes into the shared fast remesh queue.
- **The sandbox probe (phase 7) runs right after phase 2**, as a check of the writer alone against
  a real 2.20.0 server — request shape, reply and error parsing, the operation id, undo — before
  phases 3–6 are built on it. The pair is proposed from read-only queries and approved first.

## What a merge is, read off the code rather than recalled

- **The request.** `POST {cg}/segmentation/api/v1/table/{table}/merge?int64_as_str=1&priority=False`
  with body `[[sv_a, x_nm, y_nm, z_nm], [sv_b, x_nm, y_nm, z_nm]]`. Positions are **nanometres**:
  caveclient 8.2.1's `do_merge` multiplies its coordinates by `resolution` before sending, and the
  vendored Spelunker sends `selectionInNanometers`. caveclient adds `priority=False`; Spelunker
  does not.
- **The reply** carries `operation_id`, `new_root_ids` and `new_lvl2_ids`
  (pychunkedgraph `handle_merge`). `operation_id` is what `undo` takes.
- **What the server checks** (pychunkedgraph `handle_merge` / `handle_supervoxel_id_lookup`):
  - exactly two points;
  - each coordinate is mapped to a supervoxel *within the id sent with it*, searching outward at
    4, 8, 14 and 28 × the mean voxel size — failure is `400 … Lookup stage`;
  - the two supervoxels' **chunks** are at most 3 apart (Chebyshev), else `400`;
  - no same-segment check in the handler itself; `allow_same_segment_merge=False` is passed on.
- **Undo** exists: `POST …/table/{table}/undo` with an operation id (caveclient `undo_operation`).

### What our tables do not carry

A candidate row has the neuron's root, the candidate's root and **one contact point in nm**. It
has **no supervoxel on either side**. So between "accepted" and "merge" there is a lookup Coda must
do: which supervoxel of the neuron, and which of the candidate, sit at that contact. Coda already
has the parts: `openSearchVolume` / `labelledBox` read a box of supervoxels from the watershed
bucket, and `rootsAtInstant` maps supervoxels to roots at a moment.

### Root ids in place of supervoxels — the server accepts them, and does not check they are current

Read off pychunkedgraph `main` (`chunkedgraph.py` `get_atomic_ids_from_coords`,
`utils/id_helpers.py`), not tested:

- The id sent with each point may be at **any layer**, a root included. The server reads the
  supervoxels within `max_dist_nm` (150 nm by default) of the point, maps each to its ancestor at
  the id's layer, keeps the voxels that match, and picks the **nearest** one's supervoxel. Nothing
  within reach is `None` → `400 … Lookup stage`, and nothing is written.
- **The mapping is done at the id's own creation time** (`parent_ts`; the comment says "Enable
  search with old parent by using its timestamp"). So **an outdated root is accepted**: the server
  finds the supervoxels that root *used to* hold and merges them into whatever they belong to now.
  The server is no guard against stale ids, which makes Coda's own latest-root check the **only**
  one. The plan already has it on both ends of every merge; this is why it cannot be dropped.
- This is `main`; phase 0 re-read it at both servers' exact versions and found the same.

**What it would buy:** sending roots plus the contact point lets the server find the supervoxels,
which would replace phase 1's box read with nothing. The per-merge checks then run on roots alone:
before each merge, `is_latest_roots` on the neuron's expected root and the candidate's root. "Already
merged" becomes a lineage question (the candidate's latest root is the neuron's current one —
`get_latest_roots`), not a supervoxel lookup. The cost is that the server, not Coda, picks the
voxels, within 150 nm of the contact, and a contact further than that from either piece is a
refusal rather than a merge — a safe failure.

**Decided 2026-11-16: not used.** See "Decided before phase 2" — Coda sends supervoxels, as both
reference clients do.

## The one subtle part: "latest" changes under our own feet

A neuron's first merge gives it a **new root id**. A naive is-latest check before the second merge
would find the reviewed root outdated and reject every remaining merge on that neuron.

So "current" is defined per batch:

- **Before the batch**, every root is checked with `is_latest_roots` at *now* (no cache — the
  existing `staleRoots` path caches at a materialization, which is the wrong question here). The
  neuron's root must be latest, or the whole neuron is rejected. Each candidate's root must be
  latest, or that candidate is rejected.
- **Before each merge**, the two anchor supervoxels are mapped to their roots at *now*:
  - the neuron's supervoxel must map to **the root this batch last produced** (the reviewed root
    before the first merge, then each merge's `new_root_ids[0]`). Anything else means somebody
    else edited the neuron mid-batch — **stop**.
  - the candidate's supervoxel must map to **the candidate's reviewed root**. If it maps to the
    neuron's current root, the piece is already part of the neuron (merged by an earlier merge in
    this batch, or by somebody else) — record as `already merged`, send nothing, continue.
    Anything else — **reject** that candidate.

This is what makes "an outdated root is never merged" true for the whole batch, not only at its
start.

## Phases

**Review order for the write path** (user, 2026-11-16): any new script, new code, or substantial
change to existing code that writes to a server goes through one `/simplify` and then one
`/code-review medium`, and a second `/code-review medium` if the first finds something big. That
covers phases 2, 5, 6 and 7 here. It is on top of asking before every live write.

Each phase lands on its own and is reviewable before the next depends on it. Nothing in phases 1–4
can write: the write is phase 5, and it is unreachable until phase 6 wires the button.

### Phase 0 — read-only checks (no writes)

- Read pychunkedgraph's `get_atomic_ids_from_coords` to settle the root-id question above.
- Find how CAVE says whether a user may edit a datastack, read-only (the auth service's user
  permissions — `permissions_v2` per dataset). That becomes the pre-flight's permission line, so a
  reader without edit rights is told before confirming rather than by a 403 on the first merge.
- Confirm `is_latest_roots` with no `timestamp` answers "at now" on the Aedes chunkedgraph.
- **Read both servers' chunkedgraph versions** (`GET {cg}/segmentation/api/version`, the endpoint
  caveclient's `server_version` reads) and record them here. **FlyWire runs an older
  chunkedgraph than Aedes** (user, 2026-11-15). The merge contract is expected to be the same, but
  the sandbox test proves FlyWire's version, not Aedes'. Where the two differ, check the
  pychunkedgraph source at *each* version for `handle_merge`, the lookup radii and the 3-chunk
  limit, rather than assuming main's. If something behaves differently on one of them, the version
  gap is the first thing to suspect.

### Phase 0 — results (2026-11-15, reads only)

Measured with caveclient 8.2.1 and the user's own token (GETs, plus `is_latest_roots`, which is a
read); server code read at the **exact tags** each server runs, not `main`.

| | Aedes (`wclee_aedes_brain`) | FlyWire sandbox (`flywire_fafb_sandbox`, no longer the test bed) |
| --- | --- | --- |
| Chunkedgraph | `https://cave.fanc-fly.com/segmentation/table/wclee_aedes_brain` | `https://prodv1.flywire-daf.com/segmentation/1.0/fly_v26` |
| Server version (`GET {cg}/segmentation/api/version`) | **2.20.0** | **1.27.0** |
| Table | `wclee_aedes_brain` | `fly_v26` |
| Voxel size (viewer) | 16 × 16 × 45 nm | 4 × 4 × 40 nm |
| Permission dataset | `wclee_aedes_brain` | `fafb_sandbox` |
| User may edit | yes | yes |
| Lookup radii for a merge point | 4, 8, 14, 28 × mean voxel ≈ 103, 205, 359, 719 nm | 75, 150, 250, 500 nm |
| Chunk limit between the two points | 3 (query arg `chebyshev_distance`, default 3) | 3, fixed |
| Merge reply | `{operation_id, new_root_ids}` | same |
| **Undo** | supported | **refused for `fly_v26`** ("Undo not supported for this chunkedgraph table") |

**The test bed is `fanc_sandbox`, not the FlyWire sandbox** (user, 2026-11-15, after the undo
finding). Read the same way: graphene `https://cave.fanc-fly.com/segmentation/table/mar2021_test`,
chunkedgraph **2.20.0** — the same host and version as Aedes, so a sandbox pass says something
about Aedes, which FlyWire's 1.27.0 could not. Table `mar2021_test`, permission dataset
`FANC_sandbox` (user may edit, no outstanding terms of service), viewer voxel 4.3 × 4.3 × 45 nm.
Undo has no table exclusion in 2.20.0.

**The cost of that: the sandbox and production Aedes share a host.** A guard that checks the host,
or a datastack name that could be mistyped, does not separate them. The probe's guard is on the
**table** — it refuses anything but `mar2021_test`, checked against the URL it is about to POST to,
not against a name it was given.

- **The edit permission check** is two reads: `GET {auth}/auth/api/v1/service/pychunkedgraph/table/{table}/dataset`
  names the permission dataset (it is *not* the datastack's `aligned_volume`: the sandbox's is
  `fafb_seung_alignment_v0`, its permission dataset `fafb_sandbox`), and
  `GET {auth}/auth/api/v1/user/cache` → `permissions_v2[dataset]` must include `edit`. The same
  reply carries `missing_tos`, which should be part of the check.
- **`is_latest_roots` with no `timestamp` answers at now.** caveclient sends no timestamp at all
  when none is given. On Aedes, an earlier root of the fixture neuron (`648518347617239041`, one of
  682) is `False` with no timestamp and `True` one second after it was created; the current root is
  `False` at that same moment. The fixture neuron `648518347622603652` is still latest today.
- **Root ids in place of supervoxels: accepted by both versions, and stale ones too.** Both
  `get_atomic_ids_from_coords` accept a parent "at any layer" and map the neighbourhood's
  supervoxels at the **parent's creation time**. So both servers would merge an outdated root's
  former supervoxels without complaint, and Coda's latest-root check is the only guard on either.
- **The merge contract is the same in both versions**: same body, nm positions divided by the
  segmentation resolution and truncated to voxels, the same supervoxel lookup, the same 3-chunk
  rule, the same reply. 1.27.0 has no `remesh` or `chebyshev_distance` arguments.
- **`merge_admin`** (2.20.0) allows merging a segment with itself. Coda must never call it.

### Phase 1 — anchors. **Built 2026-11-16** (read-only)

`src/packs/seam/mergeAnchors.ts`. The chunkedgraph's id layout is `src/data/cave/graphLayout.ts`
and the server's merge rules (`MergeEnd`, `MAX_MERGE_CHUNKS`, `mergeChunkDistance`) are
`src/data/cave/merge.ts`, where the phase 2 writer can use them without importing from a pack.
The volume is found by `findSupervoxels` (`src/data/cave/volumes.ts`), shared with the
candidate search, which fetches the chunkedgraph `info` once for both the bucket and the layout;
boxes are read through `labelledBox` (`src/packs/seam/rootedBox.ts`, shared with the search), so
one pre-flight's anchors share a chunk cache and a supervoxel → root map at one instant.

For one accepted pair: read a box around the contact at the **chunkedgraph's base scale**
(`graph.cv_mip` — 16 nm on Aedes, not the search's 32), ask each supervoxel's root **at now**, and
take, for each of the two roots, its voxel nearest the contact in nanometres (anisotropic), within
half the search's `min_dist_um` plus 500 nm (1.5 µm where the row has no gap, 2 µm at most — the
ceiling checked before a box is allocated: 5.6 M voxels at 16 nm). The base scale is chosen **by
its resolution** from the chunkedgraph's own `info`, never by `cv_mip` as a position in the
bucket's parsed scale list, which skips encodings Coda cannot read. SEAM's
contact is the midpoint of the two pieces' nearest voxels (`seam/cutout.py`), which is why half
the gap is the right reach. Output: two `(supervoxel, position nm)` pairs, or a refusal:

- `neuron-absent` / `candidate-absent` — no voxel of that root, at now, within reach. An edited
  neuron or candidate lands here, so the anchors are a second latest-root check beside
  `is_latest_roots`;
- `too-far` — the two supervoxels' chunks, **decoded from their ids** by pychunkedgraph's own
  formula (v2.20.0 `chunks/utils.py`), are more than 3 apart. A supervoxel that does not decode
  as layer 1 **throws** instead: it came out of the graph's own watershed, so the layout and the
  volume disagree, which is true of every pair and is not a fact about this one;
- `same-root`, `bad-id` (root `0`, or past 64 bits), `no-contact` (a missing coordinate is
  undefined in the review queue, never the origin), `bad-gap` (negative or infinite),
  `gap-too-wide` (half the gap beyond the 2 µm ceiling), `outside-volume` — refused before
  anything is read.

A **throw** is about the datastack, not the pair — a failed request, a short `roots_binary` reply,
a supervoxel that does not decode as layer 1 — and stops the whole pre-flight.

Label 0 (background) is answered as root 0 inside `rootsAtInstant` and never sent, so the anchor
tests the root alone.

Positions are voxel **centres**, which the server's `trunc(nm / resolution)` maps back onto the
chosen voxel.

**Changed from the plan above: `already merged` is not an anchor answer.** At now, a candidate
merged into the neuron has no supervoxels under its old root, so the anchor can only say
`candidate-absent`; telling "merged into us" from "edited by someone" needs the candidate's
lineage. That moves to phase 3, which already asks `is_latest_roots` about every candidate: a
candidate that is not latest is looked up with `get_latest_roots`, and if its latest root is the
neuron's current one it is `already merged`.

**Measured on live Aedes** (`pnpm probe:merge-anchors`, reads only): all **25** rank-1 rows of
`__fixtures__/candidates.parquet` (5 neurons) anchored. Every chosen supervoxel's root, asked again
separately, was the root it was chosen for; every position truncates back onto its voxel; every
pair was 0 chunks apart. Gaps came out at 16–23 nm, one base voxel, where the search had reported
32 nm at its coarser scale — the pieces touch; two rows had real gaps (78 and 288 nm, the search
having said 132 and 320) and anchored too. 0.4–1.5 s per anchor and 1.7 s to open the volume as
first built; after the review pass's shared chunk cache and single `info` fetch, 0.16–1.0 s per
anchor and 0.9 s to open. None of the five neurons had been edited since the 2026-11-04 snapshot.

### Phase 2 — the writer (`src/data/cave/edits.ts`). **Built 2026-11-16** (no live writes)

The only module in Coda allowed to write to a chunkedgraph.

- `confirmMerge(graphene, neuron, candidate)` → `ConfirmedMerge`; `mergeSupervoxels(merge,
  {deployment, token?})` → `EditOutcome`; `undoMerge(done, …)` for the probe — it takes the `done`
  outcome a merge returned, never an operation id, so it undoes only this session's own merge,
  on that merge's table, once.
- **The request** is Spelunker's: `merge?int64_as_str=1&priority=True`, body
  `[["sv",x,y,z],["sv",x,y,z]]` with the ids as JSON strings (the server reads them through
  `np.array(…, dtype=np.uint64)`, which takes text exactly — checked). Undo is caveclient's:
  `undo?int64_as_str=1`, `{"operation_id": n}` with the id spliced as digits.
- **Three outcomes.** `done` (operation id, new roots); `refused` for **400, 401, 403, 404 only** —
  read off v2.20.0: every `PreconditionError`, "Supervoxels must belong to different objects."
  among them, is raised in `_apply`, before `_write` persists anything; auth refuses before the
  handler; 404 is no such table. `unknown` for everything else — a 5xx, a proxy's 408/409/429 (it
  may have passed the request on), an unreachable host, a redirect, or a success whose reply
  cannot be read — and the caller re-reads roots.
- **Redirects are not followed** (`cavePostWrite`, `redirect: 'error'`): `fetch` would re-send a
  write's body on a 307/308 to a host nobody confirmed.
  Error text is the server's own `message` (`{"code","message"}`, pychunkedgraph `api_exception`).
  A 403's sentence now names the permission the body asks for (`required_permission`, so "not
  permitted to edit"), where it said "read" for everything.
- **Never retried, never cancelled once sent.** There is no `signal`: aborting a sent POST does not
  stop the server, it only discards the answer. Options are rebuilt field by field, so a signal or
  `quiet` on the caller's object does not ride along.
- **Guarded by type and at run time**: `ConfirmedMerge` is branded, frozen, copied from the
  caller's objects, and registered in a `WeakSet`; `mergeSupervoxels` removes it before the request,
  so a cast or a copy is refused, and **one confirmation sends once** — a caller that catches and
  loops has to go back to the reader. `confirmMerge` throws for a chunkedgraph not on `https`
  (the write and the token would go in the clear), for ids that are not chunkedgraph ids
  (`isNodeId` in `graphLayout.ts`, shared with the anchors; it rests on `isSegmentId`, which now
  refuses past 2⁶⁴ − 1 as neuroglancer's `parseUint64` does), non-finite positions, and one
  supervoxel on both sides.
- **Guarded by the import graph**: `importGraph.test.ts`' `MAY_WRITE` lists the modules allowed a
  value import of `edits.ts` — empty until phase 5's submit module. The shared walker
  (`test/importGraph.ts`) now follows the `@/` alias, `.js` specifiers and a comment inside
  `import(…)`, which every boundary test had been blind to; and a comment-stripped text search for
  any string literal naming `…/edits` catches what the walk still cannot read. Tests are not walked; the probe
  will import it from `scripts/`.
- **Unit tests use a stubbed `fetch` only**, and `src/test/writeGuard.ts` (installed by
  `setup.ts`) refuses and records any unstubbed request to a chunkedgraph route that writes —
  `merge`, `merge_admin`, `split`, `undo`, `redo`, `rollback_user`, read off `routes.py` — and fails
  the test (after each test and after the file, for a write nobody awaited). Each guard was checked
  by breaking it and seeing its test fail. **Not covered:** a live read test whose server
  redirects it *onto* an edit route — the guard sees only the URL asked for.
- **Review:** /simplify, then /code-review medium twice (the first found big items: proxy 4xx read
  as refused, redirects followed, an unguarded undo). `isSegmentId` now refuses past 2⁶⁴ − 1, as
  neuroglancer's `parseUint64` does, and the exported Python and R `coda_segment_ids` with it.
- **Not yet known, for the probe:** a graph flagged `READ_ONLY` answers success without persisting
  (`execute`), so the probe checks the new root really holds both pieces before trusting `done`.

### Phase 3 — pre-flight (`src/packs/seam/mergePlan.ts`, read-only). **Built 2026-11-16**

`planMerges(request, options)` → a `MergePlan`: the merges to send, in the order the reader met
them in the queue, and every refusal with its reason, in the same order — or `ok: false` with one
sentence where nothing can be planned (no permission, not a chunkedgraph, a check that failed).

1. **The accepted pieces** — `acceptedPieces` in `reviewQueue.ts`, the one rule the scene's green
   pieces read too: one per candidate root, every row it was accepted on, nearest gap first.
2. **Minus this workflow's own merges** (`RecordedMerge`, done merges only), whose last `newRoot`
   is **the neuron's root now**; every later step asks about that root, not the reviewed one. Any
   root the neuron has had is refused as the neuron itself, and a piece this workflow merged into
   another reviewed neuron is refused `merged-elsewhere`. **A piece that is itself another neuron in
   the queue** (or what this workflow merged one into) **is planned, flagged** (`joinsNeuron`), so
   the dialog shows that the merge joins two reviewed neurons before the reader confirms (user,
   2026-11-16: "allow, flagged").
3. **Permission, then currency** at the server's now — both skipped when nothing is left to send,
   since every reason is then known without a server. Permission first, though asking both at once
   is a round trip faster: a reader who may not edit is usually refused the currency read too, and
   its 401/403 would replace the plan's sentence and raise the token alarm. `editPermission` finds
   the login service the chunkedgraph's host names, **requires it to be the deployment's own** (the
   token is the deployment's; elsewhere it would be refused — compared by origin, since one service
   answers at two paths), and keeps both for the session; Cancel stops the wait. A currency answer
   that does not cover every root fails the plan. Edit permission is the literal `edit` in
   `permissions_v2[dataset]`, exactly what `middle_auth_client.has_permission` checks — no admin
   shortcut exists there. An
   outdated neuron refuses every piece (`neuron-outdated`); an outdated piece is refused alone
   (`outdated`).
4. **Anchors**, one piece at a time, each row until one anchors. The volume is opened only here,
   once a current piece needs it.

**Changed from the plan: no `get_latest_roots`** — why is in `mergePlan.ts`' header. In short, an
outside merge into the neuron changes the *neuron's* root, so step 3 refuses it whole first.

The server calls are injected (`PlanServices`), so `mergePlan.test.ts` tests the logic without a
server. **Live, read-only** (`pnpm probe:merge-plan`, every rank-1 piece of a fixture neuron
accepted, on the card's own `readSuggestions` + `buildQueue`): all 5 Aedes fixture neurons planned 5 of 5 (25/25, as phase 1 anchored), 3.5–4.3 s a
neuron. On the sandbox, phase 7's old roots gave `neuron-outdated` for the old neuron, `outdated`
for an old piece on the current neuron, and a merge for two current roots.

### Phase 4 — the dialog (`src/ui/seam/MergeConfirm.tsx`). **Built 2026-11-16**, not yet opened by the card

Asked for by the user (2026-11-16): **an overlay over most of the screen** — 76% × 78%, measured
in Chrome at 1600 × 1000 — with **the plan on the left and Neuroglancer on the right**, so the
reader has to look at the end product before confirming. Decided with them:

- **The view**: the neuron (blue) and every ticked piece (green; orange where `joinsNeuron` —
  `candidate`'s validated hue, mapped locally since the overlay never shows a candidate; a fourth
  hue would need validating), plus a
  local annotation layer with **a line per merge** from the neuron's anchor to the candidate's
  (`mergeLineLayer`, `packs/seam/scene.ts`). A line is as long as the gap it bridges — 16–300 nm on
  Aedes — so at whole-neuron zoom each reads as a marker on the merge site.
- **A tick box per merge**, all ticked; unticking drops it from this Submit and its piece **and
  its line** from the view, without touching its verdict. Each line is linked to its piece
  (`linkedSegmentationLayer` + `filterBySegmentation`), so neuroglancer draws it only while the
  piece is shown, and a tick changes only the segment list — which the viewer sets in place, with
  no layer rebuilt and the camera where the reader left it (a changed line layer would re-navigate
  and re-centre). Checked in Chrome on a real Aedes plan: untick a piece, and its mesh and line go,
  the other lines stay, the camera holds. Hiding a piece in the viewer unticks it
  (`onSelectionEdits`); a Re-check keeps the ticks, and **a piece new to the plan starts
  unticked**. Pieces already merged leave the view during the batch.
- **The gate is the named button alone**: "Merge 7 pieces into 720575940… on wclee_aedes_brain",
  disabled at none; **Enter never presses it** (a click or Space does), and **it hands its merges on
  once** (a ref, so a double click landing before React redraws cannot send twice). Escape and
  Cancel close it before Merge is pressed; **from the press until the batch finishes** it cannot be
  closed, and Escape is still taken by the overlay so it cannot fall through and close the surface
  underneath. If `onConfirm` throws or its promise rejects, the batch did not start: the overlay
  unlocks and says why.
- **Known and left:** a segment the reader double-clicks *into* the viewer, or the neuron hidden
  there, stays as they left it (only plan pieces map to ticks; the list is what is sent). A piece
  hidden in the viewer and Merge pressed within the frame's report delay sends the piece. During a
  batch, a merged piece's line leaves the view with it — phase 5 decides how a batch is drawn.
- **Progress in the same overlay** (phase 5 drives it): `progress` per piece, `running`, `onStop`
  ("Stop after this merge"), and `neuronRoot` so the view follows the neuron to its new root.
- Refusals are listed under "N not merged", folded unless nothing can be merged; "checked at" and
  Re-check (`onRecheck`) sit in the header.

**Changed from the plan: the dialog does not make the confirmations.** It hands the ticked merges
to `onConfirm`; the submit module (phase 5) calls `confirmMerge` and sends, so `edits.ts` keeps one
importer (`MAY_WRITE`) and the dialog imports nothing that can write. On a phone-width screen the
plan sits above the viewer, with no horizontal scroll (checked at 420 px). Still to wire (phase 6):
opening it from Submit, never during a tour (`isTourActive()`), and pausing the card's own viewer
while it is open, so two Neuroglancer frames do not compete for the GPU.

### Phase 5 — the batch and the record. **Built 2026-11-16**, not yet reachable (no live writes)

`src/packs/seam/mergeBatch.ts` makes the merges; `src/packs/seam/mergeRecord.ts` is the record,
read by everything else. **The batch is the writer's one importer** (`MAY_WRITE`), and the batch's
own importers are held to a second list, `MAY_SUBMIT`, empty until phase 6 — one check over both
levels: the walk, a string search (which also refuses a type import), and a test file that must
be found, so neither level can pass for nothing. The overlay shows progress through `MergeProgress`,
which lives in the record module so the overlay never names a module that writes.

- **`prepareMerges(plan, merges, options)` is synchronous and is the only place a batch is refused
  before it starts**: a merge not in the plan, one listed twice, anything `confirmMerge` refuses.
  So the overlay's "Not started" (a throw from `onConfirm`) can only mean nothing was sent; the
  returned `Batch.run(callbacks)` runs once and reports every later failure as a result.
- **Before each merge, both supervoxels' roots at the server's now** (`rootsAtInstant`, `'server'`).
  The neuron's must be the root the batch last made (the plan's to begin with), else **stop** —
  somebody else edited it. The candidate's under the neuron's root is `already-merged`, nothing
  sent, and the batch goes on; under any root but its reviewed one it is `not-sent` (edited since
  the plan), and the batch goes on.
- **After a merge the server answered**, the same read must find both supervoxels under the new
  root (a read-only graph answers success without keeping it). If it does not, the merge is still
  recorded as made (on the server's word, with what the roots said) and the batch stops.
- **A lost reply (`unknown`)** is read off the roots: both supervoxels under one new root (a real
  id, never 0) is `merged` (no operation id). **Anything else stays `unknown`, roots that have not
  moved included** — a reply lost to a proxy's timeout can come back while the server is still
  writing, so only the server's own refusal is `failed`. A writer that throws is read the same
  way, never as "not sent". Every one stops the batch.
- **The next plan settles an `unknown`** — every `unknown` entry of the neuron since its last
  `merged` one (`mergedSoFar`'s `unsettled`), since a lost merge can land even after a later
  batch's check. Without it, a lost reply that did merge leaves the recorded root outdated and the
  neuron refused on every Submit. The plan settles one only where the roots show **this merge
  and nothing after it**: both supervoxels under one new root at the server's now
  (`sharedNewRoot`, the one rule the batch uses too), **and**, just before that root was made
  (`rootTimestamps`, `POST …/root_timestamps`, read off pychunkedgraph v2.20.0), under exactly the
  neuron's root and the piece's. The second test is what keeps somebody else's later edit from
  being adopted as ours — that neuron is refused (`neuron-outdated`), as the rule says. A settled
  plan names its root as `currentRoot` (`ReadyPlan.settled`); **its caller appends the settlement
  (`settledEntry`) as soon as the plan arrives**, not the batch, which may never run.
- **A lost merge that lands after a later *successful* merge** is not settled (a `merged` entry
  ends `unsettled`): the record's root is then outdated and the neuron refused. Safe, and would
  need the operation log to settle.
- **What is checked, sent and recorded is taken at Merge** (`prepareMerges`): the frozen
  confirmations and a copy of the plan's roots and each merge's tip, never the caller's objects,
  so a caller that changes them later cannot make the check, the request and the record disagree.
  Reads go to the confirmation's own table.
- **The plan's anchors are read at the server's now too** (`openAnchorVolume(…, 'server')`), not
  the browser's clock: a plan made right after a batch must see the roots it made. A reader at
  `'server'` is not one moment (each supervoxel as of when first asked), which the plan accepts
  because the batch re-checks every merge; nothing needing one moment may open one.
- **A refusal stops the batch**, recorded `failed` with the status. A check that cannot be read
  stops it too and records nothing, since nothing was decided. **Stop** takes effect before the
  next merge's check. Merges not reached are shown `not-sent` and not recorded.
- **The record is the `seam:review` param `merges`** — `unrecorded` (no undo step), and data, in
  the key, since `Merges` and `Current` read it. JSON, appended to, ids as text. One entry per
  decision the batch made about a confirmed merge: reviewed root, candidate root, `end_uid`, the
  neuron's root it was checked against, both supervoxels and positions, time, outcome
  (`merged` + new root and operation id, `already-merged`, `failed` + status, `not-sent`,
  `unknown`), and a sentence. A malformed entry is dropped on reading, never guessed at.
- **`mergedSoFar(record, reviewedRoot)`** is the one reading: the neuron's root now, every root it
  has had, the pieces in it. The plan (phase 3, which took a stand-in `RecordedMerge` until now),
  the node and the card read it. Only `merged` and `already-merged` put a piece in the neuron;
  only `merged` moves the root.
- **The record is not what stops a double send** — the server is. A piece merged already maps to
  the neuron's root at the per-merge check; and a record older than the server (a file saved
  before the merges, or a lost reply that did merge) leaves the recorded root outdated, which
  refuses the whole neuron at the plan. The record is what lets the next Submit on the same
  neuron start from its new root.
- **`Merges`**, a new output: the record as a table, one row per entry, all neurons.
  **`Current` and the card's viewer** show the neuron at its root now, and a merged piece as part
  of it rather than as itself (`scenePieces`' `merged`).
- **`unrecorded` now means "no undo step" only.** It used to switch auto-run off as well, which
  suited the one param that had it (Neuroglancer's camera, presentational) and would have left
  `Merges` and `Current` stale after every entry. `setParam` now auto-runs an unrecorded param
  unless it is `presentational` (`unrecordedParam.test.ts`).
- **Appending keeps what reading skips** (`appendEntry`): an entry this Coda cannot read stays in
  the param, since the record is the log of every Submit.
- **`mergedSoFar` also answers for the other reviewed neurons** (`otherRoots`, `elsewhere`), so the
  plan's "another neuron's piece" and "joins two neurons" come from the same reading, and the scene
  does not draw a piece merged into another neuron as itself.
- **One rule for a valid merge end** (`isMergeEnd`, `data/cave/merge.ts`), read by `confirmMerge`
  and by the record, so a record entry the writer would refuse is not read back.
- **Left for phase 6**, from the reviews: appending `plan.settled` (`settledEntry`) when a plan
  carries it; the card's rows for merged pieces (say `merged`, verdict
  buttons off); **the record is written through one store path** that reads the live param and
  appends (`appendEntry`) per entry — never a value read once at the start, and never through
  `setParams`, which takes no notice of `unrecorded` and would make it an undo step; **the review
  card cannot be deleted mid-batch** (the overlay has no backdrop, so the canvas is live), or the
  entry of a merge the server made has nowhere to go; and a reviewed neuron that this workflow
  merged into another is said to be so when picked, rather than drawn at its retired root.
- **Review:** /simplify, then /code-review medium twice. The first round found a lost reply whose
  roots had not yet moved recorded as `failed`, a lost reply that did merge refusing its neuron for
  good, the plan's anchors read at the browser's clock, root 0 read as a merge, and the check
  reading the caller's objects rather than the confirmation. The second found the settle too
  narrow (last entry only) and too loose (it would adopt somebody else's later edit), the
  settlement written only if a batch ran, the run still reading some plan fields live, and the
  import guard's comment stripper eating code after a `/*` inside a string. Left as they are: one
  auto-run per recorded entry (a cheap pass, and `Current` changes only its selection, which the
  viewer sets in place).

### Phase 6 — the button. **Built 2026-11-16** (no live writes)

On the review card's foot: **Submit (n)**, n = this neuron's accepted pieces not yet merged by
this workflow, here or into another reviewed neuron (`mergedSoFar`). **Disabled with the reason as
its title** (`submitPress`): this card's own Submit open or merging first, since that is what the
button shows; then in the order a reader would fix them — nothing wired; not a CAVE dataset; not
signed in to its deployment; the search still filling (`nodeInputsFilling`) — reviewing a
third-full queue is fine, submitting from one is not; this neuron merged into another under
review; nothing accepted; everything accepted merged — and another card's Submit last.

- **A session, not card state** (`ui/seam/mergeSession.ts`, the one module in `MAY_SUBMIT`, and
  reachable only from its overlay and its card, `MAY_OPEN`). A batch outlives the card's surface —
  the canvas and the expanded view both draw the card, the dashboard unmounts the canvas — so the
  session lives outside React and `MergeSubmitHost`, mounted once in the shell, draws the overlay.
  One session at a time for the app, **named by document and node**: two documents opened from
  one file share node ids. The overlay's root covers the whole app while it is up, so the
  document cannot change under it by pointer.
- **Press:** during a tour it says so on the status bar and opens nothing (`isTourActive()`);
  otherwise it plans (`planMerges`, with the verdicts and the record read live from the store),
  and a plan that cannot be made is one sentence on the status bar. **A settled lost reply is
  appended as soon as the plan arrives** (`settledEntry`), whether or not anything is merged after.
- **Merge:** the store **holds the card and its document** (`holdForWrite(docId, nodeId)`, which
  refuses unless that document is on screen and holds the card) — a delete, an undo or redo that
  would remove the card, a load, a new graph, a switch or close of a document are refused with a
  notice — and the browser asks before the tab is closed. Ordinary edits go on. Then
  `prepareMerges`; anything that stops the batch starting throws before the hold is kept, and the
  overlay says "Not started".
- **The record is written one way**: through the hold's `update`, which reads the param and
  replaces it with one entry appended (`appendEntry`) in a single store step, unrecorded — never a
  value read once at the start (each write would replace the last), never `setParams`. The
  settlement of a lost reply goes through a hold of its own, for the same check.
- **Known:** a refused document action returns nothing, so a caller that opens something (the
  wizard, the zoo, a shared link) goes on as if it had. Reachable only by keyboard or a script
  while merges are being sent, since the overlay covers the app.
- **The card**: its own viewer is paused while a Submit overlay is up (it is covered, and two
  Neuroglancer frames would share one GPU); the button's reason and the request it sends come from
  one function (`submitPress`); a row Submit has merged says `merged` (or `merged into another neuron`) and its verdict
  buttons are off; a picked neuron this workflow merged into another says so in the foot.
- **Not paused**: a full-size `out.neuroglancer` downstream of `Current` keeps drawing while the
  overlay is up.
- **While the check runs** nothing is drawn for it, so the card's button reads "Checking…
  (cancel)" and is the Cancel; other cards are not blocked or paused until an overlay is up.
  **Merge drops a Re-check still out**, so a late plan cannot land over a running batch. A neuron
  this workflow merged into another is drawn as that neuron at its root now
  (`MergedSoFar.absorbedInto`). The card follows a sign-in (`subscribeTokens`).
- **Review:** /simplify (the session named by document and node; the record written through the
  hold's `update`; one press function; `stillToMerge` as the one rule for green pieces, the count
  and the rows; `acceptedPieces` walking only tips with an accept, ~25× at 3,000 tips; a third
  import level), then /code-review medium twice — the first found Merge racing a Re-check, a
  check nobody could cancel, the sign-in reason not following, an absorbed neuron drawn at its
  retired root, and the leave prompt missing `returnValue`. The second found:
  - **A request that never answers held everything for good.** Root reads now give up after a
    minute (`READ_TIMEOUT_MS`; a read changes nothing). A merge unanswered after two minutes
    (`SEND_TIMEOUT_MS`) is read as `unknown` — the request is left to finish, the roots are
    asked, and it is never sent again.
  - **The last entries could miss the autosave** if the tab closed right as the batch ended (the
    prompt is gone by then); releasing the hold saves at once.
  - A refused delete or cut still cleared the selection and copied the card; an assistant plan
    that would remove the card reported success. Both are refused first now, the plan with the
    notice as its error.
  - The check read the document on screen, not the one pressed in: it is closed with a sentence
    when the document changes under it. Absorbed neurons are followed to the end of a chain
    (A into B into C is C). The card's viewer is no longer unmounted during a check, only while
    an overlay is up.
- **Known:** a sign-in or sign-out in another browser tab is not followed until a reload (the
  credentials are read once per tab).

### Phase 7 — the live sandbox test (writes; asked every time)

**Built and run 2026-11-16** (one merge and its undo, approved by the user for that pair). Result
on `fanc_sandbox`, pychunkedgraph 2.20.0:

| Step | Answer |
| --- | --- |
| Pair | roots `648518346434974036` + `648518346435009108` (1 level-2 chunk each), supervoxels `73468749633806194` / `73468749633815818`, 45 nm apart in z |
| Merge | `done`, operation `106280`, new root `648518346477537943`; both supervoxels map to it at the server's now; neither old root current |
| Undo | `done`, operation `106281`, new roots `648518346511843775` / `648518346500999958`; supervoxels apart, in exactly those roots; merged root no longer current; each piece 1 level-2 chunk again |

So the request shape (supervoxel ids as JSON strings, positions in nm at voxel centres,
`priority=True`), the reply parsing (`int64_as_str`), the operation id and undo all hold on the
real server. **An undo makes new root ids**; it does not revive the old ones, so anything keyed on
the pre-merge roots must follow lineage, not wait for them to return. `pnpm probe:sandbox-pair` (reads only, behind
`fenceWrites(0)`) finds touching current pairs, smallest first; `pnpm probe:cave-merge` without
`--i-asked` runs the pre-flight and stops. Its permission check (`permissions.ts`) and root reads
(`rootIds.ts`, `Instant` `'server'`) are the shipped ones; the rest of its pre-flight stands in
for phase 3's and switches to `mergePlan` when that lands.

- **Root reads after a write ask at the server's now** (no timestamp): a client clock behind the
  server's asks about a moment before the merge and sees the old roots. **Phase 5's per-merge
  re-check must do the same.**
- **Permission** is `edit` in the auth service's `permissions_v2[dataset]`, which already leaves out
  a dataset with terms pending; `missing_tos` lists every dataset's and is not read. The auth base
  is discovered (`/sticky_auth` on global), never assumed.
- **The fence** (`src/test/sandboxWrites.ts`) is an allow-list at `fetch`: any request but a GET
  must be a merge, an undo or one of the three posted reads, on `cave.fanc-fly.com`'s
  `mar2021_test`, judged on the parsed final URL; merges and undos are limited separately (the
  test declares one of each), and an undo needs a merge before it. A refusal is marked, so the
  script can say "never sent".
- **A merge that may stand is said out loud.** From the moment the merge is sent, any ending —
  a lost reply, a read that throws, an undo that fails — prints whether a merge is or may be
  standing, with the root and operation; cleared only when the roots show the pieces apart.
- **Review:** /simplify, then /code-review medium twice (the first found the undo skippable by a
  throw and the pre-flight passing an empty `is_latest_roots` answer).

`scripts/probe-cave-merge.mjs`:

- **Hard-coded to `fanc_sandbox`, table `mar2021_test`**: the guard checks the final POST URL's
  table, because the sandbox shares a host with production Aedes. Anything else is refused before
  a request is built, and the refusal is unit-tested.
- Takes the pair on the command line plus `--i-asked` naming the same pair, so a re-run from shell
  history with a different pair fails.
- Runs a pre-flight (above), merges, checks the new root holds both pieces, then **undoes the
  merge** and checks the pieces are apart again and the merged root is no longer current.
- **Sends supervoxels**, anchored by phase 1 — never root ids (see "Decided before phase 2").
  Runs right after phase 2, as a check of the writer alone.
- **After the sandbox, the first Aedes merge is one the user picks and watches**, made through
  the finished card (not the probe), before any batch runs there.
- Claude finds a candidate pair with read-only queries and proposes it; **the user approves that
  pair before any run**, merge and undo in the same request.

### Currency on the card (user, 2026-11-16)

Asked for after the first merge: say on the card, not first at Submit, when the query neuron or a
candidate has been edited since the suggestions were made. `packs/seam/rootCurrency.ts`, reads
only, and advice only — Submit's own check still decides.

- **What is asked:** `is_latest_roots` at the server's now, for the neuron's root *now* (the
  record's `currentRoot`, so this workflow's own merges never read as somebody else's edit) and
  every candidate of the picked neuron not already merged — a merged piece is retired by the
  merge and says `merged`, never `outdated`. Gated on a sign-in, and `quiet`.
- **Streaming:** Suggest Merges publishes candidates while the card is up, so the card hands over
  the whole set on every change and only roots not yet known are asked — gathered for 400 ms, so a
  stream's partials go out together, in batches of 1,000, one at a time.
- **How long an answer holds:** outdated for good (an edited root is never current again);
  current for five minutes; a failed ask waits a minute before the same roots are asked again.
- **A full batch, measured on Aedes** (2026-11-16, one read, behind a guard refusing any other
  post): 1,000 real roots from the committed fixture's tips and candidates in one
  `is_latest_roots` call — 1,000 answers in 1.16 s, 995 current and 5 edited. So the batch size
  is within what the server takes, at about a second a batch.
- **On the card:** an edited candidate gets a red **outdated** chip beside its id (the merged
  chip's shape, in `--status-refused`, the red measured per mode for text). An edited neuron is a
  red line in the foot — "query neuron edited since these suggestions were generated" — and
  Submit is off with that as its reason. Not said where the neuron is merged into another (its own
  reason), nor while a lost reply is unsettled (the plan's to settle).

### The first Aedes merge (user, 2026-11-16)

Made by the user through the card, in their own browser, from published suggestions (`rv2`): six
pieces accepted, all but one unticked in the overlay, one merged.

| | |
| --- | --- |
| Merge | neuron `648518347622603652` + piece `648518346841804863` (tip 143), supervoxels `74100146467700639` / `74100146467689339`, 16 nm apart |
| Answer | `merged`, operation `446476`, new root `648518347498045040`; recorded 13:19:27.756 UTC |
| Card | the neuron followed to the new root in the linked Neuroglancer; the piece's row said merged, its verdicts off |
| Checked after, reads only | both supervoxels under the new root at the server's now; the new root current, both old ones retired; the new root made 13:19:26.629 UTC (`root_timestamps`, its first live call — the shape read off the source held), and just before it the two supervoxels under exactly the old neuron and the old piece, so the root is this merge and nothing after it |

The user's notes, all fixed:

- A merged row's "merged" was one more muted fact, hard to tell from a piece still to merge. It is
  now its own chip beside the id, in full-strength text, bold and outlined; and the row's disabled
  verdict buttons are drawn off (as the page arrows already were), not like live ones.
- The overlay opened at the published zoom, close in. It now frames the whole neuron: the box
  around its tips (the session holds the queue) and the merges' points, with a margin, sent as
  `focus`/`focusWidth` once.
- The neuron and the pieces were one layer. The neuron now has a layer of its own, a copy of the
  dataset's segmentation layer drawn at `objectAlpha` 0.2, so the pieces about to join it stand
  out; the pieces and the merge lines stay in and on the dataset's layer. A merge changes only the
  neuron layer's segment list, which the viewer sets in place, so the camera holds.

### Phase 8 — docs. **Done 2026-11-16**

- `packs/seam/help/review.md`: "Submitting merges" — what you need, what is checked, what happens
  while it runs and afterwards, outdated neurons and pieces, and how to reverse a merge (its
  operation ID, with your own tool; Coda has no Undo); `Merges` in the outputs table.
- [backends-cave.md](backends-cave.md): "Writing to a chunkedgraph" — the writer, the three import
  levels and what a change near it must keep, pointing here for the record.
- CLAUDE.md, under Backends and data: the one-module rule, pointing at both.

## Settled questions (user, 2026-11-15)

- **Suggest Merges looks up candidate roots at the dataset's materialization**, not at now
  (`seam-suggestions-plan.md`, "One instant for the whole run"), so on an old materialization many
  candidates will fail the latest check. Accepted as correct; **looking roots up at now is the next
  feature after this one.**
- **Published suggestions** (`seam:suggestions`) are a 2026-11-04 snapshot, so neurons edited
  since will be rejected whole. Accepted; the user is generating up-to-date suggestions.
- **Rate: one merge at a time, no added pause.** No courtesy limit is known. Spelunker has none:
  `bulkMerge` (vendored `graphene/frontend.js`) starts **every** pending merge at once — up to
  `MAX_MERGE_COUNT = 20` in flight — retries each up to three times with no delay, and re-tries a
  failed one as soon as another finishes. Its only wait (`wait(5e3)`) is for clearing a finished
  merge from the list. Concurrent merges on one neuron contend for the chunkedgraph's lock
  (`LockingError` → `500`), which is the likely reason it retries. Sequential sends are gentler
  than the reference client and should not hit that contention from our own side. A `500` from
  somebody else editing the same neuron is still possible, and it is handled like any failure:
  stop, re-read the roots, report.
- **The first Aedes merge is one merge the user chooses and watches**, before any batch is run
  there. The sandbox now runs Aedes' version on Aedes' host, but it is not Aedes' data.
- **Root ids in place of supervoxels**: try it in the sandbox (above).
- **`remesh`** defaults to true server-side; leave it.
