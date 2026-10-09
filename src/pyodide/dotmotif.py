"""DotMotif on a materialized Coda network, inside the cancellable Python worker.

Use DotMotif's GrandIso executor for local motif search, stopping at the requested
number of accepted matches. Required edges must connect all motif variables and
cannot be self-loops. This module adapts inputs and rejects unsupported semantics;
it does not implement a second matcher or fall back to NetworkX search. Extra
host edges are allowed unless explicitly forbidden.
"""

import ast
import math

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


def _dotmotif_id(value):
    """Match JavaScript String for the identifiers that can round-trip exactly."""
    if isinstance(value, str):
        if not value:
            raise ValueError("Network IDs and edge endpoints must not be empty.")
        return value
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        if math.isfinite(value) and int(value) == value and abs(value) <= 9007199254740991:
            return str(int(value))
        raise ValueError("Numeric network IDs must be safe integers; supply wide IDs as strings.")
    raise ValueError("Network IDs and edge endpoints must not be null.")


def _dotmotif_table(columns, required, name):
    if not isinstance(columns, dict) or any(key not in columns for key in required):
        raise ValueError(f"The network {name} table needs {', '.join(required)} columns.")
    length = len(columns[required[0]])
    if any(not isinstance(values, list) or len(values) != length for values in columns.values()):
        raise ValueError(f"The network {name} columns must have equal lengths.")
    return length


def _dotmotif_graph(req):
    nodes, edges = req["nodes"], req["edges"]
    node_count = _dotmotif_table(nodes, ("id",), "node")
    edge_count = _dotmotif_table(edges, ("source", "target"), "edge")
    ids = [_dotmotif_id(value) for value in nodes["id"]]
    if len(set(ids)) != node_count:
        raise ValueError("Network node IDs must be unique after converting them to strings.")
    graph = nx.DiGraph() if req["directed"] else nx.Graph()
    display_ids = sorted(ids)
    key_of = {node_id: key for key, node_id in enumerate(display_ids)}
    # GrandIso intersects sets of host keys. Sorted *string* insertion alone
    # is not deterministic across Python hash seeds; integer ranks are. Raw
    # id/source/target attribute cells retain their original values below.
    for row in sorted(range(node_count), key=lambda row: ids[row]):
        key = key_of[ids[row]]
        graph.add_node(key)
        graph.nodes[key].update({name: values[row] for name, values in nodes.items()})
    pairs = set()
    records = []
    for row in range(edge_count):
        source, target = _dotmotif_id(edges["source"][row]), _dotmotif_id(edges["target"][row])
        if source not in key_of or target not in key_of:
            raise ValueError("Every edge endpoint must have a row in the network node table.")
        pair = (source, target) if req["directed"] else tuple(sorted((source, target)))
        if pair in pairs:
            raise ValueError("DotMotif requires one edge per node pair; aggregate parallel edges first.")
        pairs.add(pair)
        records.append((pair, source, target, row))
    for _, source, target, row in sorted(records):
        # Keep id/source/target as attributes too; their raw cells need not be
        # strings even though the returned membership IDs always are.
        source_key, target_key = key_of[source], key_of[target]
        graph.add_edge(source_key, target_key)
        graph[source_key][target_key].update({key: values[row] for key, values in edges.items()})
    return graph, display_ids


def _dotmotif_motif(query, directed):
    if not isinstance(query, str) or not query.strip():
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
        validators=[DisagreeingEdgesValidator(), ImpossibleConstraintValidator(), _UniqueMotifEdges()],
    )
    graph = motif.to_nx()
    if not graph:
        raise ValueError("A DotMotif query must declare at least one edge (present or absent).")
    for source, target, attrs in graph.edges(data=True):
        if attrs["exists"] and source == target:
            raise ValueError("Required self-loop edges are not supported by GrandIso.")
        if attrs["action"] != "SYN":
            raise ValueError("Typed edges (-+, -|, --) are not supported; use -> with an attribute constraint.")
        if not attrs["exists"] and motif.list_edge_constraints().get((source, target)):
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
    return motif


def coda_dotmotif_run(request, report=None):
    req = request.to_py() if hasattr(request, "to_py") else request
    limit = req["maxMatches"]
    if isinstance(limit, bool) or not isinstance(limit, (int, float)) or not math.isfinite(limit) or int(limit) != limit or limit < 1:
        raise ValueError("Maximum matches must be a positive integer.")
    if not isinstance(req["directed"], bool):
        raise ValueError("Network directedness must be a boolean.")
    motif = _dotmotif_motif(req["query"], req["directed"])
    graph, display_ids = _dotmotif_graph(req)
    if report is not None:
        report(0.2, f"searching {len(graph):,} nodes and {graph.number_of_edges():,} edges")
    matches = _CodaGrandIsoExecutor(graph=graph).find(motif, limit=int(limit))
    roles = sorted(motif.to_nx().nodes)
    result = {"matchId": [], "variable": [], "nodeId": [], "count": len(matches), "limitReached": len(matches) == limit}
    for number, mapping in enumerate(matches, start=1):
        for role in roles:
            result["matchId"].append(number)
            result["variable"].append(role)
            result["nodeId"].append(display_ids[mapping[role]])
    if report is not None:
        report(1, f"{len(matches):,} matches" + (" (limit reached)" if result["limitReached"] else ""))
    return result
