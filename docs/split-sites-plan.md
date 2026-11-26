# Split sites: where two points were wrongly joined

**Status (2026-11-22): tabled, machinery kept.** Waiting on an improved SEAM false-merge model to
rank candidate sites on Aedes. No UI yet. Server facts are in
[backends-cave.md](backends-cave.md#the-supervoxel-graph-and-the-split-preview-subgraphts-measured-2026-11-22).

## What it does

Given a neuron and two points (e.g. two somas), it points to where the neuron should be cut so the
points come apart. It works from the chunkedgraph's own supervoxel graph — `subgraph`, which
carries each edge's summed affinity and contact area on pychunkedgraph 2.x (FANC, Aedes, MICrONS,
H01; **not FlyWire**, whose 1.27 publishes no affinities).

- `src/data/cave/subgraph.ts` — the reader (ids as text; the bare `Infinity` is read by `json.ts`),
  `isUserMerge`, `readSubgraphBoxes`, `unionOf`.
- `src/packs/seam/splitSites.ts` — pure:
  - `splitSites`: the mean-affinity agglomeration replayed twice. **Constrained** (a source region
    never merges with a sink region) gives one separating `cut`; **unconstrained** gives
    `candidates`, the steps on either point's way up that join two regions of ≥ `minPiece`
    supervoxels, weakest first.
  - `pathCuts` (experimental): a constrained cut in every window along the path.
  - `contactRatio` (experimental): cut area over what the cut's supervoxels touch on their own side.
  - `weakJoins` (experimental, never run live): the same for a whole neuron with no points.
- `src/packs/seam/splitSitesRun.ts` — `readSplitGraph` (reads, once) then `cutSplitGraph` (any
  number of cuts on one read; `placeCuts` positions them). The reads: the root's level-2 graph at the root's own time
  (past roots work), the supervoxel under each point, the shortest level-2 path, `subgraph` in
  overlapping runs of chunks along it (`readSubgraphBoxes`), the points' level-2 pieces as seeds, positions from
  the L2 cache.

Probes (reads only): `pnpm probe:split-sites` (two points, or `--operation ID` to test against a
past split; `--json` feeds the inspection page), `pnpm probe:scan-neuron` (whole neuron).

## What was measured

- **Cost:** 2–5 s for points ~30 µm apart on FANC; 10–17 s for Aedes soma pairs (70–146 path
  chunks). The agglomeration itself is under 0.5 s; the rest is reads.
- **FANC, nine past splits, points 15 µm either side:** candidates right at rank 1 in 4, top 3 in
  7. The two misses were, on review, a wrong user split (165056) and a larger local segmentation
  problem (255285). The single constrained cut alone: 3 of 9.
- **Aedes, four soma-pair roots:** mostly not. False merges there are often moderate-to-strong
  contacts (mean affinity 0.37–0.89, including a large pressed-together face of ~20k area on
  648518347672268769, true site at voxel 29961, 14246, 3283), while real weak contacts (one at
  0.12) look exactly like false merges. `pathCuts` does produce a cut at the true sites the
  candidates miss, but neither mean affinity nor `contactRatio` ranks them reliably (true site
  #1–#64 depending on root and score).

## Settled along the way

- CAVE's own min-cut cuts the thinnest neck near a point and undoes proofreader merges first
  (fake edges have affinity ~0). Not used.
- A point on a small, weakly attached piece defeats the constrained cut; seeding each side with the
  point's level-2 piece fixed most of that.
- Proofreader merges that reused a real stored edge look like weak false merges and crowd the list
  on proofread roots; "trust" only recognises zero-area fake edges. Fix not built: read the root's
  merge history and trust the edges those merges added.
- Inspection page for the FANC cases: https://claude.ai/artifact/H3BgWxHxHBR92fdBR31Y5V

## Next, when SEAM's model lands

Use the path scan and the candidates as *where to look*, and the model to rank them. Then the
merge-history fix, then a UI.
