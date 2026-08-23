/**
 * The body of a dataset node: a preview, a version dropdown, and what the server actually says.
 *
 * The dropdown is a real param rendered through `ParamField`, not a bespoke `<select>`, so the
 * version stays saved, undoable, inspectable and part of the provenance key exactly like every
 * other param. The body decides *placement*, never semantics.
 *
 * The status line under it is the point of having a body at all: a dataset node's whole job is to
 * say which data everything downstream is about, and "Latest" is only an honest label if the
 * version it resolves to is visible next to it.
 */

import { datasetRef } from '../../core/types'
import { getSource } from '../../data/source'
import { datasetFamily, splitDataset, versionsFor } from '../../nodes/lib/datasetFamilies'
import { serverLabel } from '../../data/neuprint/servers'
import { findParam } from '../../core/node'
import { getNodeDef } from '../../core/registry'
import { formatNumber } from '../format'
import { useGraphStore } from '../../store/graphStore'
import { edgeSetLabel, hasEdgeSet } from '../../nodes/lib/edgeParams'
import { ParamField } from '../params/ParamField'
import type { NodeBodyProps } from './nodeBodies'
import { DatasetPreview } from './DatasetPreview'

export function DatasetBody({ node, ctx, compact, setParam }: NodeBodyProps) {
  const def = getNodeDef(node.type)
  const openEdgePanel = useGraphStore((s) => s.openEdgePanel)
  const family = datasetFamily(node.type.replace(/^dataset\./, ''))
  // The node's own output type carries the resolved dataset id — the same value `evaluate` will
  // use — so reading it back is how the caption stays in step with the provenance key.
  const outputs = def?.inferOutputs?.(ctx)
  const ref = datasetRef(outputs?.['dataset'])
  const datasetId = ref?.datasetId
  const source = ref?.sourceId ? getSource(ref.sourceId) : undefined
  const info = datasetId && source ? source.peekDataset(datasetId) : undefined

  const versionParam = def ? findParam(def, 'version') : undefined
  const serverParam = def ? findParam(def, 'server') : undefined
  const datasetParam = def ? findParam(def, 'dataset') : undefined

  const [, version] = splitDataset(datasetId ?? '')
  const known = family ? versionsFor(family) : []
  const caption = datasetId
    ? version || info?.version || datasetId
    : known.length === 0
      ? 'no versions listed yet'
      : undefined

  /*
   * The button is the indicator, and that is not a convenience.
   *
   * An attached edge set replaces every connectivity answer for this dataset and arrives through
   * a panel rather than a wire — so there is nothing on the canvas saying the numbers came from a
   * file. A card that looked identical either way would be exactly the silent result-change this
   * codebase keeps writing post-mortems about, which is why the label carries the set's name and
   * the button is pressed rather than merely present.
   *
   * Absent where the node has no such param at all — CATMAID's, by `DatasetBackend.edgeSets`.
   */
  const edgesParam = def ? findParam(def, 'edgeSetId') : undefined
  const attached = hasEdgeSet(node.params)
  // Through the same resolver the refusal uses, or the card names one set and the error another.
  const edgeSetName = attached ? edgeSetLabel(node.params) : ''

  const rois = info?.rois.length ?? 0
  const facts = [
    info?.neuronCount ? `${formatNumber(info.neuronCount)} neurons` : undefined,
    rois > 0 ? `${formatNumber(rois)} ROIs` : undefined,
  ].filter(Boolean)

  return (
    <div className="dataset-body nodrag">
      <DatasetPreview glyph={family?.glyph ?? 'specimen'} caption={caption} />

      <div className="dataset-body__fields">
        {/* Rendered in the order they are asked for: which server, then which dataset, then
            which version. A custom node has the first two; a family node only the third. */}
        {[serverParam, datasetParam, versionParam].map((param) =>
          param ? (
            <label key={param.id} className="dataset-body__field">
              <span className="param__label" title={param.help ?? param.label}>
                {param.label}
              </span>
              <ParamField
                param={param}
                value={node.params[param.id]}
                ctx={ctx}
                onChange={(value) => setParam(param.id, value)}
              />
            </label>
          ) : null,
        )}
      </div>

      <div className="dataset-body__foot">
        <span className="dataset-body__id" title={datasetId ?? 'no dataset resolved'}>
          {datasetId ?? '—'}
        </span>
        {/* Only the custom node has a server worth naming; a family node's is always Janelia. */}
        {!compact && serverParam && (
          <span className="dataset-body__server">
            {serverLabel(String(node.params.server ?? ''))}
          </span>
        )}
        {facts.length > 0 && <span className="dataset-body__facts">{facts.join(' · ')}</span>}
        {edgesParam && (
          <button
            type="button"
            className="dataset-body__edges"
            aria-pressed={attached}
            title={
              attached
                ? `Connectivity comes from the edge set "${edgeSetName}"`
                : 'Attach a user-supplied edge list'
            }
            onClick={() => openEdgePanel(node.id)}
          >
            {attached ? `⇄ ${edgeSetName}` : '⇄ Edge data'}
          </button>
        )}
        <button
          type="button"
          className="dataset-body__refresh"
          title="Re-fetch this dataset's metadata"
          aria-label="Refresh dataset metadata"
          onClick={() => {
            const source = ref?.sourceId ? getSource(ref.sourceId) : undefined
            void source?.listDatasets()
            setParam('refresh', Number(node.params.refresh ?? 0) + 1)
          }}
        >
          ⟳
        </button>
      </div>
    </div>
  )
}
