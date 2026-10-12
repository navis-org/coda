import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import { isNetworkValue } from '../../core/values'
import { runDotMotif } from '../../pyodide/dotmotif'
import { plural } from '../../style/format'
import { matchColumns } from '../lib/dotmotifHost'
import {
  MAX_DOTMOTIF_MATCHES,
  dotmotifSchema,
  dotmotifTable,
  maxMatchesIssue,
  maxRolesFor,
  networkHost,
  queriedColumns,
} from '../lib/dotmotifOps'
import { induceSubnetwork } from '../lib/networkOps'

registerNode({
  type: 'net.dotmotif',
  label: 'DotMotif',
  category: 'analysis',
  description: 'Search a network for a DotMotif pattern, locally in your browser.',
  guide:
    'Searches the wired network with DotMotif’s GrandIso executor, including node and link attributes. ' +
    'Required edges must connect all roles. ' +
    'Matches lists each role’s node per occurrence; Induced union keeps every link between matched nodes. ' +
    'Runs locally and can be cancelled.',
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
      help: 'DotMotif DSL, not Python or Cypher. The default finds feed-forward triangles. See the node help for constraints and supported syntax.',
    },
    {
      id: 'maxMatches',
      label: 'Max matches',
      kind: 'int',
      default: 1000,
      min: 1,
      max: MAX_DOTMOTIF_MATCHES,
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
    const problem = maxMatchesIssue(Number(ctx.params.maxMatches))
    if (problem) issues.push(problem)
    return issues
  },
  evaluate: async (ctx) => {
    const network = ctx.input('in')
    if (!isNetworkValue(network)) throw new Error('Wire a Network into DotMotif.')
    const maxMatches = Number(ctx.params.maxMatches)
    // `validate` only warns, so a stored value it flags is refused here, before the worker.
    const problem = maxMatchesIssue(maxMatches)
    if (problem) throw new Error(problem)
    const host = networkHost(network)
    const query = String(ctx.params.query)
    const matches = await runDotMotif(
      {
        directed: network.directed,
        query,
        maxMatches,
        maxRoles: maxRolesFor(maxMatches),
        keyOfRow: host.keyOfRow,
        sources: host.sources,
        targets: host.targets,
        linkRows: host.linkRows,
        nodes: queriedColumns(network.nodes.data, query),
        edges: queriedColumns(network.edges.data, query),
      },
      { signal: ctx.signal, onProgress: ctx.progress },
    )
    if (matches.refused) throw new Error(maxMatchesIssue(maxMatches, matches.roles.length))
    if (matches.count === maxMatches) {
      ctx.warn(
        `Stopped at ${plural(matches.count, 'match', 'matches')}; there may be more. ` +
          'Raise `Max matches` to search further. ' +
          'This is not a total motif count or a random sample.',
      )
    }
    const columns = matchColumns(matches, host.ids)
    return {
      matches: dotmotifTable(columns),
      network: induceSubnetwork(network, new Set(columns.nodeId)),
    }
  },
})
