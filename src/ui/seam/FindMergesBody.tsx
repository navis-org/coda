/**
 * Find Merges' card: the params, what the run found, and where to draw the line.
 *
 * ## Why this node has a body at all
 *
 * The model is uncalibrated, so there is no cutoff anybody can be told — the only honest answer
 * is "look at your scores and pick one". That was unanswerable from the generic card: the scores
 * were in a Table output, the cutoff was a text field three nodes away from it, and the first
 * real run of the node produced a picture (every cell one fragment) that looked like a verdict
 * from the model and was in fact the empty cutoff. A histogram beside the field is the whole fix.
 *
 * ## It costs nothing to move the line
 *
 * `Score cutoff` is `presentational`, so it is not in the provenance key and nothing re-runs when
 * it changes. Everything here is folded out of the `Table` the last run published
 * (`summariseMerges`), which is a pass over a few hundred rows — a frame, against the minutes a
 * re-tile and re-score would cost. That is the reason the cutoff stopped filtering the outputs:
 * a line you cannot afford to move is not a line you can explore with.
 *
 * ## Two numbers, read together
 *
 * `cells` is how many windows were scored and `fragments` is how many pieces the per-point head
 * cut them into — equal when the model found nothing to cut anywhere. The gap between them is
 * the second signal this node has, and it is independent of the score: SEAM's `piece_loss` skips
 * windows with no masked points, so the head is untrained on clean windows and a cut there means
 * nothing on its own. A cell that scores high *and* splits is the one worth opening.
 */

import { useMemo } from 'react'

import { getNodeDef } from '../../core/registry'
import { isTableValue } from '../../core/values'
import { SCORE_BINS, cutoffForFraction, summariseMerges } from '../../packs/seam/mergeSummary'
import { useGraphStore } from '../../store/graphStore'
import { CHART_INK, sequentialColor } from '../../style/colors'
import { formatNumber } from '../../style/format'
import { ParamField } from '../params/ParamField'
import { cardParams } from '../params/paramGroups'
import type { NodeBodyProps } from '../nodes/nodeBodies'
import { useThemeMode } from '../useThemeMode'

/** The histogram's own coordinates. Drawn into whatever width the card gives it. */
const PLOT_WIDTH = 100
const PLOT_HEIGHT = 30

export function FindMergesBody({ node, ctx, compact, setParam }: NodeBodyProps) {
  const def = getNodeDef(node.type)
  const mode = useThemeMode()

  /*
   * Subscribed to, not read. `nodeOutput` is called inside the selector below, but a run moves
   * nothing else this component selects — the graph object, the params and the node are all
   * unchanged by one — so without a tick to depend on, the card would show whatever the table
   * was when it mounted. `CodaNodeView` and `ViewerSurface` both carry the same line.
   */
  void useGraphStore((s) => s.runVersion)
  const table = useGraphStore((s) => s.nodeOutput(node.id, 'windows'))

  const cutoff = readCutoff(node.params.cutoff)
  const summary = useMemo(
    () => summariseMerges(isTableValue(table) ? table : undefined, cutoff),
    [table, cutoff],
  )

  const fields = cardParams(def, node.params)

  const pick = (event: React.MouseEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    // jsdom lays nothing out, so every rect is zero wide; a click there would otherwise read as
    // a cutoff of 0 and look like a deliberate one.
    if (box.width <= 0) return
    const at = cutoffForFraction((event.clientX - box.left) / box.width)
    // Clicking the bar the line already sits on clears it, so the gesture that set a cutoff is
    // also the one that takes it away and there is no second control to find.
    setParam('cutoff', cutoff !== undefined && Math.abs(at - cutoff) < 1e-9 ? '' : String(at))
  }

  return (
    <div className="list-body nodrag">
      <div className="list-body__fields">
        {fields.map((param) => (
          <label key={param.id} className="list-body__field">
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
        ))}
      </div>

      {!summary ? (
        <div className="list-body__foot list-body__foot--empty">
          Not run yet — the histogram shows the scores once it has.
        </div>
      ) : (
        <>
          <svg
            className="merge-hist"
            viewBox={`0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`Score distribution over ${summary.cells} cells. Click to set the cutoff.`}
            onClick={pick}
          >
            {summary.bins.map((count, i) => {
              const width = PLOT_WIDTH / SCORE_BINS
              // Square-rooted, not linear: a neuron's scores pile up against 0 and the tail at
              // the top — which is the part anybody is looking for — would be a line of pixels
              // under a bar fifty times its height.
              const height = (Math.sqrt(count) / Math.sqrt(summary.tallest)) * PLOT_HEIGHT
              const dim = cutoff !== undefined && (i + 1) / SCORE_BINS <= cutoff
              return (
                <rect
                  key={i}
                  x={i * width}
                  y={PLOT_HEIGHT - height}
                  width={Math.max(0, width - 0.5)}
                  height={height}
                  // The same ramp the score layer paints the points with, so a tall bar on the
                  // right is the colour of the points it is about.
                  fill={sequentialColor((i + 0.5) / SCORE_BINS, mode)}
                  opacity={dim ? 0.25 : 1}
                >
                  <title>{`${(i / SCORE_BINS).toFixed(2)}–${((i + 1) / SCORE_BINS).toFixed(2)}: ${count} cells`}</title>
                </rect>
              )
            })}
            {cutoff !== undefined && (
              <line
                x1={cutoff * PLOT_WIDTH}
                x2={cutoff * PLOT_WIDTH}
                y1={0}
                y2={PLOT_HEIGHT}
                stroke={CHART_INK[mode].primary}
                strokeWidth={0.5}
              />
            )}
          </svg>
          <div className="list-body__foot">
            <span title="Neurons with at least one scored cell">
              {formatNumber(summary.neurons)} neuron{summary.neurons === 1 ? '' : 's'}
            </span>
            <span title="Grid cells scored. One cell is one 15 µm window the model saw.">
              {formatNumber(summary.cells)} cells
            </span>
            <span
              title={`Pieces the per-point head cut the cells into. Equal to the cell count where it found nothing to cut; here it cut ${summary.cut}.`}
            >
              {formatNumber(summary.fragments)} fragments
            </span>
            <span title="Lowest, middle and highest cell score">
              {summary.minScore.toFixed(2)} · {summary.medianScore.toFixed(2)} ·{' '}
              {summary.maxScore.toFixed(2)}
            </span>
            {summary.above !== undefined && (
              <span
                title={`Cells scoring ${cutoff} or above. Filter Table on \`score\` keeps them.`}
              >
                ≥ {cutoff}: {formatNumber(summary.above)}
              </span>
            )}
          </div>
          {!compact && (
            <div className="list-body__note">
              Click a bar to put the cutoff at its left edge, or click the line’s own bar to
              clear it. The cutoff only counts — to keep those cells, put the number into a
              Filter Table on <code>score</code>.
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** The param as a number, or `undefined` for "no line" and for anything unreadable. */
function readCutoff(raw: unknown): number | undefined {
  const text = String(raw ?? '').trim()
  if (!text) return undefined
  const value = Number(text)
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined
}
