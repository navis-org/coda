## Search the network on the wire

Build or filter a network before searching it. DotMotif sees its node and edge attribute
tables, including any filtering and aggregation already applied upstream. It does not search
the original dataset for connections that are missing from that network.

```coda-graph
caption: Find motifs and inspect their nodes
net.build as build
net.dotmotif as motif
out.table as matches
out.network as network
build:network -> motif:in
motif:matches -> matches:in
motif:network -> network:in
```

The search uses GrandIso in your browser when you press **Run**. Its first use downloads the
Python runtime and search packages; your graph and query are not uploaded to a compute service.
**Cancel** stops the search. A large network or a hard query can take a long time even when
you request few matches.

## Write a pattern

This feed-forward pattern requires three different nodes with the indicated connections:

```text
A -> B
B -> C
A -> C
```

Variables name roles, not node IDs. Every role is assigned a distinct node. A match can have
additional connections unless the query explicitly forbids them. For example, a two-hop
chain without the shortcut is:

```text
A -> B
B -> C
A !> C
```

> [!WARNING] An absent edge is absent from this network
> Filtering out a weak connection makes it absent for `!>`, even if it exists in the original
> connectome. Choose upstream weight thresholds with that meaning in mind.

Constraints use the attribute names on the network, such as `weight` on links and the
columns joined through [Build Network](#net.build)'s `Node attrs` input:

```text
A -> B [weight >= 5]
A.type = "LC4"
```

Build Network renames the selected weight column to `weight`. Joined node attributes keep
their names. Inspect those tables when a constraint returns no matches.

Parallel links are refused: enable `Merge parallel links` in Build Network first. That
setting sums weights; other edge attributes survive only when their merged values agree.

### Supported queries

Directed and undirected networks are supported. On an undirected network, arrows test
adjacency without imposing a direction. Required edges (`->`) must connect every variable.
Disconnected patterns, variables appearing only in negative edges, and required self-loops
(`A -> A`) are not supported and produce an error. Forbidden edges between connected roles
still work, including `A !> A` to exclude a self-loop. There is no slower-executor fallback.

You can use node and edge attribute constraints, named edges with static constraints, and
comparisons between node attributes. Direct macros may contain topology and static
constraints; nested macros and dynamic comparisons inside macros are refused. Put comparisons
between node attributes outside the macro, using the final role names.

This node also refuses edge-to-edge attribute comparisons, attributes on negative edges,
typed relations such as `-+` and `-|`, and repeated declarations of the same directed pattern
edge. Edge aliases must be unique within their scope and cannot share a name with a node role.
Overlapping `===` groups are refused; write their constraints explicitly instead. These checks
prevent query clauses from being ignored or applied to another entity. Use `->` for an edge
and `!>` for a forbidden edge.

## Read the results

`Matches` has one row per variable in each returned match:

| matchId | variable | nodeId |
| --- | --- | --- |
| 1 | A | 1001 |
| 1 | B | 1002 |
| 1 | C | 1003 |
| 2 | A | 1001 |
| 2 | B | 1004 |
| 2 | C | 1003 |

`matchId` starts at 1 for this run. `nodeId` is text, including IDs that look numeric. Filter
on `matchId` to inspect one occurrence, or on `variable` to collect nodes serving a role.
Different assignments of roles to the same set of nodes are separate matches; the table
does not deduplicate them into unique node sets.

`Induced union` contains the union of all returned nodes and every input edge whose ends
are in that union. This includes connections between different occurrences and connections
the query did not require. Use the table to recover which nodes belonged to each occurrence;
the network alone does not retain that grouping.

```coda-params
net.dotmotif: maxMatches
```

`Max matches` limits occurrences, not table rows. A three-role query can return three times
that many rows. Reaching the limit does not establish the total number of matches, and the
first matches are not a random sample or a ranking by strength.

## Exporting the workflow

Jupyter and R Markdown exports leave this step as an explicit TODO, preserving the query and
match limit. Download the `Matches` table to use the browser's result elsewhere. Reproducing
the search outside Coda requires the same attributed network and matching semantics.
