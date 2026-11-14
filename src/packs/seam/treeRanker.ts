/**
 * SEAM's candidate ranker, which is a gradient-boosted forest, scored here rather than in Pyodide.
 *
 * Production moved off the eight-feature logistic fit on 2026-11-11 (SEAM's `trees_sizes_tip`):
 * LightGBM lambdarank over 191 trees and eleven features — the old eight plus the two whole-object
 * size terms and the distance from the detected tip. The set publishes the model beside its
 * manifest, as `pipeline.search.ranker.model_file`.
 *
 * **Features in Python, scoring here**, because LightGBM is a compiled extension with no Pyodide
 * build. That is this repository's one deliberate break with SEAM's invariant 11, and
 * `docs/python-pyodide.md` argues it where the rest of the Pyodide conventions live; the end
 * state is an upstream numpy traversal, asked for in `docs/seam-suggestions-plan.md`. What keeps
 * the interim safe is that the format is declarative and `treeRanker.test.ts` checks this against
 * **LightGBM's own predictions**, not against a second reading of the format.
 *
 * ## What the format hides
 *
 * - **`decision_type` is a bit field, and the half that matters is easy to miss.** Bit 0 says
 *   categorical, bit 1 says a missing value goes left, and bits 2–3 say *what counts as missing* —
 *   and that last field decides whether bit 1 is read at all. This ranker declares
 *   `missing_type = None`, under which LightGBM turns a `NaN` into **zero** and never looks at the
 *   default direction. Scoring by the default direction instead is wrong for every missing value,
 *   in one direction, and silently: a first draft did exactly that and still reproduced LightGBM's
 *   answers, because the golden carried JSON `null` and `null <= threshold` coerces to
 *   `0 <= threshold` — the right answer by the wrong route.
 * - **Children are encoded by sign.** A non-negative `left_child` names an internal node; a
 *   negative one is `~leaf`, so leaf *l* appears as `-l - 1`. Treating it as an index gives a
 *   plausible walk into the wrong subtree.
 * - **`<=`, not `<`.** A value exactly on a threshold is common here — `touching` and `has_shape`
 *   are 0 or 1, and several splits sit at LightGBM's 1e-35 stand-in for zero — so the boundary is
 *   not a rare case to be relaxed about.
 * - **The raw sum of the leaves reached is the score only for some objectives.** `lambdarank`
 *   optimises an order, so the number is a rank key and nothing else; a binary or regression model
 *   puts that sum through a link function first, and `average_output` divides it. Each of those is
 *   refused by name rather than scored into a plausible wrong number.
 */

/** A feature's value, or `undefined` where it could not be computed. */
export type FeatureRow = readonly (number | undefined)[]

/**
 * What a node counts as missing — `decision_type` bits 2–3, in LightGBM's own numbering.
 *
 * `0` is `None`, and under it a missing value is simply zero. The two below are the cases where
 * `defaultLeft` is read at all.
 */
const MISSING_ZERO = 1
const MISSING_NAN = 2

/** LightGBM's `kZeroThreshold`: what `missing_type = Zero` calls zero, and why 1e-35 splits exist. */
const ZERO = 1e-35

interface Tree {
  /** Per internal node: the feature it splits on. */
  readonly splitFeature: Int32Array
  readonly threshold: Float64Array
  /** Per internal node: whether a value missing *by that node's rule* takes the left branch. */
  readonly defaultLeft: Uint8Array
  /** Per internal node: `0` (none), `MISSING_ZERO` or `MISSING_NAN`. */
  readonly missingType: Uint8Array
  /** Per internal node: `>= 0` is an internal node, `< 0` is `~leaf`. */
  readonly left: Int32Array
  readonly right: Int32Array
  readonly leafValue: Float64Array
}

export interface TreeRanker {
  /** The feature columns, in the order the model's `Column_<i>` indices mean. */
  readonly features: readonly string[]
  readonly trees: readonly Tree[]
  /**
   * Whether every node in every tree declares `missing_type = None`.
   *
   * Decided once at parse time so the walk can be, because this is the hottest loop in the pack:
   * a neuron is ~20,000 candidates through 191 trees, about 23 M node visits. Under `None` the
   * whole missing-value chain — two NaN tests, a `Math.abs`, a `Uint8Array` load — is dead.
   *
   * **Measured at 157 ms against 180 ms for one neuron's 20,000 rows, so 12.6%**, the two walks
   * agreeing to the last bit. Interleaved A/B over 18 repeats, which is not fussiness: run as two
   * separate loops the same comparison came out at 2%, and a third harness reported 36%. The
   * published model is `None` throughout; the general walk stays for one that is not, and
   * `treeRanker.test.ts` exercises it on a hand-written model since this one cannot reach it.
   */
  readonly plainMissing: boolean
  /**
   * The walk, chosen when the forest is parsed.
   *
   * Held rather than picked per row: `sumLeaves` ran `plainMissing ? leafPlain : leafGeneral`
   * 20,000 times a neuron, which both contradicted the paragraph above and kept that call site
   * polymorphic inside the loop the 12.6% was bought in.
   */
  readonly leaf: (tree: Tree, row: ArrayLike<number>) => number
}

/** Every refusal from this module names it, so one place owns the shape. */
function refuse(why: string): never {
  throw new Error(`seam tree ranker: ${why}`)
}

/** Every `key=value` line of a block, which both the header and each tree are made of. */
function keyValues(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of text.split('\n')) {
    const at = line.indexOf('=')
    if (at > 0) out.set(line.slice(0, at), line.slice(at + 1))
  }
  return out
}

/**
 * One `key=value` line's parts, or a refusal naming the block it was missing from.
 *
 * A key present but empty is `[]`, which is a real state: a stump has `split_feature=` with
 * nothing after it. Absence is the refusal, so "the line was lost" and "the tree has no split"
 * cannot be confused.
 */
function field(block: Map<string, string>, key: string, where: string): string[] {
  const line = block.get(key)
  if (line === undefined) refuse(`${where} has no \`${key}\``)
  return line.length === 0 ? [] : line.split(' ')
}

const numbers = (block: Map<string, string>, key: string, where: string): Float64Array =>
  Float64Array.from(field(block, key, where), Number)

const ints = (block: Map<string, string>, key: string, where: string): Int32Array =>
  Int32Array.from(field(block, key, where), Number)

/** A tree with no split: one leaf, and every row reaches it. */
const NO_SPLITS = {
  splitFeature: new Int32Array(0),
  threshold: new Float64Array(0),
  defaultLeft: new Uint8Array(0),
  missingType: new Uint8Array(0),
  left: new Int32Array(0),
  right: new Int32Array(0),
} as const

/**
 * Parse LightGBM's model text.
 *
 * Only what a prediction needs is read, and **anything unexpected throws rather than being
 * skipped**: a forest that silently lost a tree still ranks, and ranks almost right. That is the
 * failure `docs/ml.md` built the verified weight cache around — "a session that loads and answers
 * wrongly, which is worse than one that fails" — and the model is a cross-origin fetch, so a
 * truncated body is the realistic way to get one. `tree_sizes` is what makes that checkable: it
 * carries one entry per tree, so a short body is a count that disagrees rather than a silence.
 */
export function parseTreeRanker(text: string, features: readonly string[]): TreeRanker {
  const blocks = text.split(/\n(?=Tree=\d)/)
  const header = keyValues(blocks[0]!)
  /*
   * `average_output` is written as a **bare line**, not `key=value`, so `keyValues` never sees
   * it — a first draft read it from the map and so could never fire, which is a guard that reads
   * like one and is not. The flags LightGBM writes this way are few and this is the one that
   * changes the score.
   */
  const flags = new Set(blocks[0]!.split('\n').map((line) => line.trim()))
  const refuse = (why: string): never => {
    throw new Error(`seam tree ranker: ${why}`)
  }

  const objective = header.get('objective')
  if (objective !== undefined && !objective.startsWith('lambdarank')) {
    refuse(
      `the model's objective is \`${objective}\`, and this reads the raw sum of leaf values, ` +
        'which is the score only for `lambdarank`',
    )
  }
  // Both of these change what the raw sum means, and neither would fail any other way.
  if (flags.has('average_output')) {
    refuse('the model declares `average_output`, which divides the sum this does not divide')
  }
  const classes = Number(header.get('num_class') ?? 1)
  const perIteration = Number(header.get('num_tree_per_iteration') ?? 1)
  if (classes !== 1 || perIteration !== 1) {
    refuse(
      `the model has ${classes} classes and ${perIteration} trees an iteration, not one each`,
    )
  }
  const declared = Number(header.get('max_feature_idx')) + 1
  if (Number.isFinite(declared) && declared !== features.length) {
    refuse(`the set names ${features.length} features and the model has ${declared}`)
  }

  const trees: Tree[] = []
  let plainMissing = true
  for (const [at, raw] of blocks.slice(1).entries()) {
    const block = keyValues(raw)
    const where = `tree ${at}`
    const leafValue = numbers(block, 'leaf_value', where)
    if (!block.has('split_feature')) {
      // Checked like any other: a stump whose `leaf_value` line is present but empty reaches
      // every row and scores each one `undefined`, which is the quiet NaN case below.
      const stump = { ...NO_SPLITS, leafValue }
      checkWalkable(stump, where)
      trees.push(stump)
      continue
    }
    const decision = ints(block, 'decision_type', where)
    const defaultLeft = new Uint8Array(decision.length)
    const missingType = new Uint8Array(decision.length)
    for (const [i, kind] of decision.entries()) {
      // Bit 0 is "categorical", which this ranker's features are not and this reader cannot do.
      if (kind & 1) refuse(`${where} splits on a categorical feature`)
      defaultLeft[i] = kind & 2 ? 1 : 0
      missingType[i] = (kind >> 2) & 3
      if (missingType[i] !== 0) plainMissing = false
    }
    const tree = {
      splitFeature: ints(block, 'split_feature', where),
      threshold: numbers(block, 'threshold', where),
      defaultLeft,
      missingType,
      left: ints(block, 'left_child', where),
      right: ints(block, 'right_child', where),
      leafValue,
    }
    checkWalkable(tree, where, features.length)
    trees.push(tree)
  }
  if (trees.length === 0) refuse('the model holds no tree')
  const sizes = header.get('tree_sizes')?.split(' ').length
  if (sizes !== undefined && sizes !== trees.length) {
    refuse(`the header counts ${sizes} trees and the body holds ${trees.length}`)
  }
  return { features, trees, plainMissing, leaf: plainMissing ? leafPlain : leafGeneral }
}

/**
 * Refuse a tree whose arrays cannot be walked, **before** anything walks it.
 *
 * `tree_sizes` counts whole trees, so it says nothing about one that arrived short — and a short
 * `left_child` does not fail, it **hangs**: `node` runs past the end, `left[node]` is `undefined`,
 * every comparison against it is false, and the loop never reaches a negative child. A reader
 * that only validated the tree count had exactly that hole, and a test for it wedged the runner
 * rather than failing.
 *
 * The quieter sibling is a child naming a leaf the `leaf_value` line does not have: the walk ends,
 * `leafValue[leaf]` is `undefined`, and every row scores `NaN` — so the pool sorts in whatever
 * order `NaN` comparisons happen to give, with no error anywhere.
 *
 * Both are shapes a truncated or re-encoded body produces, which is the realistic failure for a
 * model fetched cross-origin from the set's host.
 */
function checkWalkable(
  tree: Omit<Tree, 'leafValue'> & { leafValue: Float64Array },
  where: string,
  features = Infinity,
) {
  const nodes = tree.splitFeature.length
  if (tree.leafValue.length === 0) refuse(`${where} has no leaf to reach`)
  for (const [name, array] of [
    ['threshold', tree.threshold],
    ['decision_type', tree.defaultLeft],
    ['left_child', tree.left],
    ['right_child', tree.right],
  ] as const) {
    if (array.length !== nodes) {
      refuse(`${where} has ${nodes} splits and a \`${name}\` of ${array.length}`)
    }
  }
  for (const [at, feature] of tree.splitFeature.entries()) {
    /*
     * An out-of-range split is the model-side twin of a short row: `row[i]` is `undefined`, which
     * is not `NaN`, so it slips past missing-as-zero and goes right into a subtree it was never
     * meant to reach. `max_feature_idx` would catch it, but only where the header carries one.
     */
    if (feature < 0 || feature >= features) {
      refuse(
        `${where}'s node ${at} splits on feature ${feature}, which the model does not have`,
      )
    }
  }
  for (const [flat, child] of [...tree.left, ...tree.right].entries()) {
    const at = flat % nodes
    const side = flat < nodes ? 'left_child' : 'right_child'
    if (child >= nodes) refuse(`${where}'s \`${side}\` names node ${child} of ${nodes}`)
    /*
     * **And it must move down.** Bounding a child from above is not enough: `left_child=0` on
     * node 0 is in range and walks to itself forever, which is the same hang as a short array by
     * another route — a synchronous loop that no test timeout can interrupt. LightGBM appends
     * nodes as it splits, so a child's index always exceeds its parent's; checked against the
     * published model, all 23,684 of them.
     */
    if (child >= 0 && child <= at) {
      refuse(`${where}'s \`${side}\` at node ${at} names node ${child}, which is not below it`)
    }
    if (child < 0 && ~child >= tree.leafValue.length) {
      refuse(`${where}'s \`${side}\` names leaf ${~child} of ${tree.leafValue.length}`)
    }
  }
}

/**
 * The leaf one tree sends a row to, where every node counts only a missing value as zero.
 *
 * LightGBM's `NumericalDecision` under `missing_type = None`, which is the published model
 * throughout: a missing value becomes zero and is then compared like any other.
 */
function leafPlain(tree: Tree, row: ArrayLike<number>): number {
  if (tree.splitFeature.length === 0) return 0
  let node = 0
  for (;;) {
    const raw = row[tree.splitFeature[node]!]!
    // `raw !== raw` is NaN, which is how an absent value reaches both walks.
    const value = raw !== raw ? 0 : raw
    // `<=`, not `<`: a value sitting exactly on the threshold goes left.
    const next = value <= tree.threshold[node]! ? tree.left[node]! : tree.right[node]!
    // A negative child is `~leaf`, not an index.
    if (next < 0) return ~next
    node = next
  }
}

/** The same, for a model whose nodes declare `Zero` or `NaN` as missing. */
function leafGeneral(tree: Tree, row: ArrayLike<number>): number {
  if (tree.splitFeature.length === 0) return 0
  let node = 0
  for (;;) {
    /* LightGBM's own order, because each step changes what the next one sees. */
    const missing = tree.missingType[node]!
    let value = row[tree.splitFeature[node]!]!
    if (value !== value && missing !== MISSING_NAN) value = 0
    const isMissing =
      // LightGBM's `IsZero` is `value > -ZERO && value <= ZERO`, which is **not** symmetric:
      // exactly `-1e-35` is an ordinary value there and `Math.abs(value) <= ZERO` would call it
      // missing. Unreachable for the published model; `leafGeneral` exists for one where it is not.
      (missing === MISSING_ZERO && value > -ZERO && value <= ZERO) ||
      (missing === MISSING_NAN && value !== value)
    const goLeft = isMissing ? tree.defaultLeft[node] === 1 : value <= tree.threshold[node]!
    const next = goLeft ? tree.left[node]! : tree.right[node]!
    if (next < 0) return ~next
    node = next
  }
}

/** One row's leaves summed, over whichever walk the model's missing rules allow. */
function sumLeaves(ranker: TreeRanker, row: ArrayLike<number>): number {
  const { leaf } = ranker
  let total = 0
  for (const tree of ranker.trees) total += tree.leafValue[leaf(tree, row)]!
  return total
}

/**
 * The model's raw score for one row — **higher is a likelier continuation**.
 *
 * `rankKey` is what the search sorts on, and it is the negative of this, because SEAM's published
 * `geo_score` column is a rank key where *lower is better*. The two are kept as separate
 * functions rather than one with a flag: every way of getting this backwards produces a list
 * that is exactly reversed, with every number believable and every rank wrong.
 */
export function scoreRow(ranker: TreeRanker, row: FeatureRow): number {
  /*
   * Guarded like `rankKeys`' pool, and for a sharper reason: a short row does not read as
   * missing. `row[i]` past the end is `undefined`, and `undefined <= threshold` is false, so
   * every absent feature goes **right** — past even the model's own missing-as-zero rule, into a
   * subtree it was never meant to reach, with a believable number at the end.
   */
  if (row.length !== ranker.features.length) {
    refuse(`a row of ${row.length} values, where the model ranks on ${ranker.features.length}`)
  }
  const dense = new Float64Array(row.length)
  // An absent value enters as NaN, which is what both walks read as missing.
  for (const [at, value] of row.entries()) dense[at] = value === undefined ? NaN : value
  return sumLeaves(ranker, dense)
}

/** The search's sort key for one row: lower is better, as `geo_score` is published. */
export function rankKey(ranker: TreeRanker, row: FeatureRow): number {
  return -scoreRow(ranker, row)
}

/** A pool as the search hands it over: a row count and a column per feature. */
export interface Pool {
  readonly rows: number
  readonly columns: Readonly<Record<string, ArrayLike<number>>>
}

/**
 * `rankKey` for a whole pool.
 *
 * Columns rather than rows because that is how the Pyodide side hands a pool back, and building
 * an array of objects to take it apart again would cost a row per candidate for nothing. The row
 * buffer is reused and typed, so the ~23 M reads in a neuron stay monomorphic; a column is
 * `ArrayLike<number>`, so nothing here can be absent and the `undefined` arm belongs to
 * `scoreRow` alone. One neuron's 20,000 rows measured **157 ms**.
 */
export function rankKeys(ranker: TreeRanker, pool: Pool): Float64Array {
  const { rows, columns } = pool
  const wanted = ranker.features.map((name) => {
    const column = columns[name]
    if (!column) refuse(`the pool has no \`${name}\` column, which the model ranks on`)
    if (column.length !== rows) {
      refuse(`the pool says ${rows} rows and its \`${name}\` column has ${column.length}`)
    }
    return column
  })
  const out = new Float64Array(rows)
  const row = new Float64Array(wanted.length)
  for (let i = 0; i < rows; i++) {
    for (let at = 0; at < wanted.length; at++) row[at] = wanted[at]![i]!
    out[i] = -sumLeaves(ranker, row)
  }
  return out
}

/**
 * Parsed forests, by the address the model was fetched from.
 *
 * **A memo so that re-parsing is impossible rather than merely discouraged.** Parsing costs ~8 ms
 * and a neuron is ~500 tips, so a caller that parsed per tip would spend four seconds on the
 * model against ~130 ms of actual scoring — and nothing about `parseTreeRanker`'s signature would
 * have stopped it. Keyed on the URL, not on the text, so the 1.3 MB body is not retained: the
 * caller should drop it once this returns.
 */
const parsed = new Map<string, TreeRanker>()

/** How many forests to keep. A session reads one set at a time; the rest is slack. */
const MAX_CACHED = 4

export function treeRankerFor(
  url: string,
  text: string,
  features: readonly string[],
): TreeRanker {
  /*
   * The features are part of the key, not just the value. `parseTreeRanker` refuses a model whose
   * feature count is not the set's — the guard that exists because SEAM appended three on
   * 2026-11-11 — and a memo keyed on the address alone would hand back the old forest, and the
   * old feature order with it, without that guard ever running.
   */
  const key = `${url}\n${features.join(' ')}`
  const held = parsed.get(key)
  if (held) return held
  const ranker = parseTreeRanker(text, features)
  parsed.set(key, ranker)
  if (parsed.size > MAX_CACHED) {
    const oldest = parsed.keys().next()
    if (!oldest.done) parsed.delete(oldest.value)
  }
  return ranker
}

/** Test-only: drop cached forests so a suite can re-observe a parse. */
export function resetTreeRankerCache(): void {
  parsed.clear()
}
