# DotMotif: search a materialized network locally

`net.dotmotif`, **Add ▸ Analysis ▸ DotMotif**, accepts a `NetworkValue` and searches its
topology and attribute tables in the existing Pyodide worker. It is an `expensive` node,
using Coda's normal Run and Auto-run controls. Disable Auto-run when editing a costly query.
The input graph and query remain in the browser.

## Why local execution

The unit of analysis is the network on the wire: it may be an uploaded edge list, a filtered
part of a connectome, or a graph aggregated by cell type. Searching a service's original
dataset instead would answer a different question. This matters especially for absent-edge
constraints: a connection removed upstream is absent from the searched graph.

MotifStudio can accept arbitrary graphs; this is not a decision based on a missing API.
The inspected [upload endpoint](https://github.com/aplbrain/motifstudio/blob/67ffc5ef21c1619376bc6db04ad5dda6ebab6964/server/src/server/routers/uploads.py)
accepts GraphML, GEXF, GML and CSV, with a 100 MiB limit, and returns a temporary host ID.
Its [temporary provider](https://github.com/aplbrain/motifstudio/blob/67ffc5ef21c1619376bc6db04ad5dda6ebab6964/server/src/host_provider/host_provider/temporary_graph_host_provider.py)
retains uploads for 14 days by default. Faithfully exporting a Coda network would require a
format carrying direction, node attributes and edge attributes; its CSV reader constructs an
undirected graph and does not carry the node table.

Remote execution would therefore add graph serialization, upload consent, temporary-host
lifetime and cleanup, cache invalidation when an upstream value changes, and a compute-service
dependency. The inspected [NetworkX host provider](https://github.com/aplbrain/motifstudio/blob/67ffc5ef21c1619376bc6db04ad5dda6ebab6964/server/src/host_provider/host_provider/host_provider.py)
also computes every result before applying the requested return limit. Coda already has the
worker, runtime reuse, progress, errors and cancellation needed for a local search.

A remote node could still be useful for a graph already hosted by that service, or for
workloads shown to exceed browser resources. That would be an explicit source/query boundary,
with the service's graph identity and lifecycle visible in the workflow. It is not an
automatic fallback that uploads the current network.

## Matching semantics

The adapter uses DotMotif 0.19.0's `NetworkXExecutor`. Probes of the pinned GrandIso executor
found wrong or missing answers for negative-only variables, disconnected patterns,
undirected networks and self-loops. Correctness on those cases determines the choice here;
this is not a claim that NetworkX is the faster implementation.

The input is a simple directed or undirected graph. Node and edge attributes retain their
cell values, and returned node IDs are strings, including wide integer-looking IDs. Parallel
endpoint pairs are refused, rather than silently overwriting attributes; users can choose
`Merge parallel links` upstream. Duplicate or missing node IDs and dangling edges also fail
explicitly.

Each motif variable receives a distinct host node. Extra host edges are permitted unless
forbidden by the query, and different role assignments on the same node set remain separate
matches. Stable internal integer keys are mapped back to the original IDs, so Python's
per-process string hashes cannot change a bounded result prefix between worker restarts.
The adapter rejects known unsupported syntax rather than silently discarding its meaning.
Direct macros support topology and static constraints; nested macros and dynamic comparisons
inside macros are refused because the pinned parser can substitute the wrong role. The
[node help](../src/help/nodes/net.dotmotif.md) describes the supported surface; the
real-runtime probe is the executable contract.

User text is parsed as DotMotif. A trailing newline disables DotMotif's single-line filename
interpretation, and the scalar parser uses literal conversion instead of general Python
evaluation. Query text is never passed to `runPython` as source.

## Results and limits

`Matches` is a long table with fixed columns: `matchId` (`i64`, starting at 1 for the run),
`variable` (`str`) and `nodeId` (`str`). The schema is known before parsing or executing a
query, so downstream pickers can be configured immediately. Its row count is the number of
returned matches times the number of motif variables.

`Induced union` keeps every matched node and every input edge with both endpoints in that
set. It can contain edges between separate occurrences. `induceSubnetwork` preserves the
attribute schemas and recomputes Build Network's existing degree/weight rollups; the match
table, not this union graph, preserves occurrence membership.

`Max matches` is a positive integer, default 1,000. It is passed into the executor so search
stops at that many accepted assignments. There is no extra search for match N+1, no exhaustive
count, and no claim that the first results are representative or strongest. Reaching N means
there **may** be more. This bounds returned matches, not search time: proving an absence may
still require a long search. There is no timeout hidden in the node. Cancel uses the existing
worker termination path, and a later run boots a new worker.

## Loading and portability

The worker and runtime remain lazy. Only the first DotMotif call loads its four pure-Python
dependencies, pinned in `src/pyodide/sources.json`: DotMotif, GrandIso, NetworkX and Lark.
GrandIso is imported by DotMotif even though it is not the selected executor. Direct wheel
loading avoids optional plotting and ingest dependencies.

DotMotif's official 0.19.0 wheel and a GrandIso wheel built with pinned tools are served from
`public/wheels`; [the manifest and build instructions](../public/wheels/README.md) record
upstream locations, versions, hashes and licenses. DotMotif 0.19.0 is a GitHub release, not a
PyPI release. NetworkX and Lark use pinned PyPI wheel URLs. The existing Pyodide runtime still
comes from its pinned CDN, so first use requires those downloads.

`packageUrls` resolves vendored wheels from the app directory, including a deployment under
`/coda/`. Vite serves the runtime under `src/pyodide/` in development and bundles it into
`assets/` in production. Resolving against the origin alone would silently lose the deployment
prefix; tests cover both directory layouts at the origin root and under a prefix.

## Verification and export

The real Pyodide probe found all 998 two-edge paths in a 1,000-node directed chain in
63 ms, after about 3.1 seconds for the first runtime/package/import setup, using a 36 MB
WASM heap. This small sparse fixture verifies the plumbing; it is not a performance bound
for arbitrary motifs, dense graphs or unsuccessful searches.

Browser verification covered a complete workflow from the built-in mock dataset through
Build Network, DotMotif, Table and Network Viewer (398 nodes, 3,348 edges). The result cap
produced the expected membership rows and warning, and the induced union rendered. A costly
no-result query was cancelled, then a subsequent attributed query completed after the worker
restarted. The production bundle was also served under `/coda/`; both vendored wheels loaded
from `/coda/wheels/` and the full workflow completed. The checked runs had no console errors.

- `scripts/probe-dotmotif.mjs` runs the actual adapter and pinned wheels in Pyodide, checks
  artifact hashes and dependency loading, and exercises topology, constraints, IDs, limits,
  invalid inputs and result transport. `.github/workflows/pyodide.yml` runs it in CI.
- `src/pyodide/dotmotif.test.ts` checks the typed worker seam, including malformed responses
  and cancellation propagation. `packageUrls.test.ts` covers deployment paths.
- `src/nodes/analysis/dotmotif.test.ts` checks schema inference, original-table preservation,
  empty results, induced-union behavior and limit warnings.
- Help and exporter registry tests check integration; `src/export/dotmotif.test.ts` verifies
  preserved query text and propagation of the explicit export gap through both outputs.

Notebook and R Markdown exports leave this step as a TODO. Existing Network export code does
not yet preserve all Coda edge attributes and string-ID semantics, so simply emitting a
DotMotif call could produce different answers. The TODO names the required release and keeps
the exact query and limit; users can download the browser's match table directly. A faithful
export remains separate work.
