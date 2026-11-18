# Proofreading on the live segmentation — plan

Status: **all five phases done** (2026-11-17 – 18): the two server calls, Find Open Ends reading the nucleus table live, Suggest Merges searching at `Searched at` within each neuron's life, the messages, and the docs. Follows [seam-extend-plan.md](seam-extend-plan.md)
and [seam-merge-plan.md](seam-merge-plan.md).

## The problem

Coda pins a CAVE dataset to a materialization, so an analysis has a fixed point in time. The
proofreading nodes work on a neuron somebody is editing, and that neuron's root id is usually
newer than any materialization. Submit makes a new root every time it merges.

Found on the on-demand workflow with root `648518347585551219`, the root our first real batch
made (read from the server, 2026-11-17):

| | Time (UTC) |
| --- | --- |
| Materialization 564 frozen | 2026-11-16 14:11 |
| `648518347585551219` made | 2026-11-17 07:38 |
| Current now | yes |
| Current at 564's time | **no** |

- **Find Open Ends** reads the nucleus table at 564, which has no row for the root, so it says
  "1 of 1 neurons have no row in `nuclei_v1_aedes`". The live table has one (nucleus `6393`).
- **Suggest Merges** turns each box's supervoxels into roots at 564's time. The neuron appears as
  its old pieces, never as `648518347585551219`, so every end reads "None of the 10 open ends had
  its own neuron in the box".

## Where the dataset's materialization goes today

| Node | What reads it | With a root newer than the materialization |
| --- | --- | --- |
| Custom CAVE | `version: ''` is "the newest when loaded" (564) | — |
| Meshes | Nothing on Aedes: a graphene mesh is fetched by root id at any time. (Where a datastack has a flat mesh store for one materialization, e.g. FlyWire public, a newer root is not in it.) | fine |
| Find Open Ends | The nucleus lookup only (`nucleiFor` → `somataFor` → a materialized query) | soma not masked, and a warning |
| Suggest Merges | `when = { version }`: the moment every box's roots are read at; also in the memory key (`RunIdentity.version`) | no candidates |
| Review Suggestions, the merge plan, Submit | Nothing. Root currency, anchors and the batch all ask at the server's own now (`'server'`) | already live |

## Decisions (user, 2026-11-17)

| Question | Decision |
| --- | --- |
| What sets the moment | **The query neuron.** The proofreading nodes take the deployment and datastack from the Dataset and ignore its materialization. A root still current is read at a recent moment; a root no longer current is read at the last moment it was current, **with a warning**. |
| A "Materialization: live" option on the Dataset | **Not now.** It would need a live path for every table, synapse and annotation query, and would not fix a pinned dataset fed a newer root, which is the case that failed. |
| How "now" is kept | **A param on Suggest Merges, `at`**, with no undo step (`unrecorded`, as Review's `merges`); the card's ⟳ moves it to now. First "written by the card"; then (same day) filled by the store before the run, since the card is not mounted on the dashboard; then **a record of each neuron's moment, written by the run and out of the key** — see phase 3. |

**Why a param, where Update Root IDs decided against one.** `updateRootIds.ts`' header argues a
moving "now" must not be a param: it would be an edit, an undo step and a timestamp in somebody
else's file. Here the file *should* carry it. The review card's verdicts are saved in the file
and name candidate roots. Searched again at a new "now" after a reload, the candidates could
change and the saved verdicts would point at nothing. A stated past moment never changes, so the
tables come back the same, and the memory of finished ends can key on it exactly.

## What the server answers (read 2026-11-17, `wclee_aedes_brain`)

- **`root_timestamps` with `latest=true`** is the last moment a root was current: about the
  request time for a current root, and the time of the edit that replaced it for one that is
  not. For the old seed `648518347558097460` it answered 07:37:49.071, and `is_latest_roots`
  says the root is current at that moment, 1 ms before, and 1 s before. caveclient 8.2.1 takes
  1 ms off the answer (`get_root_timestamps`), and so should we.
- **The live table query** is `POST {mat}/api/v3/datastack/{ds}/query` with `table`, `timestamp`
  and the filters in the body, and `return_pyarrow`, `arrow_format`, `merge_reference=false`,
  `allow_missing_lookups`, `allow_invalid_root_ids` as query args (caveclient 8.2.1,
  `live_live_query`). It found the nucleus for `648518347585551219`.

## The design

### Find Open Ends: no param

While a root is current its supervoxels do not change, so its nucleus row is the same at any
moment of its life. The nucleus lookup asks the live table at **each root's last current moment**
(less 1 ms). Nothing to pin, and an answer can be kept by root id for the session. A root no
longer current is warned about, naming it.

### Suggest Merges: `at`

- **Each neuron is searched at the earlier of `at` and its root's last current moment.** One param
  covers a run of several neurons; a replaced root falls back to just before it was replaced, and
  the card says so.
- **A piece is searched at its neuron's moment.** It was found among that neuron's candidates, so
  it existed then.
- **One moment per neuron, where the run had one moment.** The supervoxel → root map is already
  cleared between neurons (`forgetRoots`), so a reader per neuron at its own moment is a small
  step. The chunk cache is shared as now: supervoxel voxels do not change with time; only the
  root lookup does.
- **The memory's key** takes the neuron's moment where it took `version`.
- **The dataset's `version` is no longer read for time** by this node.
- **Saved graphs with no `at`** load as empty (`absentMeans: ''`), and the first run pins it.

**Open, for phase 3 to settle: how the card learns the moment.** A run cannot write its own
params. The likely route is the one viewers use for `view`: a run with `at` empty searches at its
own start, publishes that moment (a `searched_at` column on `Tips`, which a reader may want in any
case), and the card writes it into `at` without an undo step. The key then moves and the run
after is answered from the memory. Measure that this costs well under a second before settling on
it.

### Review Suggestions

Nothing changes in how it tells time. Candidates found at `at` can be edited by somebody else
afterwards; the card's currency check and Submit's plan already read at the server's now and
say so.

### The error that started this

"None of the … open ends had its own neuron in the box" names a materialization mismatch as the
usual cause, which this plan removes. Reword it once the moment comes from the root. And the
chunk-cache advice ("Raising it is the direct fix…") is added even to a run that searched
nothing; it should be left off there.

## Phases

0. **Measure, reads only.** **Done 2026-11-17**, above.
1. **`src/data/cave`: the two calls.** **Built 2026-11-17.**
   - **`rootLives(graphene, roots)`** (`rootIds.ts`): per root, `made`, `last` (the last moment
     current, less 1 ms) and `current`, from three calls — `root_timestamps`, the same with
     `latest=true`, and `is_latest_roots` at the server's now. The third is needed: for a current
     root `latest=true` answers the request's own moment, which cannot be told from a root
     replaced that second. For a current root `last` is the **server's** now, not the browser's.
   - **An id the chunkedgraph never made** comes back in `unknown`. The server says so three
     ways (measured): alone, without `latest`, an empty list (so are `0` and a supervoxel id);
     among known roots, a 500 whose message is the id; with `latest=true`, a 500 "pop from an
     empty deque". And `is_latest_roots` answers `false`, which reads as "replaced". So the
     first call is the check (`madeOrUnknown`): a 500 whose message is one of the ids sent sets
     that id aside and asks the rest again — one request per unknown id. A 500 naming none of
     them is the server failing and is thrown at once. A short answer naming nothing (never
     seen) is halved down to a root alone.
   - **`queryTableLive(server, datastack, at, query)`** (`api.ts`): `live_live_query`, JSON (the
     endpoint honours `return_pyarrow=false`; no Arrow reader needed), CORS `*`. Three silent
     differences from the materialized query, each pinned by `liveQuery.test.ts`: **ids must be
     bare integers** (quoted, it answers `[]` — the materialized endpoint takes either), so the
     body is written as text with the ids spliced in, and anything not an id is refused first;
     `select_columns` is a map keyed by table (a list is a 500); the timestamp is ISO (epoch
     seconds are a 500). A root not current at `at` is refused by the server, naming it.
   - **Checked on `wclee_aedes_brain`**, reads only: the current root, the replaced seed (`last`
     07:37:49.071, 1 ms before the merge) and a made-up id (in `unknown`); the nucleus found for
     both real roots, each at its own moment, its id read back as text; the replaced root at
     "now" refused.
   - `rootTimestamps` keeps its contract and shares the call (`timestampsOf`).
   - **Reviewed** (2026-11-17): one /simplify pass, one /code-review at medium. What changed:
     - The unknown-id fallback asked every root of a failed batch alone — up to 10,000 requests
       at `CHUNK`. It now reads the id from the server's message (`CaveError.detail`, new: the
       server's words alone), and a 500 that names none of the ids is thrown instead of being
       taken for one. Halving is kept for the short answer that names nothing.
     - Both functions refuse a string that is not a 64-bit id (`isSegmentId`) before sending.
       `isNeuronId` is the transport grammar: `-1` and `0648…` pass it, and spliced as JSON
       numbers they are a different filter or a broken body.
     - `queryTableLive` refuses a read with no id column (that would be the whole table) and a
       moment that is not a time; an empty id list answers `[]` without asking. **The live
       endpoint ignores `count=true`** (measured: it answers rows), so the row cap stays the
       `CAVE_MAX_ROWS` fallback, against CLAUDE.md's "the server's own `COUNT`" — there is none
       here. Every read is filtered on root ids, a few rows each.
     - `rootTimestamps` lost the `latest` flag the first pass gave it; `oneEach` is the shared
       length check.
     - **Left**: the id splice `[${ids.join(',')}]` is now written five times (`rootIds.ts`
       three times, `api.ts`, `skeletonService.ts`), and only the new two check their ids. One
       `jsonIdList` beside `idList` and `pyLongIntList` is a cleanup of its own. Answers that
       never change (when a root was made, when a replaced root stopped) are not cached; a
       handful of roots a run does not need it. Two requests from different moments can give a
       root replaced between them `last` = the first request's time — still a moment it was
       current, which is what a reader at `last` needs.
2. **Find Open Ends** asks the nucleus table live, at each root's moment, and warns about a root
   no longer current. **Built 2026-11-17.**
   - **`somataLive`** (`data/cave/nuclei.ts`) beside `somataFor`, sharing its session memory
     (`remembered`, now one function for both) and its reading of rows (`positionsOf`). It asks
     `rootLives`, then reads the live table at each root's `last`; roots sharing a moment share a
     query, so a run of current neurons is one read. Kept apart from the materialized memory
     (`…|live|…`): "no row at 564" is not "no row". `rootLives` is asked on every call, even with
     every soma remembered, since whether a root has been replaced is the one thing that moves.
   - **Find Open Ends** (`nucleiFor`) reads live where the datastack has a chunkedgraph, and at
     the materialization where it has none. Two new warnings: a replaced root, named, with the
     minute it stopped being current and the remedy (Update Root IDs above the meshes, which
     were fetched for the same old root); and an id the chunkedgraph never made. The "no row"
     count leaves both out. Ids are filtered with `isSegmentId`, the chunkedgraph's grammar.
   - `grapheneFor` is exported from `rootIds.ts`; phase 3 needs it too.
   - **Checked in Chrome**, reads only, the workflow's chain (Meshes, Clean Meshes twice, Find
     Open Ends with `nuclei_v1_aedes`) with the Dataset left on "Latest" (564):
     `648518347585551219` — no "no row" warning, 17 ends dropped near the soma, 47 s;
     `648518347558097460` (the replaced seed) — "edited since … current until 2026-11-17 07:37
     UTC", its soma read then, 19 ends dropped, 37 s. Before this, the first had no soma mask.
   - **Reviewed** (2026-11-17): one /simplify pass, one /code-review at medium. What changed:
     - **Every current root is read in one query**, at the earliest of their `last` moments.
       Grouped by exact moment, a server stamping each root on its own would cost a query per
       neuron. A current root made after that moment is read at its own. Replaced roots group by
       their moment (`groupBy`), so roots one merge replaced share a query.
     - **A live "no row" is not remembered**: the live table can gain a nucleus row, a frozen
       one cannot. A soma, or two nuclei, still is.
     - Find Open Ends counts each neuron once (a neuron can arrive as several items), looks a
       soma up by `idText` as it was asked, and caps the ids it names (`namedFew`).
     - **Measured, and not a problem**: a live moment two minutes ahead of the materialization
       service's clock is answered; a live read before the oldest kept materialization
       (2026-06-01, against 2026-10-21) still finds the nucleus.
     - **Left**: a result served from the cache keeps the warning of the run that made it, so
       a root replaced since is not said until something re-runs the node. A failed soma read
       fails the node, as a mistyped table always has. One query per separately replaced root.
       `grapheneFor` could replace the inline `parseGrapheneSource(datastackRecord(…))` in
       `mergePlan.ts` and `rootCurrency.ts`, and the "edited since" sentence and `utcMinute`
       should move somewhere shared when Suggest Merges needs them in phase 3.
   - **Left:** a datastack that *declares* a nucleus table puts the soma on the mesh itself
     (`CaveSource.meshSomas`, at the Dataset's materialization), which Find Open Ends uses when
     `Nucleus table` is empty. A root newer than the materialization gets no soma that way, as
     before. Aedes declares none; the Meshes node is outside this plan.
3. **Suggest Merges: a moment per neuron, kept in the document.** **Built 2026-11-17**, and
   built twice — the first design is recorded below because each of its steps is the obvious one.
   - **Decided (user, 2026-11-17): a moment per neuron, kept by the run, out of the key.** The
     first build kept *one* `Searched at` for the node, filled by the store before the first run.
     Asked: after twenty minutes on one neuron, a new, unrelated one would then be searched at
     the moment of twenty minutes ago — a new neuron is a new search. So `Searched at` became a
     record: the moment the first run that met each neuron searched it at. And since a neuron is
     only known once the run is under way (it arrives on `Tips`), the store cannot fill it
     beforehand; the run writes it. Asked again: left in the key, that write would re-key the
     node and the review card below it and run them again, or leave them stale with auto-run
     off — so it is **out of the key** (user).
   - **Core: `ParamBase.runRecord` and `EvalContext.record`.** A run writes a record param's whole
     new value through `ctx.record`; the scheduler refuses one not declared `runRecord`, drops a
     cancelled run's, and relays it to `SchedulerHost.onRecord`; the store writes it with no undo
     step and no run (`onRecord`, gated on the active document like every host callback). A
     record param is also `presentational` (out of the key), `unrecorded` and `internal` (off the
     card). **This bends invariant 4's wording** — `evaluate` reads it — and holds by
     construction: the same key means the same upstream, so the same neurons, and an entry is
     what the run that wrote it used. The ways it moves otherwise are the ⟳ and an edit by hand,
     which `internal` keeps off the card. A run outside the store writes nothing (MCP).
   - **The ⟳ is its own store action, `refreshNode`**: empties the node's records
     (`core/runRecord.ts`, `emptyRecords`), forgets its data, runs it. **Not `clearNodeCache`**,
     which is also the Inspector's and the menu's Clear Cache ("forget downloaded data"): emptying
     the record there would search the next run at a new moment, and the review card's saved
     verdicts could name another search's answer.
   - **`Searched at`** (`at`): `root=moment` entries, ISO 8601 UTC (`readSearchedAt`,
     `writeSearchedAt` in `rootMoment.ts`). **What is not an entry is set aside and said**, and the
     record written back without it — first it was refused with "the card's ⟳ empties it", and
     the on-demand workflow, saved under the first design with one bare moment, failed with a
     remedy a failed card does not show (its foot appears only once a run has read data).
     Datastack's help says only the datastack is read.
   - **A moment per neuron** (`momentsOf`; the pure half `momentsFrom`): the recorded moment, or
     for a neuron with none the present, **5 s behind this browser's clock** (`FILL_BEHIND_MS` — a
     clock ahead of the chunkedgraph's would name a moment a current root has not reached), moved
     into the root's life by `momentWithin`: as it last stood where the root was edited before
     it; from `made + 1 ms` where it was made after (**measured**: Aedes answers "not latest" at a
     root's own creation time and "latest" a millisecond after) — only by a hand edit now, since
     a new root id is a new neuron with a new entry. **New entries are recorded before anything
     is measured**, so a run cancelled and run again searches at the same moment and the memory
     of finished ends answers what was done. Said: a root edited before its moment, one edited
     after (searched at its moment, before the edit), a root the chunkedgraph never made (passed
     through unsearched). Without a chunkedgraph, the materialization's frozen moment.
   - **A moment, once settled, is kept for the session** (`settledMoments`, per root and wanted
     moment), so a run the memory answers whole goes on at the moments it knows when the
     chunkedgraph cannot be asked, and says so. `rootLives` keeps what never changes (when a root
     was made, a replaced root's whole life): a repeat run is one round trip, not two.
   - **The memory's key** takes the neuron's moment where it took `version` (`RunIdentity.moment`,
     an identity per neuron: `identityOf`). A piece is read at its neuron's moment.
   - **The reader moves with the neuron**: `forgetRoots(volume, moment)` clears the roots memo and
     sets `BoxReader.at` together, and where the moment changes first waits **until nothing is in
     flight** — a failed piece's lookups carry nobody's signal, and a stopped read can start one
     during the wait (the first version waited on a snapshot and let it land after the move). The
     chunk cache is shared across moments: voxels do not change, only which root holds them.
   - The "edited since" and "not a root" sentences and `utcMinute` are in `rootMoment.ts`, shared
     with Find Open Ends.
   - **The first design, and why it went**: `ParamBase.fillOnRun`, filled by the store's `runFull`
     before each run over the scheduler's scope (`Scheduler.scopeOf`, less nodes inference says
     cannot run), one moment for the node, an empty one refused outside the store. Reviewed once
     each way (/simplify, /code-review medium); what those found that still applies is above. It
     went for the per-neuron record, which no pre-run fill can write.
   - **Checked in Chrome**, reads only: the workflow's chain through Suggest Merges (no assessor,
     the best three ends by `e_tip`), the Dataset on "Latest" (564), the scheduler's host
     capturing the record. `648518347585551219` with no record: 3 of 3 ends, 200 candidates,
     recorded `648518347585551219=2026-11-17T10:26:39.205Z` (it had found none before this
     plan). Given that record back: 200 candidates in **0.5 s**, all from the memory, nothing
     recorded. The replaced seed `648518347558097460` with no record: 198 candidates, recorded
     at its last current moment (07:37:49.071), "edited since … current until 07:37 UTC".
   - **Left**: a run outside the store (MCP) meets every neuron as new; the moment sits on the
     shared reader, not on each request, which is sound while neurons are searched one after
     another; `RunIdentity` is per neuron and keeps its name. `core.md` and `invariants.md`
     should record `runRecord`, `ctx.record` and `refreshNode` (phase 5).
   - **Reviewed, the final design** (2026-11-18): one /simplify pass, one /code-review at medium.
     What changed:
     - **The ⟳ moves the node's key where it empties a record** (`Scheduler.renewNode`: a lapse
       asked for). Without it a run in flight, deciding on the old record, kept its key and the
       next walk adopted it. A card with no record to empty keeps Clear Cache and run.
     - **What an evaluation records it reads back** (`ctx.params` is a getter in
       `makeEvalContext`): the lifetime backstop runs `evaluate` again on a spread of the context,
       and read the record as before the first pass — a new moment for every new neuron.
     - **`registerNode` refuses a `runRecord` without `presentational`, `unrecorded` and
       `internal`** — left out, the write re-keys everything below the node, silently.
     - **One memo per moment** (`BoxReader.memo: RootMemo`, replaced whole by a synchronous
       `forgetRoots`; `labelledBox` and `resolveRoots` take the memo they started with). A lookup
       in flight at the switch finishes into the old memo, so there is no wait — the first
       version's could not be cancelled, a shared lookup carrying nobody's signal.
     - **`settledMoments` went; the record is the fallback.** An entry the node writes is inside
       the root's life and stays there, so where the chunkedgraph cannot be asked and every
       neuron has an entry, the run goes on at the record's moments — after a reload too, which
       the session copy could not. An entry outside its root's life (typed by hand) is rewritten
       to the moment used, so the two paths agree.
     - A set-aside entry is written away on every path (the warning said so and two paths did not);
       a new neuron made within `FILL_BEHIND_MS` is not "made after its moment"; entries are read
       as UTC where they name no offset (`parseCaveTimestamp`); the last piece loop runs a neuron's
       pieces together; `openSearchVolume` takes the moment as a number; `momentsFrom` splits the
       edited roots itself.
     - **Left, with reasons**: the record keeps entries for roots no longer on the wire, about 45
       bytes each — pruning would break "the same moment when you return to a neuron", and a
       replaced root's original moment can be earlier than its `last`. `at` is `presentational`
       although `evaluate` reads it: the bend of invariant 4 is the design, recorded at
       `ParamBase.runRecord` and due in `invariants.md` (phase 5).
4. **The messages** above. **Done 2026-11-18.** "None of the … open ends had its own neuron in
   the box" now names tips that are not on the neuron (another neuron's `Tips`, positions not in
   nanometres), since each neuron is read at its own moment; "showed none" no longer names a
   materialization; the chunk-cache advice is left off a run where no end was measured
   (`reportOnRun`). Pinned in `scoreEnds.test.ts`.
5. **Docs**: both help pages, `datasets.md`'s note on which nodes follow the root, and a line in
   CLAUDE.md's SEAM section. **Done 2026-11-18**: `help/suggestMerges.md` ("Which moment is
   searched"), `help/openEnds.md` (the live nucleus read), `datasets.md` ("The SEAM nodes follow
   the root, not the materialization"), `core.md` ("A run record is a param the run writes and the
   key leaves out"), `invariants.md` (the exception to 4), and CLAUDE.md (invariant 4 and the SEAM
   section).

## What will bite, quietly

- **Off by one millisecond.** caveclient takes 1 ms off `latest=true`; a moment exactly at a
  replacing edit may already read the new root on another server.
- **A replaced root read at "now"** finds the neuron as its successor, or as nothing, and reads
  like a segmentation problem. This is exactly what happened with 564, the other way round.
- **One moment for two neurons.** With a run-wide moment, a neuron replaced before `at` is read
  at a time it no longer existed.
- **The Custom CAVE card's "Latest" moves on reload** (564 → 565). It no longer changes what the
  search reads, but it is still in Find Open Ends' upstream key and will re-run it.
- **The memory keyed on `version`** would hand back a pinned run's ends to a live one with the
  same number. The moment has to replace it, not sit beside it.
