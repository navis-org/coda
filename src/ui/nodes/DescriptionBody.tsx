/**
 * The body of a Description node: the blurb its publisher wrote, and nothing else.
 *
 * Nothing is added around it on purpose. The card sits directly under the dataset node that
 * feeds it, so restating the dataset id, the version or the neuron counts here would repeat what
 * is already on screen an inch away — and every line spent on that is a line not spent on the
 * text this card exists to show. What the source published is the content; the frame is the
 * node header.
 *
 * Drawn from `peekDataset`, the same synchronous cache the dataset node's own footer reads, so
 * the text appears as soon as the listing lands rather than waiting for this node to run. That is
 * what makes it an annotation rather than a result: the credit is visible from the moment the
 * dataset resolves.
 */

import { datasetRef } from '../../core/types'
import { getSource } from '../../data/source'
import { MarkdownView } from '../MarkdownView'
import type { NodeBodyProps } from './nodeBodies'

export function DescriptionBody({ ctx }: NodeBodyProps) {
  const ref = datasetRef(ctx.inputs.dataset)
  const source = ref?.sourceId ? getSource(ref.sourceId) : undefined
  const info = ref?.datasetId && source ? source.peekDataset(ref.datasetId) : undefined
  const text = info?.description?.trim()

  return (
    /* `nowheel` so the card scrolls under the pointer instead of zooming the canvas. */
    <div className="description-body nodrag nowheel">
      {text ? (
        <MarkdownView source={text} className="description-body__text" />
      ) : (
        /*
         * Three different absences, said apart. "No description" when the dataset is known and
         * simply publishes none is a fact about the dataset; the other two are states this card
         * is passing through, and collapsing them into one message would have a card that is
         * about to fill itself look like a card that never will.
         */
        <p className="description-body__empty">
          {!ref?.datasetId
            ? 'Connect a dataset to see what it covers, who published it and how to cite it.'
            : !info
              ? `${source?.label ?? 'The source'} has not listed its datasets yet.`
              : `${info.label} publishes no description.`}
        </p>
      )}
    </div>
  )
}
