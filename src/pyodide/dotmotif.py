"""DotMotif's GrandIso executor on a keyed Coda network, in the cancellable Python worker.

Adapts the request and refuses what the pinned parser or executor would otherwise misread.
"""

import array
import ast
import gc
import math
from importlib.metadata import version

import networkx as nx
from lark import Token
from dotmotif import Motif
from dotmotif.executors import GrandIsoExecutor
from dotmotif.parsers import v2 as _dotmotif_parser
from dotmotif.validators import (
    DisagreeingEdgesValidator,
    ImpossibleConstraintValidator,
    Validator,
)


def _dotmotif_literal(token):
    """Interpret DSL scalars without DotMotif's general Python eval hook.

    The parser calls this hook only on value tokens. Bare words remain strings;
    quoted strings, numbers, True/False and None retain their Python meanings.
    DotMotif is used only by this module in Coda's worker, so replacing its token
    hook cannot change another capability's parsing.
    """
    # Macro expansion passes an already-decoded scalar through this hook a
    # second time. In particular, quoted "1" must remain a string then.
    if not isinstance(token, Token):
        return token
    text = str(token)
    try:
        value = ast.literal_eval(text)
    except (ValueError, SyntaxError):
        value = text
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError("DotMotif values must be finite numbers.")
    return value


_dotmotif_parser.untype_string = _dotmotif_literal

# The rebinding above takes only while the parser looks `untype_string` up as a module global,
# which is how 0.19.0 imports it. An upgrade that reaches it any other way brings `eval` back for
# query text that can arrive in a share link, and nothing else would say so: refuse to load
# instead. The version is checked because every override below is written against 0.19.0 too.
_DOTMOTIF_VERSION = "0.19.0"
if version("dotmotif") != _DOTMOTIF_VERSION:
    raise ImportError(f"Coda's DotMotif adapter is written for {_DOTMOTIF_VERSION}, not {version('dotmotif')}.")
if Motif("A -> B\nA.x = abs\n").list_node_constraints()["A"]["x"]["="] != ["abs"]:
    raise ImportError("DotMotif's value parser still evaluates Python; the eval guard did not take.")


class _CodaParser(_dotmotif_parser.ParserV2):
    """Reject ambiguous/incorrect upstream constructs on the actual parse tree."""

    def parse(self, text):
        tree = _dotmotif_parser.dm_parser.parse(text)
        macros = list(tree.find_data("macro"))
        for macro in macros:
            if any(macro.find_data("macro_call_re")):
                raise ValueError("Nested macros are not supported; expand the inner macro in the query.")
            if any(len(rule.children) == 5 for rule in macro.find_data("macro_node_constraint")):
                raise ValueError("Dynamic comparisons inside macros are not supported; place the comparison after the macro call.")

        def variable(tree):
            return str(tree.children[0])

        symmetry_roles = set()
        for declaration in tree.find_data("automorphism_notation"):
            roles = {variable(child) for child in declaration.children}
            if symmetry_roles & roles:
                raise ValueError("Overlapping === groups are not supported; write the constraints explicitly.")
            symmetry_roles.update(roles)

        def aliases(definitions):
            names = [variable(edge.children[-1]) for edge in definitions]
            if len(names) != len(set(names)):
                raise ValueError("Named edge aliases must be unique within their scope.")
            return set(names)

        top_aliases = aliases(tree.find_data("named_edge"))
        for macro in macros:
            names = aliases(macro.find_data("named_edge_macro"))
            roles = set()
            for kind in ("edge_macro", "named_edge_macro"):
                for edge in macro.find_data(kind):
                    roles.update((variable(edge.children[0]), variable(edge.children[2])))
            if names & roles:
                raise ValueError("Named edge aliases must not share a node's name.")
            # The upstream expander checks global edge aliases before mapping
            # macro arguments; a collision would attach a local node constraint
            # to that unrelated edge instead.
            if top_aliases & roles:
                raise ValueError("Named edge aliases must not share a macro parameter's name.")
        try:
            parsed = _dotmotif_parser.DotMotifTransformer(validators=self.validators).transform(tree)
        except KeyError as error:
            raise ValueError(f"Invalid DotMotif entity: {error.args[0]}") from None
        if top_aliases & set(parsed[0].nodes):
            raise ValueError("Named edge aliases must not share a node's name.")
        return parsed


class _UniqueMotifEdges(Validator):
    def validate(self, graph, source, target, type=None, exists=True):
        # Upstream returns early for repeated declarations, losing attributes
        # from the later line. A validator runs before that early return.
        if graph.has_edge(source, target):
            raise ValueError(
                f"Declare motif edge {source} -> {target} only once; "
                "put its constraints on that declaration or a named edge."
            )
        return True


class _CodaGrandIsoExecutor(GrandIsoExecutor):
    def _validate_dynamic_node_constraints(self, mapping, graph, constraints):
        # Static comparisons already treat incompatible/missing values as a
        # non-match. Apply the same rule to a dynamic comparison, e.g. a null
        # size on one node compared with a numeric size on another.
        try:
            return super()._validate_dynamic_node_constraints(mapping, graph, constraints)
        except TypeError:
            return False


def _referenced(motif):
    """The node and edge attributes a query reads: the only columns worth copying into the graph."""
    nodes, edges = set(), set()
    for constraints in motif.list_node_constraints().values():
        nodes.update(constraints)
    for constraints in motif.list_dynamic_node_constraints().values():
        for name, operators in constraints.items():
            nodes.add(name)
            for comparisons in operators.values():
                nodes.update(other for _, other in comparisons)
    for constraints in motif.list_edge_constraints().values():
        edges.update(constraints)
    return nodes, edges


def _dotmotif_graph(request, motif):
    """The host graph, carrying only the attributes the query reads.

    Construction only: `dotmotifHost` has refused what is not a simple graph and sorted the links,
    and nodes and links go in in the order given (see its header for why the order matters).
    """
    key_of_row = request.keyOfRow.to_py()
    node_names, edge_names = _referenced(motif)
    graph = nx.DiGraph() if request.directed else nx.Graph()
    graph.add_nodes_from(range(len(key_of_row)))
    nodes, edges = request.nodes.as_py_json(), request.edges.as_py_json()
    for name in node_names & set(nodes):
        for row, value in enumerate(nodes[name].to_py()):
            graph.nodes[key_of_row[row]][name] = value
    links = zip(request.sources.to_py(), request.targets.to_py())
    columns = {name: edges[name].to_py() for name in edge_names & set(edges)}
    if columns:
        rows = request.linkRows.to_py()
        links = (
            (s, t, {name: values[row] for name, values in columns.items()})
            for (s, t), row in zip(links, rows)
        )
    # Millions of acyclic dicts and tuples: every collection the build would trigger finds nothing.
    # Measured at 2M links, about a third off natively and 8% (3.9 s to 3.6 s) in Pyodide.
    gc.disable()
    try:
        graph.add_edges_from(links)
    finally:
        gc.enable()
    return graph


def _dotmotif_motif(query, directed):
    if not query.strip():
        raise ValueError("Enter a DotMotif query.")
    # Motif treats a single line as a potential filesystem path. Force text
    # parsing even when a supplied query happens to name an existing file.
    motif = Motif(
        query + "\n",
        # GrandIso chooses the motif graph's direction from this flag. Set it
        # explicitly to match Coda's host graph, including undirected inputs.
        ignore_direction=not directed,
        enforce_inequality=True,
        exclude_automorphisms=False,
        parser=_CodaParser,
        # `_UniqueMotifEdges` refuses everything `DisagreeingEdgesValidator` does; the latter runs
        # first for its message, which says what `A -> B; A !> B` actually got wrong.
        validators=[DisagreeingEdgesValidator(), ImpossibleConstraintValidator(), _UniqueMotifEdges()],
    )
    graph = motif.to_nx()
    edge_constraints = motif.list_edge_constraints()
    if not graph:
        raise ValueError("A DotMotif query must declare at least one edge (present or absent).")
    for source, target, attrs in graph.edges(data=True):
        if attrs["exists"] and source == target:
            raise ValueError("Required self-loop edges are not supported by GrandIso.")
        if attrs["action"] != "SYN":
            raise ValueError("Typed edges (-+, -|, --) are not supported; use -> with an attribute constraint.")
        if not attrs["exists"] and edge_constraints.get((source, target)):
            raise ValueError("Absent edges (!> or ~>) cannot have attribute constraints.")
    if motif.list_dynamic_edge_constraints():
        raise ValueError("Comparisons between two edge attributes are not supported; use fixed edge constraints.")
    for source, constraints in motif.list_dynamic_node_constraints().items():
        for operators in constraints.values():
            for comparisons in operators.values():
                for target, _ in comparisons:
                    if target not in graph:
                        raise ValueError(f"Node {target} in a dynamic constraint has no motif edge.")
    for source, target in motif.list_automorphisms():
        if source not in graph or target not in graph:
            raise ValueError("Every node in an === declaration must have a motif edge.")
    # GrandIso traverses a connected positive-edge backbone. Negative edges
    # filter its matches; they cannot introduce an otherwise unconnected role.
    positive = nx.Graph()
    positive.add_nodes_from(graph.nodes)
    positive.add_edges_from((u, v) for u, v, attrs in graph.edges(data=True) if attrs["exists"])
    if not positive.number_of_edges() or not nx.is_connected(positive):
        raise ValueError("GrandIso requires every motif variable to be connected by required edges (->).")
    return motif, sorted(graph.nodes)


def coda_dotmotif_run(request, report=None):
    motif, roles = _dotmotif_motif(request.query, request.directed)
    # Only the parse knows the role count, and a match costs more the more it has: past what
    # `Max matches` can afford at this count, stop before building anything. The node words it.
    if len(roles) > request.maxRoles:
        return {"count": 0, "roles": roles, "keys": array.array("i"), "refused": True}
    graph = _dotmotif_graph(request, motif)
    if report is not None:
        report(0.2, f"searching {len(graph):,} nodes and {graph.number_of_edges():,} edges")
    limit = int(request.maxMatches)
    matches = _CodaGrandIsoExecutor(graph=graph).find(motif, limit=limit)
    keys = array.array("i")
    for mapping in matches:
        keys.extend(mapping[role] for role in roles)
    if report is not None:
        report(1, f"{len(matches):,} matches" + (" (limit reached)" if len(matches) == limit else ""))
    return {"count": len(matches), "roles": roles, "keys": keys}
