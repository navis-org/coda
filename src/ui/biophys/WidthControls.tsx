/**
 * The two dendrogram width controls the Compartment Model's tabs share: draw to scale, and by how
 * much less than the true radii — below 1 to draw thick branches that overlap apart.
 */

import { useState } from 'react'

/** The thinnest the width factor goes: below it everything sits on the half-pixel floor anyway. */
const WIDTH_SCALE_MIN = 0.1

/**
 * The settings and their controls: `scale`, the factor true radii are drawn at — undefined where
 * widths are not to scale — and the bar's two inputs.
 */
export function useWidthControls(withRadii: boolean, title: string) {
  const [on, setOn] = useState(true)
  const [widthScale, setWidthScale] = useState(1)
  // What is typed while it is under the floor: "0" on the way to "0.5" is not yet a value, and
  // clamping it on the keystroke would turn "0.5" into "0.15".
  const [draft, setDraft] = useState<string | undefined>()
  const clamped = (v: number) => Math.min(1, Math.max(WIDTH_SCALE_MIN, v))
  const toScale = on && withRadii
  const controls = (
    <>
      <label
        className="topo__check nodrag"
        title={withRadii ? title : 'This skeleton has no radii to draw'}
      >
        <input
          type="checkbox"
          checked={toScale}
          disabled={!withRadii}
          onChange={(e) => setOn(e.target.checked)}
        />
        To scale
      </label>
      {toScale && (
        <label
          className="topo__check nodrag"
          title="Widths as a share of the true radii: below 1 draws thick branches that overlap apart"
        >
          Width ×
          <input
            type="number"
            className="topo__number"
            value={draft ?? widthScale}
            min={WIDTH_SCALE_MIN}
            max={1}
            step={0.1}
            onChange={(e) => {
              const text = e.target.value
              const v = Number(text)
              if (text === '' || !Number.isFinite(v) || v < WIDTH_SCALE_MIN)
                return setDraft(text)
              setDraft(undefined)
              setWidthScale(clamped(v))
            }}
            onBlur={() => {
              // Left under the floor, it is the floor; left empty or unreadable, what it was.
              const v = Number(draft)
              if (draft !== undefined && draft !== '' && Number.isFinite(v))
                setWidthScale(clamped(v))
              setDraft(undefined)
            }}
          />
        </label>
      )}
    </>
  )
  return { scale: toScale ? widthScale : undefined, controls }
}
