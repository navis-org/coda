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

The adapter uses DotMotif 0.19.0's `GrandIsoExecutor` with GrandIso 2.2.0, prioritizing
search performance for connected motifs, with no NetworkX search fallback. What that executor
cannot search is refused; the [node help](../src/help/nodes/net.dotmotif.md) lists it.

The input is a simple directed or undirected graph, and **Python never sees an id**.
`dotmotifHost` (`src/nodes/lib/dotmotifHost.ts`) reads the ids by `networkOps`' own rule,
`String(cell ?? '')`, and turns every node and link end into an integer key: the node's rank in
id order. Python builds the graph on those keys and returns keys; the node names them. One rule
for an id is the point — `induceSubnetwork` reads ids by the same rule to build the union, and
an earlier Python copy of it had already drifted (it refused null and very large numeric ids
that `String` accepts). The same module refuses, **before Pyodide is booted for it**, everything
that is not a simple graph: an empty or missing id, a repeated id, a link naming a node that is
not in the table, and parallel links — those with a pointer to `Merge parallel links` upstream,
rather than one link's attributes silently overwriting the other's.

Only the attributes the query names are copied into the graph, and narrowed twice. The node
clones to the worker only the columns whose name appears in the query text (`queriedColumns`),
a superset of what it reads, since an attribute has to be written to be read. Python then parses
the motif first, takes the columns its static, dynamic and edge constraints actually list, and
converts just those out of the request (`as_py_json()`, a column at a time). The default
triangle reads none, so nothing but the keys crosses.

Each motif variable receives a distinct host node. Extra host edges are permitted unless
forbidden by the query, and different role assignments on the same node set remain separate
matches. Nodes go into the graph in key order and links in pair order — GrandIso walks both in
insertion order — so a bounded prefix depends on the network rather than on the order its rows
arrived in, and integer keys mean Python's per-process string hashes cannot change it between
worker restarts. `dotmotifHost` does the pair sort, two stable counting passes, which also puts
any parallel link beside its twin for the refusal; Python inserts the links as they come and
reads their attributes through `linkRows`.

The adapter rejects known unsupported syntax rather than silently discarding its meaning: nested
macros and dynamic comparisons inside macros are refused because the pinned parser can
substitute the wrong role. The real-runtime probe is the executable contract.

**Query text is never evaluated as Python, and the module checks that.** A trailing newline
stops DotMotif reading a one-line query as a file name, and scalars go through a literal
conversion rather than upstream 0.19.0's `untype_string`, which is `eval`. That is a
monkey-patch, working only because `parsers/v2` imports the function by name. An upgrade that
reached it any other way would bring `eval` back for query text that can arrive in a share link,
with nothing to say so. So `dotmotif.py` refuses to load unless the installed DotMotif is the
pinned version and a bare `abs` parses as the string `"abs"` rather than the builtin — checked
by loading the module with the patch line removed, which refuses.

## Results and limits

`Matches` is a long table with fixed columns: `matchId` (`i64`, starting at 1 for the run),
`variable` (`str`) and `nodeId` (`str`). The schema is known before parsing or executing a
query, so downstream pickers can be configured immediately. Its row count is the number of
returned matches times the number of motif variables.

`Induced union` keeps every matched node and every input edge with both endpoints in that
set. It can contain edges between separate occurrences. `induceSubnetwork` preserves the
attribute schemas and recomputes Build Network's existing degree/weight rollups; the match
table, not this union graph, preserves occurrence membership.

`Max matches` is passed into the executor, so search stops at that many accepted assignments.
There is no extra search for match N+1, which is why reaching N says only that there **may** be
more, and no timeout hidden in the node. Cancel uses the existing worker termination path, and a
later run boots a new worker.

**It is also capped, and the cap is priced per role.** GrandIso holds every match as a Python
dict until the search ends: measured in Pyodide at 1M matches as 225, 293 and 374 bytes for 3, 6
and 10 roles (4M three-role matches added 667 MB), plus 24 bytes a row for the table built
afterwards, a row per role. `maxMatchesIssue` prices a match at 192 + 48 per role. Only the parse
knows the role count, so the card and the Run's first check assume the fewest, two, which caps the
field at 1,864,135; the worker then compares the parsed count against `maxRolesFor(maxMatches)`
and, past it, returns the count instead of searching, and the node throws the same sentence with
the real number of roles.

## Loading and portability

Only the first DotMotif call loads its four pure-Python dependencies: DotMotif, GrandIso,
NetworkX and Lark. DotMotif 0.19.0 is a GitHub release and GrandIso publishes only a source
archive, so those two wheels are served from `public/wheels/`; the
[README there](../public/wheels/README.md) records where each came from, its hash and how to
rebuild it.

They are a `MODULES` field of their own, `wheels`, resolved against the site root `engine.ts`
sends the worker once, on creation (`types.ts` says why the worker cannot work it out). An
earlier `packageUrls` worked it out in the worker from the runtime's own URL, one or two
directories up depending on dev or build, which held only while Vite kept that layout.

## Verification and export

The real GrandIso Pyodide probe found all 998 two-edge paths in a 1,000-node directed chain in
24 ms, after about 1.9 seconds for the first runtime/package/import setup, using a 43 MB
WASM heap. This small sparse fixture verifies the plumbing; it is not a performance bound
for arbitrary motifs, dense graphs or unsuccessful searches.

**The graph build, before any search, measured in Pyodide 314.0.5 under Node** on random
directed networks of 100,000 nodes with four node and three edge attribute columns, a query
reading one of each:

| | first version | keys + named columns | links presorted, now |
| --- | --- | --- | --- |
| 1M edges, build | 8.0 s, +521 MB heap | 2.8 s, +344 MB | 1.9 s, +286 MB |
| 2M edges, build | 16.9 s, +1,002 MB heap | 5.8 s, +610 MB | 3.6 s, +521 MB |
| 2M edges, `dotmotifHost` on the main thread | — | 0.64 s | 0.22 s |

The first version converted the whole request with `to_py()`, re-derived every id in Python,
sorted string tuples and copied every column onto every node and link. The second still sorted
the links in Python by a list of pair codes, while `dotmotifHost` checked for parallel links
with a `Set` of the same codes — one rule, written twice, in two languages. The heap matters more
than the seconds: a wasm memory never shrinks, so it stays taken until the worker is stopped.
The search is not in that table, and it is where `Max matches` stops helping. On the 1M-edge
network with no attribute columns, the whole call took **2.4 s** for a two-hop chain capped at
1,000 matches, and **12.3 s** for the feed-forward triangle — which found only 961, so reaching
the cap was never possible and the search had to exhaust the graph to say so. That is what the
help means by limiting matches and not search time.

`scripts/probe-dotmotif.mjs` is the contract for the Python half, run in CI by
`.github/workflows/pyodide.yml`. It imports `dotmotifHost.ts` itself — plain Node 26 strips its
types, and the file has no imports for exactly this — so it encodes requests and decodes replies
(`matchColumns`) with the node's own code.

Both exports leave the step as a TODO; `dotmotifPlan` (`src/export/plans/analysis.ts`) says why.
