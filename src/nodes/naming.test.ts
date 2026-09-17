/**
 * A node that renames or mints columns says so in its `description`.
 *
 * **The `description` is the only prose a planning model is guaranteed to see.** The catalogue ships
 * at `lean` (`assistant/catalogue.ts`), which omits every param's `help`; a help document is served
 * only when the MCP server's `coda_node_details` is asked for one; and `producedColumns` can put a
 * `carries:` line in the catalogue only for a node that names columns with *nothing wired* — which
 * is exactly not these nodes, whose output names are a function of an input schema. A model that
 * plans a whole pipeline in one go therefore has the description and nothing else.
 *
 * Found by a model using the MCP server: it wired `sum_weight` correctly in the same plan that
 * created the Group By, because that node's description spells the rule out — and an audit then
 * found Group By was the only one that did. Everything below was silent, and the failure is a
 * downstream picker pointed at a column name that no longer exists, which `validate` reports only
 * once the plan has been applied.
 *
 * **Two kinds are listed below.** A node whose output names are a function of its *input* schema
 * (Group By, Join, Rename) has no catalogue `carries:` line at all. A node whose names are a
 * function of its *params* (Reduce Matrix, Centrality, Topology) has one, rendered at the defaults —
 * which is worse than none when the param moves, because it advertises a shape the node stops
 * producing: `carries: label, mean` stays put while `stats: [mean, sd]` produces `label, mean, sd`.
 *
 * The fragments are what a reader has to be told, not the whole sentence: reword freely, keep the
 * names.
 */

import { describe, expect, it } from 'vitest'
import './index'
import { getNodeDef, listableNodeDefs } from '../core/registry'

/** Node type → the names or rules its `description` must carry. */
const MINTED: Record<string, string[]> = {
  'core.groupBy': ['`<agg>_<column>`', '`n`'],
  'core.rename': ['`_2`'],
  'core.pivot': ['distinct values found in the Columns field'],
  'core.combineColumns': ['`Into`', '`_2`'],
  'core.relabel': ['`Into`', '`_2`'],
  'core.unpivot': ['`name` and `value`'],
  'core.qualifyIds': ['`dataset:id`'],
  'core.join': ['`_r`'],
  'core.uploadTable': ['`neuronId`', '`type`'],
  'core.tableFromUrl': ['`neuronId`', '`type`'],
  'net.build': ['`source`', '`weight`', '`degreeIn`'],
  'cluster.cut': ['`cluster`', '`order`', '`size`'],
  'cluster.selectedToNeurons': ['`_c`'],
  'cluster.clustersToNeurons': ['`_c`'],
  'neuron.mirror': ['`mirrored`'],
  'neuron.attachAttributes': ['replaces a same-named one'],
  // The name is a param, so the fragment is the default the description quotes plus the
  // overwrite rule — the half that is not obvious, since a cloud can already carry a `roi`.
  'neuron.pointsInVolumes': ['`roi`', 'written over'],
  'neuron.nblastKnn': ['`queryId`', '`targetId`'],
  'neuron.nblastMatches': ['`query`', '`matches`'],
  'out.describe': ['`non_nulls`'],
  // Columns that change with a param. The catalogue's `carries:` line is rendered at the defaults,
  // so it advertises one shape and the node produces another the moment the param moves.
  'core.reduceMatrix': ['`label`', 'one column per statistic', '`zap_mean`'],
  'net.centrality': ['`betweenness`', '`community`'],
  'out.topology': ['`cableLength`', '`cableAxon`'],
  'neuron.influence': ['`influence`', '`queryId`'],
  'neuron.connectivity': ['`preId`', '`weightNorm`', '`roi`'],
  'neuron.paths': ['`bottleneck`', '`bottleneckNorm`'],
  'compare.connectivity': ['`weight_<name>`', '`present_<name>`'],
}

describe('a node that renames columns says so in its description', () => {
  it.each(Object.entries(MINTED))('%s', (type, fragments) => {
    const def = getNodeDef(type)
    expect(def, `${type} is not registered`).toBeDefined()
    for (const fragment of fragments) {
      expect(def?.description ?? '', type).toContain(fragment)
    }
  })

  /*
   * Every annotation node, however it was registered: the SeaTable and FlyTable ones come from a
   * template over a spec, so naming them individually would leave the next one silent.
   */
  it('every annotation node says a cell_type column arrives as type', () => {
    const annotations = listableNodeDefs().filter((def) => def.type.startsWith('annotation.'))
    expect(annotations.length).toBeGreaterThan(2)
    for (const def of annotations) {
      expect(def.description ?? '', def.type).toContain('renamed `type`')
    }
  })
})
