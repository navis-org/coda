/**
 * The R exporter's IR and emitter contract.
 *
 * A near-copy of `python/types.ts`, deliberately: the two exporters share the fixture graph and
 * the refusal policy but not the walk, so a change to how R chunks are assembled cannot reach
 * the notebook and vice versa. The cost is that the structural rules exist twice — if you fix
 * one, look at the other.
 */

import type { GraphNode } from '../../core/graph'
import type { NodeDefinition, ParamValues } from '../../core/node'
import type { CodaType, TableSchema } from '../../core/types'

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
  | 'nat'
  | 'nat.nblast'
  | 'dplyr'
  | 'tidyr'
  | 'readr'
  | 'ggplot2'
  | 'igraph'
  | 'Matrix'

export interface PackageSpec {
  /** Where it comes from, for the install comment. CRAN unless stated. */
  github?: string
}

/** Declaration order is the order the setup chunk attaches them in. */
export const PACKAGES: Record<RPackage, PackageSpec> = {
  neuprintr: { github: 'natverse/neuprintr' },
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
  /** Resolved exactly as `evaluate` resolves it — invariant 5. */
  column(paramId: string): string | undefined
  columns(paramId: string): string[]

  library(pkg: RPackage): void
  helper(name: string): void

  todo(message: string): string[]
  note(message: string): string[]
}

export type Emitter<P extends ParamValues = ParamValues> = (ctx: EmitContext<P>) => string[]

export interface HelperSpec {
  name: string
  needs?: string[]
  requires?: RPackage[]
  source: string[]
}
