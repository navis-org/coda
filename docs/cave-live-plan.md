# A CAVE dataset with no materialization — plan

Status: **plan only** (2026-11-25). Nothing below is built except the first fix, which is.

## The problem

`fanc_sandbox` on `global.daf-apis.com` has no valid materialization. Its metadata endpoint
(`/materialize/api/v3/datastack/fanc_sandbox/metadata`) answers `404 "No valid versions found"`.

Coda reads every CAVE table *at* a materialization: the dataset id is `datastack:version`
(`datasetIdFor` / `splitDatasetId` in `src/data/cave/spec.ts`), and almost every read is a
`/version/{n}/…` URL. So the Custom CAVE node has nothing to stand on.

**Done already:** `versionsMetadata` reads that 404 as an empty list (`caveGetOr404`), and the
card says "fanc_sandbox has no usable materializations … this node can only read a materialized
datastack", on the card and on Run. Before, Run showed the bare HTTP error.

## The idea

Add a third choice to the Custom CAVE **Materialization** dropdown: **Live**. A live dataset is
still a fixed point in time, like a materialization, but the moment is chosen by Coda rather
than frozen by CAVE:

- The moment is taken on the first Run and stored on the node (a run record,
  `ParamBase.runRecord`, as Find Merge Candidates' `Searched at` is). The ⟳ button takes a new one
  (`renewNode`). So invariant 4 holds: the provenance key carries the moment, and a re-run with
  no edit reads the same data.
- Every read goes through the live endpoint at that moment (`queryTableLive`,
  caveclient's `live_live_query`), which `src/data/cave/nuclei.ts` already uses for SEAM.
- For a datastack that has materializations, Live is an extra choice, never the default. Empty
  stays "latest materialization". Offered on every CAVE dataset node (see Decisions).

## Phase 0 — measure first (blocks everything)

The whole plan rests on two things nobody has checked. Read-only GETs/POSTs, with the user's
token (the session that wrote this could not read the token):

1. **Is it really zero?** `GET …/datastack/fanc_sandbox/versions` and `…/metadata`. If an
   expired or invalid version exists, the 404 may mean "none *valid*", which changes the message,
   not the plan.
2. **Does `live_live_query` answer on a datastack with no materialization?** POST
   `…/datastack/fanc_sandbox/query` on one table (`mar2021_test`), filtered on one root id, at
   now. The materialize service may look for a materialization to start from and refuse the same
   way. **If it refuses, this plan stops here**, and the answer is to ask the CAVE admins for one
   materialization of the sandbox.
3. If it answers: an **unfiltered** live read of a small table — accepted, refused, or capped?
4. Listing the tables without a version: the annotation service
   (`/annotation/api/v2/aligned_volume/{av}/table`) and one table's metadata there.
5. Does the sandbox declare a synapse table, and does a live read of it filtered on
   `pre_pt_root_id` answer?

Write each answer, with its date, into this file.

## What a live dataset would touch

| Reader | Today | Live |
| --- | --- | --- |
| Dataset id | `datastack:783` | a second grammar, e.g. `datastack@<epoch ms>`. `splitDatasetId` returns a moment *or* a version — one type (`CaveAt`), so no reader can forget the second case. ~20 call sites, 7 files. |
| Neuron table (`findNeurons`) | materialized query, checked against the server's `COUNT` | live query, **unfiltered**. The live endpoint has no count, so truncation is judged by… see decision 2. |
| Synapses | materialized, by root id | live, by root id — the shape `queryTableLive` already has. |
| Connection view | a view | **not available**: views exist only in a materialization. Connectivity falls back to the synapse table (slower). Refused in a sentence if the node is set. |
| Annotations chain (`caveTable.ts`) | table list and reference tables at a version | table list from the annotation service; reference tables (`target_id`) through the live endpoint — unmeasured. |
| Table dropdowns, Table Info | `/version/{n}/tables`, `/views` | annotation service listing; no views. |
| Root drift check (`rootIds.ts`) | against the materialization's `time_stamp` | against the moment — the same comparison, a different instant. |
| Meshes, skeletons | by root id | unchanged; no flat stores. |
| Nuclei | already live for SEAM | unchanged. |
| Notebook / R export (`export/plans/cave.ts`) | `materialize.query_table(…, materialization_version=n)` | `live_live_query(…, timestamp=…)` in Python; R refuses unless fafbseg has an equivalent. |

## Decisions (user, 2026-11-25)

| Question | Decision |
| --- | --- |
| Where the moment lives | **Both**: taken on the first Run and stored on the node, shown on the card, and editable by hand. ⟳ takes a new one. |
| An unfiltered live read has no server count | **Count through the annotation service first** (`annotationCount`). It counts the table now, including rows deleted since the moment, so it can only overstate; refuse when it reaches the cap. |
| Scope | **All CAVE dataset nodes**: Custom CAVE and the named families (FlyWire, BANC, …), as an advanced choice. Empty stays "latest materialization" on every node. |

Two things follow from the first decision. A hand-typed moment is a real param and sits in the
provenance key; the run record must fill the *same* field, so a typed and a recorded moment
cannot disagree. And a moment before the datastack's segmentation existed, or in the future, is
refused in a sentence before anything is sent.

## Phases, after Phase 0

1. `CaveAt` and the id grammar; every `splitDatasetId` caller handles both arms (typecheck finds
   them). No behaviour change for a versioned id.
2. The Live choice on Custom CAVE, the moment as a run record shown and editable on the card,
   ⟳ renews it. Then the same choice on the family nodes (`resolveDatasetId`,
   `CaveSource.listOne`), advanced.
3. Readers: neuron table, synapses, table listing, the annotations chain, root drift.
4. Refusals where live cannot answer (connection view, views as Table Info targets, R export).
5. Docs: `backends-cave.md`, the node's help page, this file's status.
