/**
 * The R exporter's IR and emitter contract.
 *
 * A near-copy of `python/types.ts`, deliberately: the two exporters share the fixture graph and
 * the refusal policy but not the walk, so a change to how R chunks are assembled cannot reach
 * the notebook and vice versa. The cost is that the structural rules exist twice — if you fix
 * one, look at the other.
 */

import type { GraphNode } from '../../core/graph'
import type { TrimRule } from '../trimHelpers'
import type { NodeDefinition, ParamValues } from '../../core/node'
import type { AttributePart, CodaType, TableSchema } from '../../core/types'

export interface MarkdownCell {
  kind: 'markdown'
  source: string[]
}

/** A knitr chunk. `label` must be unique in the document — knitr errors on a duplicate. */
export interface CodeCell {
  kind: 'code'
  label: string
  source: string[]
}

export type Cell = MarkdownCell | CodeCell

/**
 * The packages a generated document may attach.
 *
 * A closed set, so the setup chunk is deterministic — golden files are the test strategy here
 * — and so the install line names the right source. `neuprintr` is the one that matters:
 * it is **not on CRAN**, so `install.packages` does not find it and the comment has to say
 * `install_github` instead.
 */
export type RPackage =
  | 'neuprintr'
  | 'catmaid'
  | 'fafbseg'
  | 'arrow'
  | 'reticulate'
  | 'seatabler'
  | 'nat'
  | 'nat.nblast'
  | 'dplyr'
  | 'tidyr'
  | 'readr'
  | 'ggplot2'
  | 'igraph'
  | 'Matrix'
  | 'uwot'
  | 'nabor'
  | 'httr'
  | 'jsonlite'
  | 'stringi'
  | 'nglscenes'

export interface PackageSpec {
  /** Where it comes from, for the install comment. CRAN unless stated. */
  github?: string
  /**
   * Lines the setup chunk prints under the install line, for a package that needs a one-time
   * step of its own before the document runs.
   */
  setup?: string[]
  /**
   * `false` for a package the document calls only by namespace (`arrow`, `reticulate`): it is
   * named in the install line and never attached, so its masking messages and its exports stay
   * out of the reader's session.
   */
  attach?: boolean
  /**
   * The oldest version every emitted call runs on, and what needs it — said once in the setup
   * chunk, where the install line is, rather than in every chunk that calls it.
   */
  minimum?: { version: string; for: string }
}

/** Declaration order is the order the setup chunk attaches them in. */
export const PACKAGES: Record<RPackage, PackageSpec> = {
  neuprintr: { github: 'natverse/neuprintr' },
  // A CATMAID project — the natverse's rcatmaid, whose package is `catmaid`. Not on CRAN either.
  catmaid: { github: 'natverse/rcatmaid' },
  /*
   * CAVE, through the natverse: fafbseg drives the Python caveclient through reticulate, so it
   * needs a Python with caveclient once. `simple_python()` is fafbseg's own route to one, and
   * `dr_fafbseg()` reports what is missing — the two lines a reader needs before and after.
   */
  fafbseg: {
    github: 'natverse/fafbseg',
    setup: [
      "fafbseg drives Python's caveclient through reticulate. Once per machine, run",
      'fafbseg::simple_python(); if a chunk below fails, fafbseg::dr_fafbseg() says why.',
      'The CAVE token is read from ~/.cloudvolume/secrets, as caveclient does in Python.',
    ],
  },
  // fafbseg reads CAVE's rows through arrow, which is what keeps an 18-digit id exact.
  arrow: { attach: false },
  reticulate: { attach: false },
  // SeaTable and FlyTable. Called by namespace only; its Python is nat.python's, not fafbseg's.
  seatabler: {
    github: 'flyconnectome/seatabler',
    attach: false,
    setup: [
      "seatabler drives Python's seatable_api through reticulate. Once per machine, run",
      'nat.python::simple_python("minimal", pkgs = "seatable_api"). The account token is',
      'read from FLYTABLE_TOKEN for FlyTable and SEATABLE_TOKEN for any other SeaTable server',
      '(e.g. set in ~/.Renviron).',
    ],
  },
  nat: {},
  // On CRAN, unlike neuprintr — `install.packages` finds it.
  'nat.nblast': {},
  dplyr: {},
  tidyr: {},
  readr: {},
  ggplot2: {},
  igraph: {},
  /*
   * For `coda_similarity`, and it is the reason that helper is a translation rather than an
   * approximation: a feature matrix over partner ids is almost entirely zeroes, and base R has
   * no sparse type to hold one in. Ships with R as a recommended package, so the install line
   * naming it is a formality on nearly every machine — but naming it is what makes
   * `Matrix::sparseMatrix` resolve under `--vanilla`.
   */
  Matrix: {},
  /*
   * UMAP, for `core.embed`. On CRAN, and the *reference* rather than a translation of what Coda
   * ran — the canvas runs PAIR-code's `umap-js` because umap-learn needs numba and the
   * in-browser Python runtime has none, so both exporters emit a third implementation of the
   * published algorithm. uwot is McInnes' method as Melville implemented it in R, and the
   * hyperparameters carry over by name; the arrangement will not match either of the other two
   * in detail, which is what two seeds of one implementation already do. The emitted cell says
   * so rather than leaving a reader comparing two plots to conclude one is broken.
   */
  uwot: { minimum: { version: '0.1.15', for: '`umap()`’s `seed` argument' } },
  /*
   * The k-d tree, for `Distance between`. On CRAN, and already in a natverse reader's library — nat.nblast
   * depends on it, so this asks nothing new of anyone who has NBLAST working. It is also the same
   * structure the canvas builds and scipy builds on the Python side, so all three agree on how the
   * nearest point is found rather than on the answer alone.
   */
  nabor: {},
  /*
   * The Neuroglancer node: `httr` asks neuPrint for the scene it publishes, with the connection's
   * own config, and `stringi` breaks a categorical tie in ICU's alphabetical order, which is the
   * browser's — base R's `order()` collates by whatever locale the session happens to be in.
   * `jsonlite` reads a number back exactly when a category label is spelled the way JavaScript
   * spells it, R's own `as.numeric()` misreading some (`1e300`). All three arrive with neuprintr,
   * which imports `httr`, `jsonlite` and `stringr` (built on `stringi`).
   */
  httr: {},
  jsonlite: {},
  stringi: {},
  /*
   * The scene itself: nglscenes-r reads it losslessly and writes it back exactly — 18-digit ids
   * verbatim, doubles in the shortest form that reads back the same, a one-element list still an
   * array — which jsonlite's defaults do not. The R port of the Python package the notebook uses.
   */
  nglscenes: { github: 'schlegelp/nglscenes-r' },
}

export interface EmitContext<P extends ParamValues = ParamValues> {
  node: GraphNode
  def: NodeDefinition
  params: P
  /** The node's own variable name, before any output-port suffix. */
  readonly name: string

  /**
   * The R variable on a **required** input port.
   *
   * The walk refuses to call an emitter whose required ports are unwired or blocked, so this
   * cannot be missing. Throws on a port the definition does not declare — a mistyped id, which
   * `ports.test.ts` exists to catch.
   */
  wired(portId: string): string
  /** The R variable on an **optional** input port, or undefined when there is none. */
  input(portId: string): string | undefined
  /** The R variable this node's output port will be bound to. */
  output(portId: string): string

  inputType(portId: string): CodaType | undefined
  schema(portId: string): TableSchema | undefined
  /**
   * Attribute schema for a type that carries one but is not a table — a Network's nodes or
   * edges, Skeletons, Points. Forwarded from `InferContext` beside `schema` for the reason
   * `emit.ts` gives where it delegates: `schemaOf` has no branch for a network.
   */
  attributes(portId: string, part?: AttributePart): TableSchema | undefined
  /** Resolved exactly as `evaluate` resolves it — invariant 5. */
  column(paramId: string): string | undefined
  columns(paramId: string): string[]

  library(pkg: RPackage): void
  helper(name: string): void

  todo(message: string): string[]
  /** A note beside working code. Nothing for `undefined`, so an optional note needs no guard. */
  note(message: string | undefined): string[]
}

export type Emitter<P extends ParamValues = ParamValues> = (ctx: EmitContext<P>) => string[]

export interface HelperSpec {
  name: string
  needs?: string[]
  requires?: RPackage[]
  source: string[]
  /**
   * `'functions'` for a file of functions of which a document carries only the ones it calls, and
   * only the `needs` those name. See `trimHelpers.ts`.
   */
  trim?: TrimRule
}
