/**
 * Explore, and the search language behind it.
 *
 * The node holds a dataset's whole neuron table and searches it locally, which is why the
 * query language has no server semantics to inherit and had to be ported rather than
 * translated into criteria. `coda_search` is that port, and it is deliberately **matching
 * only** — the five-tier ranking and the fuzzy fallback are not reproduced, and the two places
 * that costs something are stated where they cost it rather than in a comment nobody reads.
 */

import { pyStr } from '../py'
import { registerEmitter, registerHelper } from '../registry'
import { caveLabels, codaNeurons, isCaveDataset, pySelection, selectionIds } from './common'

/**
 * Explore, on either backend.
 *
 * The node is a whole neuron table plus a local search, and **only the first half is
 * backend-specific**: `coda_search` is a port of Coda's own matcher and does not care where the
 * frame came from. So the CAVE branch is one line — the datastack's index, which
 * `CodaCaveDataset.labels` already builds for exactly this — rather than a second emitter.
 *
 * That also makes it the cheapest CAVE query node there is, which is why it is the first one
 * written: on a FlyWire graph it is usually the *only* thing between the dataset and everything
 * else, so a TODO here blocked the whole notebook.
 */
registerEmitter(
  'neuron.explore',
  (ctx) => {
    const c = ctx.wired('dataset')
    const cave = isCaveDataset(ctx)

    const all = ctx.output('all')
    const hits = ctx.output('hits')
    const selected = ctx.output('selected')

    const query = String(ctx.params.query ?? '').trim()
    const limit = Number(ctx.params.limit ?? 0)
    const selection = selectionIds(ctx)

    // `All` is the index handed on unchanged, and it is the download every other port is sliced
    // out of — one read rather than one per port.
    const lines: string[] = cave
      ? [
          ...ctx.note(
            'Explore Dataset searches the whole neuron table locally. This is the datastack\u2019s own ' +
              'index — its neuron table joined to its annotations, or whatever is wired to the ' +
              'Dataset\u2019s Annotations socket — fetched the first time anything asks for it. ' +
              'On FlyWire that is 139,255 rows and takes a few seconds.',
          ),
          `${all} = ${caveLabels(c)}`,
        ]
      : [
          ...ctx.note(
            'Explore Dataset downloads the whole neuron table once and searches it locally. On male-CNS ' +
              'that is around 165,000 rows; expect this cell to take a few seconds.',
          ),
          `${all}, _ = fetch_neurons(NeuronCriteria(client=${c}), client=${c})`,
          codaNeurons(ctx, all),
        ]
    if (!cave) ctx.require('neuprint', 'NeuronCriteria', 'fetch_neurons')

    if (query) {
      ctx.helper('coda_search')
      lines.push('', `${hits} = coda_search(${all}, ${pyStr(query)})`)
      if (limit > 0) {
        lines.push(
          ...ctx.note(
            `Coda caps this at ${limit} hits and keeps the ${limit} most *relevant*; the ` +
              'relevance ranking is not ported, so this keeps the first ' +
              limit +
              ' matches ' +
              'in table order instead. The rows may differ from the canvas.',
          ),
          `${hits} = ${hits}.head(${limit})`,
        )
      }
    } else {
      // An empty search is every neuron, which is what the node's own `Hits` port answers.
      lines.push(
        '',
        ...ctx.note('The search box is empty, so Hits is the whole table.'),
        `${hits} = ${all}`,
      )
    }

    lines.push('')
    if (selection.length === 0) {
      lines.push(
        ...ctx.note('Nothing is ticked on the canvas, so Selected is empty.'),
        `${selected} = ${all}.iloc[0:0]`,
      )
    } else {
      // Resolved against the whole table rather than against `hits`, exactly as the node does:
      // refining a search must not drop a neuron somebody already chose.
      lines.push(
        `_selected_ids = ${pySelection(selection)}`,
        /*
         * Compared as **text** on CAVE, where the id column is `str` — an eighteen-digit root id
         * is not exact as a float, so a datastack publishes them as text and `isin` against a
         * list of Python ints matches nothing at all. neuPrint's ids are an `i64` column and are
         * compared as they are, which is also what keeps the common cell short.
         */
        cave
          ? `${selected} = ${all}[${all}['neuronId'].astype(str).isin(` +
            `[str(_i) for _i in _selected_ids])]`
          : `${selected} = ${all}[${all}['neuronId'].isin(_selected_ids)]`,
      )
    }

    return lines
  },
  { backends: ['neuprint', 'cave'] },
)

/**
 * Coda's neuron search, matching only.
 *
 * Two departures from the node, both of which change which rows come back and are therefore
 * stated in the docstring rather than left to be discovered: hits come back in table order
 * rather than ranked by relevance, and a query matching nothing exactly returns nothing where
 * the node would retry it as a subsequence.
 *
 * Everything that decides *whether* a row matches is here, including the rule that is easiest
 * to get wrong: a missing value satisfies `!=` and nothing else.
 */
registerHelper({
  name: 'coda_search',
  requires: [['pandas'], ['numpy']],
  source: [
    'import re',
    '',
    '_CODA_OPERATORS = [("==", "eq"), ("!=", "ne"), (">=", "ge"), ("<=", "le"),',
    '                   ("~", "match"), (">", "gt"), ("<", "lt"), ("=", "eq")]',
    '_CODA_FIELD_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_.]*$")',
    '',
    '',
    'def _coda_tokenize(text):',
    '    """Whitespace-split, but quotes hold a token together."""',
    '    tokens, i = [], 0',
    '    while i < len(text):',
    '        while i < len(text) and text[i].isspace():',
    '            i += 1',
    '        if i >= len(text):',
    '            break',
    '        start, quote = i, None',
    '        while i < len(text):',
    '            ch = text[i]',
    '            if quote is not None:',
    '                if ch == quote:',
    '                    quote = None',
    '            elif ch in "\\"\'":',
    '                quote = ch',
    '            elif ch.isspace():',
    '                break',
    '            i += 1',
    '        tokens.append(text[start:i])',
    '    return tokens',
    '',
    '',
    'def _coda_unquote(value):',
    '    if value[:1] in ("\\"", "\'") and len(value) >= 2:',
    '        return value[1:-1] if value.endswith(value[0]) else value[1:]',
    '    return value',
    '',
    '',
    'def _coda_split_operator(token):',
    '    """Field/operator/value, or None for a bare word.',
    '',
    '    Operators are tried longest-first so "!=" is not read as "=", and the field has to',
    '    look like a name -- otherwise "LC4-a" would parse as a comparison.',
    '    """',
    '    for symbol, op in _CODA_OPERATORS:',
    '        at = token.find(symbol)',
    '        if at <= 0:',
    '            continue',
    '        field = token[:at]',
    '        if not _CODA_FIELD_NAME.match(field):',
    '            continue',
    '        return field, op, token[at + len(symbol):]',
    '    return None',
    '',
    '',
    'def _coda_parse_search(text):',
    '    terms = []',
    '    for raw in _coda_tokenize(text):',
    '        negate = False',
    '        if raw[:1] in ("!", "-") and len(raw) > 1 and _coda_split_operator(raw) is None:',
    '            negate, raw = True, raw[1:]',
    '        split = _coda_split_operator(raw)',
    '        if split is None:',
    '            value = _coda_unquote(raw)',
    '            if value:',
    '                terms.append(("text", value.lower(), None, None, negate))',
    '            continue',
    '        field, op, value = split',
    '        value = _coda_unquote(value)',
    '        if not value:',
    '            # Every query mid-typing looks like this; it narrows nothing rather than',
    '            # being an error.',
    '            continue',
    '        terms.append(("field", value, field, op, negate))',
    '    return terms',
    '',
    '',
    'def _coda_haystack(df):',
    '    """Lowercase text of every searchable column, one string per row.',
    '',
    '    String columns and neuronId only -- so a bare "1200" finds a neuron id and does not',
    '    also match every neuron with 1200 synapses.',
    '    """',
    '    cols = [c for c in df.columns',
    '            if df[c].dtype == object or str(c) == "neuronId"]',
    '    if not cols:',
    '        return pd.Series([""] * len(df), index=df.index)',
    '    parts = [df[c].fillna("").astype(str) for c in cols]',
    '    joined = parts[0]',
    '    for part in parts[1:]:',
    '        joined = joined.str.cat(part, sep=" ")',
    '    return joined.str.lower()',
    '',
    '',
    'def _coda_field_mask(df, field, op, value):',
    '    """One field comparison.',
    '',
    '    A missing value satisfies "!=" and nothing else -- so status!=Traced returns the',
    '    untraced *and* the unlabelled, which is the question somebody auditing a dataset',
    "    for gaps is actually asking. SQL's three-valued logic drops both, silently.",
    '    """',
    '    col = next((c for c in df.columns if str(c).lower() == field.lower()), None)',
    '    if col is None:',
    '        return pd.Series(False, index=df.index)',
    '    series = df[col]',
    '    missing = series.isna()',
    '',
    '    if op == "match":',
    '        # Unanchored, deliberately unlike neuPrint\'s "=~": this search is local and has',
    '        # no server semantic to match.',
    '        rx = re.compile(value)',
    '        found = series.fillna("").astype(str).map(lambda v: rx.search(v) is not None)',
    '        return found & ~missing',
    '',
    '    if pd.api.types.is_numeric_dtype(series):',
    '        try:',
    '            right = float(value)',
    '        except ValueError:',
    '            return pd.Series(False, index=df.index)',
    '        left = pd.to_numeric(series, errors="coerce")',
    '    else:',
    '        right = value.lower()',
    '        left = series.fillna("").astype(str).str.lower()',
    '',
    '    if op == "eq":',
    '        mask = left == right',
    '    elif op == "ne":',
    '        mask = left != right',
    '    elif op == "gt":',
    '        mask = left > right',
    '    elif op == "lt":',
    '        mask = left < right',
    '    elif op == "ge":',
    '        mask = left >= right',
    '    else:',
    '        mask = left <= right',
    '',
    '    mask = mask.fillna(False).astype(bool)',
    '    return (mask | missing) if op == "ne" else (mask & ~missing)',
    '',
    '',
    'def coda_search(df, query):',
    '    """Rows matching Coda\'s Explore Dataset query language.',
    '',
    '    Terms are AND-ed; a leading "!" or "-" negates one. A bare word is a substring of',
    '    the row\'s searchable text; "field=value" compares one column, with ">" "<" ">=",',
    '    "<=", "!=" and "~" (unanchored regex) as the other operators.',
    '',
    '    Two things this does NOT reproduce, both of which change which rows you get:',
    '',
    '    * Hits come back in table order. Coda ranks them by relevance, which only matters',
    '      where the result is capped -- but there it decides which rows survive the cap.',
    '    * A query matching nothing returns nothing. Coda retries it as a subsequence, so',
    '      "mechnosensory" still finds "mechanosensory" there and finds nothing here.',
    '    """',
    '    terms = _coda_parse_search(query)',
    '    if not terms:',
    '        return df',
    '',
    '    keep = pd.Series(True, index=df.index)',
    '    haystack = None',
    '    for kind, value, field, op, negate in terms:',
    '        if kind == "text":',
    '            if haystack is None:',
    '                haystack = _coda_haystack(df)',
    '            mask = haystack.str.contains(value, regex=False)',
    '        else:',
    '            mask = _coda_field_mask(df, field, op, value)',
    '        keep &= ~mask if negate else mask',
    '',
    '    return df[keep]',
  ],
})
