/**
 * The Clamp tab's preview: the card's injected current over the whole run, drawn as it stands —
 * before any run, and redrawn as a field changes. Each column is the least and greatest current
 * over the steps it holds (`clampEnvelope`), so a pulse narrower than a pixel still shows.
 *
 * Only the waveform: where it is injected is the Sites tab's.
 */

import { useMemo } from 'react'

import type { ParamValues } from '../../core/node'
import { clampEnvelope, clampWaveformOf } from '../../packs/biophys/simulateOps'
import { CHART_INK } from '../../style/colors'
import { formatCompact, formatNumber } from '../../style/format'
import { currentMode } from '../useThemeMode'
import { zeroDomain } from '../viewers/scatterPlot'

const WIDTH = 260
const HEIGHT = 72
const PAD = { left: 38, right: 6, top: 6, bottom: 16 }
const PLOT = { w: WIDTH - PAD.left - PAD.right, h: HEIGHT - PAD.top - PAD.bottom }

export function ClampPreview({ params }: { params: ParamValues }) {
  const ink = CHART_INK[currentMode()]
  const on = params.clamp === true
  const duration = Number(params.duration)
  const dt = Number(params.dt)
  // By value: the sidebar hands a fresh params object every render, and the envelope reads every
  // step of the run.
  const waveform = JSON.stringify(clampWaveformOf(params))
  const drawn = useMemo(() => {
    if (!on || !(duration > 0) || !(dt > 0)) return undefined
    const { lo, hi } = clampEnvelope(JSON.parse(waveform), dt, duration, PLOT.w)
    // The Playback strip's axis: zero in it, a unit tall where flat.
    const { min, max } = zeroDomain([...lo, ...hi])
    const y = (v: number) => PAD.top + PLOT.h * (1 - (v - min) / (max - min))
    const x = (i: number) => PAD.left + i + 0.5
    // The band between each column's extremes, closed: a pulse train reads as solid blocks.
    let d = ''
    for (let i = 0; i < hi.length; i++) d += `${i === 0 ? 'M' : 'L'}${x(i)} ${y(hi[i]!)}`
    for (let i = lo.length - 1; i >= 0; i--) d += `L${x(i)} ${y(lo[i]!)}`
    return { d: `${d}Z`, min, max, zero: y(0) }
  }, [on, duration, dt, waveform])

  if (!on) {
    return <p className="clamp-preview__note">Tick Inject current to see its waveform here.</p>
  }
  if (!drawn) return null
  return (
    <figure className="clamp-preview">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        width="100%"
        role="img"
        aria-label={`Injected current over the ${formatNumber(duration)} ms run`}
      >
        <line
          x1={PAD.left}
          x2={WIDTH - PAD.right}
          y1={drawn.zero}
          y2={drawn.zero}
          stroke={ink.grid}
        />
        <path d={drawn.d} fill={ink.secondary} stroke={ink.secondary} strokeWidth={1} />
        {[drawn.max, drawn.min].map((v, i) => (
          <text
            key={i}
            x={PAD.left - 5}
            y={i === 0 ? PAD.top + 4 : PAD.top + PLOT.h}
            textAnchor="end"
            fontSize={9}
            fill={ink.muted}
          >
            {formatCompact(v)} nA
          </text>
        ))}
        <text x={PAD.left} y={HEIGHT - 3} fontSize={9} fill={ink.muted}>
          0
        </text>
        <text
          x={WIDTH - PAD.right}
          y={HEIGHT - 3}
          textAnchor="end"
          fontSize={9}
          fill={ink.muted}
        >
          {formatNumber(duration)} ms
        </text>
      </svg>
      <figcaption className="clamp-preview__note">
        The injected current over the run.
      </figcaption>
    </figure>
  )
}
