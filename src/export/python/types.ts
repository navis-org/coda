/**
 * The notebook IR, and the contract an emitter signs.
 *
 * An emitter is the third thing a node type has to say about itself, after `inferOutputs`
 * and `evaluate` — what it looks like in Python. It lives in a registry here rather than on
 * the `NodeDefinition` so a viewer's emitter can reach the UI palette, and so a type with no
 * emitter degrades to a TODO cell without anyone editing its definition.
 *
 * The cost of that choice is drift: an emitter can silently stop agreeing with the
 * `evaluate` it mirrors, and nothing type-checks the pair. `coverage.test.ts` is the
 * tripwire — every registered type must either have an emitter or say out loud that it has
 * none.
 */

import type { GraphNode } from '../../core/graph'
import type { NodeDefinition, ParamValues } from '../../core/node'
import type { CodaType, TableSchema } from '../../core/types'

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

export interface MarkdownCell {
  kind: 'markdown'
  source: string[]
}

export interface CodeCell {
  kind: 'code'
  source: string[]
}

export type Cell = MarkdownCell | CodeCell

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

/**
 * The modules a generated notebook may use.
 *
 * A closed set rather than free strings, because the setup cell has to be deterministic —
 * golden files are the whole test strategy here — and because the install line at the top
 * has to name the right distribution. `neuprint` is `neuprint-python` on PyPI, which is
 * exactly the kind of thing nobody remembers at the point of use.
 */
export type PyModule =
  | 'os'
  | 'pandas'
  | 'numpy'
  | 'neuprint'
  | 'caveclient'
  | 'seaserpent'
  | 'navis'
  | 'navisNeuprint'
  | 'flybrains'
  | 'networkx'
  | 'matplotlib'
  | 'seaborn'
  | 'scipyCluster'
  | 'scipyDistance'

export interface ModuleSpec {
  /** Emitted verbatim when the module is imported whole. */
  statement?: string
  /** Emitted as `from <from> import a, b, c` when names have been collected. */
  from?: string
  /** PyPI distribution name, for the install comment. Absent for the standard library. */
  pip?: string
}

/** Declaration order is the order the setup cell reads in. See `setupCell`. */
export const MODULES: Record<PyModule, ModuleSpec> = {
  os: { statement: 'import os' },
  pandas: { statement: 'import pandas as pd', pip: 'pandas' },
  numpy: { statement: 'import numpy as np', pip: 'numpy' },
  networkx: { statement: 'import networkx as nx', pip: 'networkx' },
  matplotlib: { statement: 'import matplotlib.pyplot as plt', pip: 'matplotlib' },
  seaborn: { statement: 'import seaborn as sns', pip: 'seaborn' },
  navis: { statement: 'import navis', pip: 'navis' },
  /*
   * `import navis` does **not** make this reachable — `navis.interfaces` is not imported by
   * the package root, so `navis.interfaces.neuprint.fetch_skeletons(...)` raises
   * AttributeError at the point of use. Verified against navis 2.0 rather than assumed; it is
   * the kind of failure a golden-file snapshot cannot see, because the text is perfectly
   * plausible and only the runtime disagrees.
   */
  navisNeuprint: {
    statement: 'import navis.interfaces.neuprint as neu',
    pip: 'navis',
  },
  /*
   * Imported for its **side effect**, which is why the statement is a bare import of a package
   * nothing then names. `import flybrains` registers every fly template and every transform
   * between them into `navis.transforms.registry`, and `navis.mirror_brain(template='FLYWIRE')`
   * resolves the name out of that registry. Without the import the call raises about an unknown
   * template — a failure a golden-file snapshot cannot see, because the text reads perfectly.
   */
  flybrains: { statement: 'import flybrains  # noqa: F401  (registers the fly templates)', pip: 'flybrains' },
  neuprint: { from: 'neuprint', pip: 'neuprint-python' },
  /*
   * The CAVE client, for a datastack rather than a connectome server. `CAVEclient` is the only
   * name a generated cell ever needs — everything else hangs off it (`client.materialize`,
   * `client.chunkedgraph`), which is caveclient's own idiom and keeps the import line short.
   *
   * Its credential is a file rather than an environment variable: caveclient reads
   * `~/.cloudvolume/secrets/cave-secret.json`, written once by `client.auth.setup_token()`. That
   * is why no dataset cell here has a `token=` argument, unlike the neuPrint one.
   */
  caveclient: { from: 'caveclient', pip: 'caveclient' },
  /*
   * SeaTable, through `sea-serpent` — which is the distribution name and `seaserpent` the module,
   * exactly the mismatch `neuprint-python`/`neuprint` has and the reason `MODULES` names both.
   *
   * Imported whole rather than `from seaserpent import Table`, because `Table` on its own is a
   * generic enough name in a notebook full of tables to be worth the three characters.
   */
  seaserpent: { statement: 'import seaserpent as ss', pip: 'sea-serpent' },
  /*
   * Two keys for one distribution, because a `from` import can only name one module and the
   * clustering needs `scipy.cluster.hierarchy` and `scipy.spatial.distance` both. The pip
   * line dedupes, so this is still one `pip install scipy`.
   *
   * Worth saying why SciPy at all, when Coda runs navis-fastcore: fastcore's linkage matrix
   * *is* SciPy's — checked against `scipy.cluster.hierarchy.linkage` on NBLAST-shaped
   * matrices, merge order identical across 60 trials and heights agreeing to 1.3e-15 — so
   * emitting SciPy is a translation rather than a substitution. It is also already installed
   * for anybody who has navis.
   */
  scipyCluster: { from: 'scipy.cluster.hierarchy', pip: 'scipy' },
  scipyDistance: { from: 'scipy.spatial.distance', pip: 'scipy' },
}

// ---------------------------------------------------------------------------
// The emitter context
// ---------------------------------------------------------------------------

export interface EmitContext<P extends ParamValues = ParamValues> {
  /** The graph node being emitted, for its title, params and id. */
  node: GraphNode
  def: NodeDefinition
  /** The node's params, with the definition's defaults filled in for absent keys. */
  params: P

  /**
   * The Python variable on a **required** input port.
   *
   * The walk refuses to call an emitter whose required ports are unwired or blocked, so by
   * the time an emitter runs this cannot be missing — which is why it returns a plain
   * `string` and why no emitter needs a not-wired guard of its own. Use `input` for a port
   * declared `required: false`, where absence is a real case the emitter has to handle.
   *
   * Throws on a port the definition does not declare. That is a mistyped id, the exact bug
   * `ports.test.ts` exists for, and the walk turns the throw into a visible TODO naming it
   * rather than emitting `undefined` into somebody's notebook.
   */
  wired(portId: string): string
  /**
   * The Python variable on an **optional** input port, or undefined when there is none —
   * unconnected, muted upstream, or upstream emitted nothing. All three are the same fact
   * here, exactly as they are the same `blocked` to the scheduler.
   */
  input(portId: string): string | undefined
  /** The Python variable this node's output port will be bound to. */
  output(portId: string): string
  /**
   * The node's own variable name, before any output-port suffix.
   *
   * For a single-output node this is what `output()` returns; for a multi-output one it is the
   * stem they share. An emitter binding names of its own — Profile's per-tile frames — wants
   * this rather than one of the ports, or the metrics come out as `profile_out_summary`,
   * prefixed with a port that has nothing to do with them.
   */
  readonly name: string

  /** Inferred type on an input port. */
  inputType(portId: string): CodaType | undefined
  /** Table schema on an input port, when it carries one. */
  schema(portId: string): TableSchema | undefined

  /**
   * A column param, resolved exactly as `evaluate` resolves it.
   *
   * Invariant 5 applies here for the same reason it applies there: an emitter reading
   * `params.someColumn` directly would put a name in the cell that the run never used.
   */
  column(paramId: string): string | undefined
  columns(paramId: string): string[]

  /** Declare a module this cell needs. Names are for `from x import ...` modules. */
  require(module: PyModule, ...names: string[]): void
  /** Declare a generated helper function this cell calls. */
  helper(name: string): void

  /**
   * Lines saying this node has no Python equivalent, and why.
   *
   * Returned in place of code. Every gap in the translation goes through here rather than
   * being left out, so a notebook is never quietly shorter than the graph it came from.
   */
  todo(message: string): string[]
  /** A note the cell carries alongside working code — an approximation, a caveat. */
  note(message: string): string[]
}

/** Lines of Python. One node, one cell. */
export type Emitter<P extends ParamValues = ParamValues> = (ctx: EmitContext<P>) => string[]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A generated Python function, emitted into the notebook's helper cell when something asks
 * for it.
 *
 * This is where the algorithms with no library equivalent live — Coda's neuron search, the
 * connectivity traversal's dedupe rules. They are inlined rather than imported from a
 * companion package because the notebook has to stand on `neuprint-python + pandas + navis`
 * and nothing else.
 */
export interface HelperSpec {
  name: string
  /** Other helpers this one calls. Pulled in transitively. */
  needs?: string[]
  /** Modules the body uses. */
  requires?: Array<[PyModule, ...string[]]>
  source: string[]
}
