/**
 * A network as DotMotif's worker reads it: every node and link end as an integer key.
 *
 * A key is a node's rank in id order, which does two jobs. Python never sees an id, so the one
 * rule for turning an id cell into text stays `networkOps`' `String(cell ?? '')`, applied by the
 * caller, and `induceSubnetwork` matches against exactly the text it reads itself. And the
 * matcher's bounded prefix depends on the network rather than on the order its rows arrived in:
 * GrandIso walks nodes and adjacency in insertion order, and Python inserts nodes in key order
 * and links in the pair order this sorts them into.
 *
 * Everything that is not a simple graph is refused here, before Pyodide is booted for it.
 *
 * **No imports**, so `scripts/probe-dotmotif.mjs` loads this very file under plain Node rather
 * than a copy of it — which is also why the reply's decoder, `matchColumns`, lives here.
 */

export interface DotMotifHost {
  /** Node id by key. */
  ids: string[]
  /** The key of each node row. */
  keyOfRow: Int32Array
  /** Each link's end keys, sorted by node pair: the order Python inserts them in. */
  sources: Int32Array
  targets: Int32Array
  /** The link row each sorted link came from, which is where its attributes are. */
  linkRows: Int32Array
}

/**
 * UTF-16 code-unit order. Deliberately not `compareIds`, which is length-first: any total order
 * makes the prefix deterministic, and this one is what the matcher has always been keyed by.
 */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * `rows` stably reordered by `key`, every key below `n`: a counting sort, O(n + rows). Indexed
 * loops here and below, not `for…of` or `forEach`, because these run over every link: measured at
 * 2M links, the encoding went from 0.38 s to 0.22 s on the main thread.
 */
function stableByKey(rows: Int32Array, key: Int32Array, n: number): Int32Array {
  const start = new Int32Array(n + 1)
  for (let i = 0; i < rows.length; i++) start[key[rows[i]!]! + 1]!++
  for (let k = 0; k < n; k++) start[k + 1]! += start[k]!
  const out = new Int32Array(rows.length)
  for (let i = 0; i < rows.length; i++) out[start[key[rows[i]!]!]!++] = rows[i]!
  return out
}

export function dotmotifHost(
  ids: readonly string[],
  sources: readonly string[],
  targets: readonly string[],
  directed: boolean,
): DotMotifHost {
  const order = ids.map((_, row) => row).sort((a, b) => compare(ids[a]!, ids[b]!))
  const keyOf = new Map<string, number>()
  const keyOfRow = new Int32Array(ids.length)
  const sorted: string[] = []
  order.forEach((row, key) => {
    const id = ids[row]!
    if (id === '') throw new Error('Every network node needs an id; one is empty or missing.')
    if (keyOf.has(id)) {
      throw new Error(`Network node ids must be unique; "${id}" appears more than once.`)
    }
    keyOf.set(id, key)
    keyOfRow[row] = key
    sorted.push(id)
  })

  const n = ids.length
  const m = sources.length
  const sourceKeys = new Int32Array(m)
  const targetKeys = new Int32Array(m)
  // The pair as (first, second): ordered when directed, smaller key first when not.
  const first = new Int32Array(m)
  const second = new Int32Array(m)
  for (let i = 0; i < m; i++) {
    const a = keyOf.get(sources[i]!)
    const b = keyOf.get(targets[i]!)
    if (a === undefined || b === undefined) {
      throw new Error(
        `The link ${sources[i]} → ${targets[i]} names a node that is not in the network's node table.`,
      )
    }
    sourceKeys[i] = a
    targetKeys[i] = b
    first[i] = directed || a <= b ? a : b
    second[i] = directed || a <= b ? b : a
  }

  // Two stable passes, by the second key and then the first, sort the links by pair; a parallel
  // link is then its predecessor's neighbour. Measured at 2M links, a Set of pair codes cost
  // ~0.6 s more, and the sort is the order Python needs anyway.
  const identity = new Int32Array(m)
  for (let i = 0; i < m; i++) identity[i] = i
  const linkRows = stableByKey(stableByKey(identity, second, n), first, n)
  const sortedSources = new Int32Array(m)
  const sortedTargets = new Int32Array(m)
  for (let j = 0; j < m; j++) {
    const row = linkRows[j]!
    const prev = linkRows[j - 1]
    if (j > 0 && first[row] === first[prev!] && second[row] === second[prev!]) {
      throw new Error(
        `DotMotif needs one link per node pair, and ${sources[row]} → ${targets[row]} appears ` +
          'more than once. Turn on Merge parallel links in Build Network.',
      )
    }
    sortedSources[j] = sourceKeys[row]!
    sortedTargets[j] = targetKeys[row]!
  }
  return { ids: sorted, keyOfRow, sources: sortedSources, targets: sortedTargets, linkRows }
}

export type MatchColumns = {
  matchId: number[]
  variable: string[]
  nodeId: string[]
}

/** The Matches table's columns from the worker's reply: one row per role per match. */
export function matchColumns(
  matches: { count: number; roles: readonly string[]; keys: ArrayLike<number> },
  ids: readonly string[],
): MatchColumns {
  const columns: MatchColumns = { matchId: [], variable: [], nodeId: [] }
  const { count, roles, keys } = matches
  for (let m = 0; m < count; m++) {
    roles.forEach((role, r) => {
      columns.matchId.push(m + 1)
      columns.variable.push(role)
      columns.nodeId.push(ids[keys[m * roles.length + r]!]!)
    })
  }
  return columns
}
