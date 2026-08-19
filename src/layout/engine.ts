/**
 * Running ELK. The only part of the layout that is not pure.
 *
 * **elkjs never enters the main chunk.** It is a GWT-compiled Java port and the bundled build
 * is around 1.4 MB — the same argument that keeps three.js and sigma behind `LazyViewers`, with
 * the same enforcement: `pnpm build` should show `elk-worker-*` as its own file. Both branches
 * below are dynamic imports, so whichever one runs, nothing is paid for until somebody arranges
 * something for the first time.
 *
 * **In the browser it runs in a worker.** Auto-layout mode re-arranges on every structural edit,
 * so the pass is not a one-off the canvas can afford to block on. The worker build costs one
 * extra module and a `postMessage` round trip; the alternative is a graph large enough to stutter
 * the editor at exactly the moment somebody is editing it.
 *
 * **Under vitest there is no `Worker`, so the bundled build stands in.** That is not a
 * compromise for the tests' benefit — it is what makes `engine.test.ts` able to put the real
 * algorithm behind the real mapping, which matters because ELK silently *ignores* an option key
 * it does not recognise rather than rejecting it. A mistyped option is invisible to every other
 * kind of check.
 */

import type { ELK, ElkNode } from 'elkjs/lib/elk-api'

import type { LayoutOptions } from './options'
import type { MeasuredSizes } from './elkGraph'
import { positionsFrom, toElkGraph } from './elkGraph'
import type { XY } from './place'
import type { GraphEdge, GraphNode } from '../core/graph'

let enginePromise: Promise<ELK> | undefined

async function engine(): Promise<ELK> {
  if (!enginePromise) {
    enginePromise = (async () => {
      if (typeof Worker === 'undefined') {
        /*
         * Through a variable and `@vite-ignore`, which is not a style choice. Written as a
         * literal, rollup resolves it and emits the whole 1.4 MB bundled build into `dist/` —
         * a file no browser ever fetches, because this branch cannot be reached where `Worker`
         * exists. Hiding the specifier keeps it out of the build and leaves the import for the
         * one runtime that does take this path.
         */
        const bundled = 'elkjs/lib/elk.bundled.js'
        const { default: ELKBundled } = (await import(/* @vite-ignore */ bundled)) as {
          default: new () => ELK
        }
        return new ELKBundled()
      }
      const [{ default: ELKApi }, { default: ElkWorker }] = await Promise.all([
        import('elkjs/lib/elk-api'),
        import('elkjs/lib/elk-worker.min.js?worker'),
      ])
      return new ELKApi({ workerFactory: () => new ElkWorker() })
    })().catch((error: unknown) => {
      // Don't cache a failed load: a transient chunk fetch failure would otherwise make every
      // later arrange fail too, for the rest of the session.
      enginePromise = undefined
      throw error
    })
  }
  return enginePromise
}

/**
 * Run ELK over an already-built graph.
 *
 * Exported because the workspace canvas is no longer the only caller: the Paths node lays out
 * the *connectome* it found, and both want one lazily-loaded engine instance rather than two
 * copies of the 1.4 MB build. The mapping stays with whoever owns the domain — `elkGraph.ts`
 * for editor cards, `layout/network.ts` for a NetworkValue — and only the runner is shared.
 */
export async function runElk(graph: ElkNode): Promise<ElkNode> {
  const elk = await engine()
  return elk.layout(graph)
}

/** Lay out a set of nodes and the edges among them, returning ELK's raw origin-based positions. */
export async function runLayout(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  options: LayoutOptions,
  measured?: MeasuredSizes,
): Promise<Map<string, XY>> {
  if (nodes.length === 0) return new Map()
  const laid = await runElk(toElkGraph(nodes, edges, options, measured))
  return positionsFrom(laid)
}
