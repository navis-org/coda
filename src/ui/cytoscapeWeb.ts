/**
 * Opening a network in Cytoscape Web.
 *
 * Cytoscape Web reads a network from a URL — `https://web.cytoscape.org/?import=<url>` fetches a
 * CX2 file and opens it — and that is the whole interface: there is no message channel and no
 * upload. So the file has to be *somewhere* it can fetch, cross-origin, and there are two places:
 *
 *  - **in the link**, as a `data:` URL. Nothing to host, nothing to sign in to, and it only fits a
 *    small graph: web.cytoscape.org's Apache refuses a request line past about 8,190 bytes (414),
 *    and the graph cannot ride in the fragment instead because the app reads only the query
 *    string. Measured: a 45-node graph with a layout, types and weights is an 8,047-character link
 *    that opens; one node more is 8,223 and refused. Nor can it be compressed — the app reads the
 *    response with `.text()`.
 *  - **in a gist**, via `writeScratchGist`, whose raw URL `gist.githubusercontent.com` serves with
 *    `Access-Control-Allow-Origin: *`. Any size, but it needs a GitHub token.
 *
 * base64 rather than percent-encoded JSON, measured at 25–30% more graph per link: every `"` in
 * JSON costs three characters escaped, and `%` and `#` need escaping twice over (once for the
 * `data:` URL's own parser, once for the query). base64 needs one escape — `+`, which the query
 * would decode as a space.
 */

import type { NetworkValue } from '../core/values'
import { toBase64 } from '../data/base64'
import { selectTable } from '../nodes/lib/tableOps'
import type { Cx2Options } from './exportValue'
import { networkToCx2 } from './exportValue'

const IMPORT = 'https://web.cytoscape.org/?import='
const DATA_PREFIX = `${IMPORT}data:application/json;base64,`

/**
 * The longest link sent, below the measured refusal at ~8,190 with room for a server whose
 * configuration nobody here controls: the limit is Apache's default `LimitRequestLine`, and a
 * default is what somebody changes.
 */
export const MAX_LINK_CHARS = 8000

/** Whether a file of this many bytes fits in a link: base64 is four characters per three bytes. */
function fits(bytes: number): boolean {
  return DATA_PREFIX.length + Math.ceil(bytes / 3) * 4 <= MAX_LINK_CHARS
}

/** What goes into the file — the dialog's three toggles. */
export interface CytoscapeChoice {
  nodeAttributes: boolean
  edgeAttributes: boolean
  layout: boolean
}

/**
 * The CX2 text for a choice.
 *
 * The toggles take columns off the *network* rather than asking the writer to skip them, so
 * `networkToCx2` writes whatever it is handed and the same file comes out of the same tables by
 * every route. Without its attributes a node keeps only its id, which the writer then writes as
 * `name` — a table's own `name` column goes with the rest.
 */
export function cytoscapeCx2(
  network: NetworkValue,
  name: string,
  choice: CytoscapeChoice,
  positions: Cx2Options['positions'],
): string {
  const trimmed: NetworkValue = {
    ...network,
    nodes: choice.nodeAttributes ? network.nodes : selectTable(network.nodes, ['id']),
    edges: choice.edgeAttributes
      ? network.edges
      : selectTable(network.edges, ['source', 'target']),
  }
  return networkToCx2(trimmed, { name, positions: choice.layout ? positions : undefined }).join(
    '',
  )
}

/**
 * The smallest a CX2 file can be: its fixed aspects, and the shortest element a node
 * (`{"id":0,"v":{"name":""}}`) and a link (`{"id":0,"s":0,"t":0,"v":{}}`) can be written as.
 * A floor, never an estimate — `cytoscapeWeb.test.ts` holds it to never exceeding a real file.
 */
const CX2_FLOOR = 300
const NODE_FLOOR = 24
const EDGE_FLOOR = 27

/**
 * Whether a network could fit in a link with every toggle off.
 *
 * `false` means no choice in the dialog changes the answer, so there is no file worth writing
 * until somebody presses Upload — which, on a network of tens of thousands of nodes, is the
 * difference between a dialog that opens and one that blocks for half a second per toggle to
 * print a size nobody can act on.
 */
export function mayFitInLink(network: NetworkValue): boolean {
  return fits(CX2_FLOOR + network.nodes.length * NODE_FLOOR + network.edges.length * EDGE_FLOOR)
}

/**
 * The link carrying the file itself, or `undefined` when it would not fit.
 *
 * Asked of the string's length before anything is encoded — UTF-8 is never shorter than that —
 * so a file that cannot fit is known without allocating its bytes to find out.
 */
export function dataLink(cx2: string): string | undefined {
  if (!fits(cx2.length)) return undefined
  const bytes = new TextEncoder().encode(cx2)
  if (!fits(bytes.length)) return undefined
  const link = `${DATA_PREFIX}${toBase64(bytes).replaceAll('+', '%2B')}`
  return link.length <= MAX_LINK_CHARS ? link : undefined
}

/** The link to a file hosted somewhere Cytoscape Web can fetch it. */
export function importLink(fileUrl: string): string {
  return `${IMPORT}${encodeURIComponent(fileUrl)}`
}
