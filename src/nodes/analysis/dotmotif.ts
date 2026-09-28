import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import { isNetworkValue } from '../../core/values'
import { runDotMotif } from '../../pyodide/dotmotif'
import { dotmotifSchema, dotmotifTable } from '../lib/dotmotifOps'
import { induceSubnetwork } from '../lib/networkOps'

registerNode({
  type: 'net.dotmotif',
  label: 'DotMotif',
  category: 'analysis',
  description: 'Search a network for a DotMotif pattern, locally in your browser.',
  guide:
    'Searches the wired network using DotMotif, including node and link attributes. ' +
    'Matches lists each variable’s node in each occurrence; Induced union contains every ' +
    'link between the matched nodes, not just motif links. Runs in a local worker; difficult ' +
    'searches can take a long time even with a small result limit, and can be cancelled.',
  cost: 'expensive',
  inputs: [{ id: 'in', label: 'Network', type: T.network() }],
  outputs: [
    { id: 'matches', label: 'Matches', type: T.table(dotmotifSchema()) },
    { id: 'network', label: 'Induced union', type: T.network() },
  ],
  params: [
    {
      id: 'query',
      label: 'Motif',
      kind: 'string',
      multiline: true,
      default: 'A -> B\nB -> C\nA -> C',
      help: 'DotMotif DSL, not Python or Cypher. The default finds feed-forward triangles. Use the node help for attribute constraints and supported syntax.',
    },
    {
      id: 'maxMatches',
      label: 'Max matches',
      kind: 'int',
      default: 1000,
      min: 1,
      help: 'Stop after this many role assignments. This limits returned matches, not search time; reaching it does not prove there are more. Symmetric assignments are separate matches.',
    },
  ],
  inferOutputs: (ctx) => ({
    matches: T.table(dotmotifSchema()),
    network: T.network(ctx.attributes('in', 'nodes'), ctx.attributes('in', 'edges')),
  }),
  validate: (ctx) => {
    const issues: string[] = []
    if (!String(ctx.params.query).trim()) issues.push('Enter a DotMotif pattern.')
    const limit = Number(ctx.params.maxMatches)
    if (!Number.isSafeInteger(limit) || limit < 1) {
      issues.push('Max matches must be a positive whole number.')
    }
    return issues
  },
  evaluate: async (ctx) => {
    const network = ctx.input('in')
    if (!isNetworkValue(network)) throw new Error('Wire a Network into DotMotif.')
    const result = await runDotMotif(
      {
        directed: network.directed,
        nodes: network.nodes.data,
        edges: network.edges.data,
        query: String(ctx.params.query),
        maxMatches: Number(ctx.params.maxMatches),
      },
      { signal: ctx.signal, onProgress: ctx.progress },
    )
    if (result.limitReached) {
      ctx.warn(
        `Stopped at ${result.count} matches; there may be more. Raise Max matches to search further. ` +
          'This is not a total motif count or a random sample.',
      )
    }
    return {
      matches: dotmotifTable(result),
      network: induceSubnetwork(network, new Set(result.nodeId)),
    }
  },
})
