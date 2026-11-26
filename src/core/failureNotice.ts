/**
 * The notice a run that ended with failures leaves: which node failed first, and why.
 *
 * It said only "1 node failed", which was enough on the canvas, where the card is drawn red with
 * its reason in the band, and nothing at all on a dashboard, which replaces the canvas — a node
 * with no cell there failed out of sight (2026-11-26: Find Merge Candidates refusing the model
 * download, its "tick `Allow model download`" on a card nobody could see). One line, because the
 * notice holds one: the first failure is the one most likely to be the cause, since a node below
 * a failed one is `blocked` rather than failed and is never counted here.
 */

import { plural } from '../style/format'
import { ancestorsOf, nodeLabel, type CodaGraph } from './graph'

/**
 * A reason as the notice's one line. A Python traceback is a line a frame, and the line that says
 * what went wrong is its last (`ValueError: …`); the card and the inspector keep the whole of it.
 * Any other reason keeps every word, its line breaks read as spaces.
 */
function oneLine(reason: string | undefined): string | undefined {
  const lines = (reason ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  if (lines.length === 0) return undefined
  if (lines.some((line) => line.startsWith('Traceback (most recent call last)'))) {
    return lines[lines.length - 1]
  }
  return lines.join(' ')
}

export function failureNotice(
  failed: readonly string[],
  graph: CodaGraph,
  /** The node's error, as its card shows it. */
  errorOf: (nodeId: string) => string | undefined,
): string | undefined {
  const first = failed[0]
  if (first === undefined) return undefined
  // Capitalised: it starts the sentence, and a node deleted mid-run is "a node".
  const named = nodeLabel(graph.nodes.find((node) => node.id === first))
  const label = named.charAt(0).toUpperCase() + named.slice(1)
  const why = oneLine(errorOf(first))
  // Ended with a full stop where the reason has none, so a count can follow it.
  const stop = why && !/[.!?]$/.test(why) ? '.' : ''
  const head = why ? `${label} failed: ${why}${stop}` : `${label} failed.`
  const rest = failed.length - 1
  return rest === 0 ? head : `${head} ${plural(rest, 'more node', 'more nodes')} failed too.`
}

/**
 * The failure behind `from`: `from` itself where it failed, else the failed node above it with no
 * other failed node above *it* — a node below a failed one is `blocked`, not failed, so this is the
 * one that started it. `undefined` where nothing at or above `from` failed.
 *
 * Over every edge, references included: a node whose referenced node failed is refused too. A
 * reference may point upstream, putting a node among its own ancestors, so a candidate never
 * counts against itself; where references tie two failures in a ring, the first is named.
 */
export function rootFailure(
  graph: CodaGraph,
  from: string,
  failedAt: (nodeId: string) => boolean,
): string | undefined {
  if (failedAt(from)) return from
  const above = ancestorsOf(graph)
  const failed = [...above(from)].filter((id) => id !== from && failedAt(id))
  const isRoot = (id: string) => {
    const up = above(id)
    return !failed.some((other) => other !== id && up.has(other))
  }
  return failed.find(isRoot) ?? failed[0]
}
