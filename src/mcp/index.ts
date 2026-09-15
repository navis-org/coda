/**
 * The contract the MCP server runs against — contract version 1.
 *
 * Built by `vite.mcp.config.ts` into `dist/mcp/v1/coda.js` and deployed beside the app, so a
 * server that downloads it is always checking graphs against the node definitions the live app
 * will load. See `docs/mcp.md` for why the server fetches this rather than depending on a package.
 *
 * **Every export here is a public interface.** The server lives in another repository and is
 * installed on other people's machines, so a rename compiles fine on both sides and breaks every
 * installed server the moment this deploys. `contract.test.ts` pins the names and the shapes; a
 * change that has to break one is a `v2` directory beside this one, with `v1` still served. For the
 * same reason nothing is exported ahead of a caller: adding one later is free, removing one is not.
 *
 * Deliberately a re-export layer and nothing more. Every function is the one the app or the
 * in-app assistant already calls — the catalogue, the plan applier, the graph listing, the link
 * encoder — so there is no second implementation here to drift from the first.
 */

import '../nodes'
import { registerBuiltinSources } from '../data/builtins'
import { buildSystemPrompt, renderNode } from '../assistant/catalogue'
import type { CatalogueDetail } from '../assistant/catalogue'
import { applyPlan as applyAssistantPlan, collectWarnings } from '../assistant/apply'
import type { ApplyResult, ApplyWarning } from '../assistant/apply'
import { describeGraph } from '../assistant/converse'
import { parsePlan as parseAssistantPlan, planJsonSchema } from '../assistant/plan'
import type { AssistantPlan } from '../assistant/planShape'
import type { CodaGraph } from '../core/graph'
import { emptyGraph, serializeGraph } from '../core/graph'
import { inferGraph } from '../core/inference'
import { getNodeDef, listableNodeDefs } from '../core/registry'
import { encodeShareFragment, shareUrl } from '../data/share/fragment'
import { setToken as setNeuprintToken } from '../data/neuprint/credentials'
import { setToken as setCaveToken } from '../data/cave/credentials'
import { loadHelpDoc } from '../help/registry'

registerBuiltinSources()

/** Bumped only with a breaking change to an export below — never with the app. */
export const CONTRACT_VERSION = 1

/** The app's package.json version. It does not change between deploys; `BUILD_ID` does. */
export const APP_VERSION: string = __APP_VERSION__

/**
 * The latest commit that changed a file this build is made of, with `-dirty` when one of those files
 * has uncommitted changes, and `dev` outside the MCP build. See `vite.mcp.config.ts` for why it is
 * not simply `HEAD`.
 */
export const BUILD_ID: string = __BUILD_ID__

/**
 * The plan rules, framed for a model editing a draft through tools rather than for the in-app
 * assistant, then the whole node catalogue. `lean` unless asked.
 */
export function guide(detail?: CatalogueDetail): string {
  return buildSystemPrompt(detail, 'mcp')
}

/** Every node type a plan may name. */
export function nodeTypeIds(): string[] {
  return listableNodeDefs().map((def) => def.type)
}

/** One node's catalogue entry, or undefined for a type this build does not have. */
export function nodeEntry(type: string, detail: CatalogueDetail = 'full'): string | undefined {
  const def = getNodeDef(type)
  return def ? renderNode(def, detail) : undefined
}

/** The node's `?` document as markdown, where it has one. */
export async function nodeHelp(type: string): Promise<string | undefined> {
  return (await loadHelpDoc(type))?.source
}

/** The JSON Schema a plan is written against. */
export function planSchema(): object {
  return planJsonSchema()
}

/** Read a plan leniently, from JSON text. */
export function parsePlan(text: string): ReturnType<typeof parseAssistantPlan> {
  return parseAssistantPlan(text)
}

/** An empty graph, named `Untitled` unless a name is given. */
export function newGraph(name?: string): CodaGraph {
  return emptyGraph(name)
}

/** Apply a plan atomically: a new graph and the warnings it left, or every reason it was refused. */
export function applyPlan(graph: CodaGraph, plan: AssistantPlan): ApplyResult {
  return applyAssistantPlan(graph, plan)
}

/** The graph as the in-app assistant is shown it: node ids, columns carried, params set, wires. */
export function describe(graph: CodaGraph): string {
  return describeGraph(graph)
}

export interface CheckResult {
  /** No error-severity issue and no cycle. */
  ok: boolean
  cyclic: string[]
  issues: ApplyWarning[]
}

/** Every edit-time issue on every node: the plan applier's own warning loop, unscoped. */
export function check(graph: CodaGraph): CheckResult {
  const inference = inferGraph(graph)
  return {
    ok: inference.ok,
    cyclic: inference.cyclic,
    issues: collectWarnings(graph, { inference }),
  }
}

/** A `.coda.json` document. */
export function toJson(graph: CodaGraph): string {
  return serializeGraph(graph)
}

/** A packed share link opening this graph on the site at `siteUrl`. */
export async function shareLink(graph: CodaGraph, siteUrl: string): Promise<string> {
  const base = siteUrl.endsWith('/') ? siteUrl : `${siteUrl}/`
  return shareUrl(await encodeShareFragment(graph), base, base)
}

export interface Credentials {
  neuprint?: string
  /** Token per CAVE deployment, keyed by its server URL. */
  cave?: Record<string, string>
}

/** Held in memory for this process; there is no `localStorage` to persist them to. */
export function setCredentials(credentials: Credentials): void {
  if (credentials.neuprint !== undefined) setNeuprintToken(credentials.neuprint)
  for (const [server, token] of Object.entries(credentials.cave ?? {})) {
    setCaveToken(server, token)
  }
}
