/**
 * What a match's comparison view draws: which images, stacked how.
 *
 * Two independent choices, and the pure half of both lives here so the card only renders:
 *
 * - **Compare** — the EM neuron beside the LM image (`side`), the LM image alone (`lm`), or the EM
 *   neuron laid over it (`overlay`).
 * - **LM view** — the segmented hit CDS compared (`hit`), the whole sample it was cut out of
 *   (`line`), or the hit in colour over the whole sample in grey (`both`), which is how to see what
 *   else a line labels besides the neuron you came for.
 *
 * Measured on real files, and each finding is a rule below:
 *
 * - **Every CDS image of one match is the same size in the same space** — the EM search image, the
 *   segmented hit and the whole sample are all 1210 × 566 for a brain (573 × 1209 for a nerve
 *   cord). That is what makes stacking them a matter of drawing one over another.
 * - **`mirrored` means the EM has to be flipped to land on the LM.** On a mirrored hemibrain match,
 *   51% of the hit lies within 6 px of the EM neuron once one of them is flipped and 24% as
 *   published; on an unmirrored one, 79% and 0%. The **EM** is the one flipped, never the LM: the
 *   LM image is a real sample, and its whole-line context mirrored would misstate its anatomy.
 * - **A flipped image flips its scale bar and its "Max: 0604/4095" label too.** Both sit in a block
 *   about 260 × 70 px in the top-right corner of every CDS image, brain or nerve cord, so a flipped
 *   layer loses that corner (`hideCorner`) — as does the grey whole-line layer under a hit, whose
 *   label otherwise overprints the hit's with a different number.
 * - **PPPM is a different product.** Its images are 1427 × 668 and do not stack with the EM image;
 *   there is no standalone EM image at all; and its segmented hit sits on *grey*, which cannot be
 *   laid over anything. What it publishes instead are NeuronBridge's own overlays with the EM
 *   skeleton drawn in (`CDMSkel` over the whole line, `SignalMipMaskedSkel` over the hit). So under
 *   PPPM `overlay` uses those, `both` is unavailable, and the EM opacity control does nothing.
 */

import type { NbConfig, NbMethod } from './client'
import { fileUrl } from './client'
import type { NbImage, NbMatch } from './types'

export type NbCompare = 'side' | 'lm' | 'overlay'
export type NbLmView = 'hit' | 'line' | 'both'

/**
 * How an overlay draws the EM neuron. In its own depth colours a good match *coincides* with the
 * hit colour for colour — which is what CDS scores, and exactly why the EM then disappears into it:
 * the first overlay drawn in a browser showed no EM at all. White stands apart, so it is the default.
 */
export type NbEmTint = 'white' | 'colour'

export const COMPARE_MODES: readonly { id: NbCompare; label: string }[] = [
  { id: 'side', label: 'Side by side' },
  { id: 'lm', label: 'LM only' },
  { id: 'overlay', label: 'Overlay' },
]

export const LM_VIEWS: readonly { id: NbLmView; label: string }[] = [
  { id: 'hit', label: 'Hit' },
  { id: 'line', label: 'Whole line' },
  { id: 'both', label: 'Hit + line' },
]

/** The top-right block holding the colour scale and its "Max" label, in image pixels. */
export const SCALE_BAR_CORNER = { width: 270, height: 75 } as const

/** One image in a stack. Every flag is a drawing instruction; see the module header for why. */
export interface NbLayer {
  readonly url: string
  /** Mirrored left–right. */
  readonly flip?: true
  /** Greyscale and dimmed: context under a hit. */
  readonly grey?: true
  /** Composited with `lighten`, so its black ground leaves the layers under it alone. */
  readonly lighten?: true
  /** The scale-bar corner hidden. */
  readonly hideCorner?: true
  /** The EM layer of an overlay, whose opacity the card controls. */
  readonly em?: true
}

/** One picture: a stack of layers, drawn in order, and what to call it. */
export interface NbFigure {
  readonly id: 'em' | 'lm'
  readonly caption: string
  /** Empty when the files this picture needs are not published for this match. */
  readonly layers: readonly NbLayer[]
}

export interface NbComparison {
  readonly figures: readonly NbFigure[]
  /** The LM view actually drawn — `requested` unless this method cannot draw it. */
  readonly lmView: NbLmView
  /** LM views this method can draw. */
  readonly lmViews: readonly NbLmView[]
  /** Whether the EM opacity control changes anything. */
  readonly emOpacity: boolean
  /** Said under the picture when the request could not be drawn as asked. */
  readonly note?: string
}

export function lmViewsFor(method: NbMethod): readonly NbLmView[] {
  return method === 'pppm' ? ['hit', 'line'] : ['hit', 'line', 'both']
}

const LM_CAPTION: Record<NbLmView, string> = {
  hit: 'segmented hit',
  line: 'whole sample',
  both: 'hit over whole sample',
}

function layer(url: string | undefined, flags: Omit<NbLayer, 'url'> = {}): NbLayer[] {
  return url ? [{ url, ...flags }] : []
}

/**
 * The figures a comparison draws.
 *
 * `emImage` is the EM neuron's own record — the page's neuron — which PPPM needs for its side-by-side
 * view, having no EM image of its own. Under CDS the match's `CDMInput` is preferred, being the exact
 * image the search compared.
 */
export function comparisonFor(
  config: NbConfig,
  emImage: NbImage,
  match: NbMatch,
  method: NbMethod,
  compare: NbCompare,
  requested: NbLmView,
): NbComparison {
  const lmViews = lmViewsFor(method)
  const lmView = lmViews.includes(requested) ? requested : 'hit'
  const note =
    lmView === requested
      ? undefined
      : 'PPPM publishes its hit on grey, which cannot be laid over the line; showing the hit.'
  // A mirrored match is found against the mirror image, so the EM is flipped onto the LM — and
  // loses the scale-bar corner the flip would otherwise print backwards.
  const emFlags = match.mirrored ? ({ flip: true, hideCorner: true } as const) : {}
  const emCaption = `EM ${emImage.publishedName.split(':').pop() ?? emImage.publishedName}${
    match.mirrored ? ' · mirrored to match' : ''
  }`
  const line = match.image.publishedName
  const overlay = compare === 'overlay'

  // What each method publishes: the EM image, the LM layers, and whether this module draws the
  // overlay (CDS) or NeuronBridge already did (PPPM, with the EM skeleton drawn in).
  let em: NbLayer[]
  let lm: NbLayer[]
  let lmCaption = `LM ${line} · ${LM_CAPTION[lmView]}`
  if (method === 'pppm') {
    em = layer(
      fileUrl(config, emImage.files, 'CDM') ?? fileUrl(config, emImage.files, 'CDMThumbnail'),
      emFlags,
    )
    const kind = overlay
      ? lmView === 'line'
        ? 'CDMSkel'
        : 'SignalMipMaskedSkel'
      : lmView === 'line'
        ? 'CDMBest'
        : 'SignalMipMasked'
    lm = layer(fileUrl(config, match.files, kind))
    if (overlay) lmCaption += ' · EM skeleton drawn in by NeuronBridge'
  } else {
    const hit = fileUrl(config, match.files, 'CDMMatch')
    const whole = fileUrl(config, match.image.files, 'CDM')
    em = layer(
      fileUrl(config, match.files, 'CDMInput') ?? fileUrl(config, emImage.files, 'CDM'),
      emFlags,
    )
    lm =
      lmView === 'hit'
        ? layer(hit)
        : lmView === 'line'
          ? layer(whole)
          : [
              ...layer(whole, { grey: true, hideCorner: true }),
              ...layer(hit, { lighten: true }),
            ]
    if (overlay) {
      lm = [...lm, ...em.map((l): NbLayer => ({ ...l, lighten: true, em: true }))]
      lmCaption += ` + ${emCaption}`
    }
  }

  const lmFigure: NbFigure = { id: 'lm', caption: lmCaption, layers: lm }
  return {
    figures:
      compare === 'side'
        ? [{ id: 'em', caption: emCaption, layers: em }, lmFigure]
        : [lmFigure],
    lmView,
    lmViews,
    emOpacity: overlay && method === 'cds',
    ...(note ? { note } : {}),
  }
}

/**
 * The CSS `clip-path` that hides a layer's scale-bar corner, for an image of this natural size.
 *
 * In the layer's own coordinates, which `clip-path` is — so a flipped layer is clipped at its
 * top-right *before* the flip moves that corner to the top-left, which is exactly the block that
 * would otherwise read backwards.
 */
export function cornerClip(width: number, height: number): string | undefined {
  if (!(width > 0 && height > 0)) return undefined
  const x = Math.max(0, (1 - SCALE_BAR_CORNER.width / width) * 100)
  const y = Math.min(100, (SCALE_BAR_CORNER.height / height) * 100)
  const px = x.toFixed(2)
  const py = y.toFixed(2)
  return `polygon(0 0, ${px}% 0, ${px}% ${py}%, 100% ${py}%, 100% 100%, 0 100%)`
}
