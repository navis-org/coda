/**
 * Parsing CAVE's JSON without rounding the identifiers in it.
 *
 * CAVE answers `arrow_format=false` with ordinary `application/json`, which is what lets Coda
 * read it with no Arrow decoder and nothing new in the main chunk. The asterisk on that is
 * this file: **JSON cannot carry a 64-bit integer through `JSON.parse`**, and a CAVE root id is
 * eighteen digits. Measured against a real response body from `flywire_fafb_public` v783:
 *
 * ```text
 * raw text   "pt_root_id":720575940628857210
 * JSON.parse  720575940628857200   ✗ a different neuron, silently
 * this file  "720575940628857210"  ✓ matches the bytes on the wire
 * ```
 *
 * There is no reviver hook that helps — a reviver is handed the value *after* it has been
 * parsed, so the digits are already gone. The only place the exact value still exists is the
 * response text, so the fix has to happen there: quote every integer literal too wide for a
 * double, before the parser sees it. Which is invariant 8 arriving at CAVE's edge — an id
 * crosses the seam as text, and each source converts at its own edge.
 *
 * **The scan is string-aware, and that is not fussiness.** The obvious one-line
 * `raw.replace(/:(\d{16,})/g, ':"$1"')` is wrong on real FlyWire data: `neuron_information_v2`
 * is free-text user annotation, so a tag reading `root:720575940628857210` would have quotes
 * spliced into the middle of a string literal and the document would stop parsing. The
 * alternation below matches a **complete string literal first**, so the scanner consumes
 * strings whole and never looks inside one. Same technique, same reason, as any JSON-rewriting
 * that is not a bug waiting for the right input.
 *
 * Measured on the real 64 MB index response: 721 ms for the rewrite against 108 ms for a naive
 * `JSON.parse`, which is paid once per dataset behind the IndexedDB cache and against ~6 s of
 * network. Worth knowing before anyone puts this on a hot path.
 */

import type { DType } from '../../core/types'

/**
 * A complete string literal, **or** an integer literal in value position.
 *
 * The delimiter is part of the match rather than a lookbehind, which does two jobs: it keeps
 * this to features every target browser has had for years, and it means the fractional digits
 * of `0.1234567890123456789` can never *start* a match, since they are preceded by `.` rather
 * than by `:`, `,` or `[`. The trailing `(?![\d.eE])` closes the other end, so an integer part
 * of a decimal or the mantissa of an exponent is rejected rather than quoted into nonsense.
 *
 * 16 digits is the shortest that can overflow a double; the actual decision is made per match
 * by `Number.isSafeInteger`, so a 16-digit value that is genuinely exact stays a number.
 */
const VALUE_SCAN = /"(?:[^"\\]|\\.)*"|([:,[]\s*)(-?\d{16,})(?![\d.eE])/g

/**
 * Quote every integer literal that a double cannot hold exactly.
 *
 * Exported for the tests, which is most of the point: this is a text transformation with a
 * handful of ways to be subtly wrong, and each of them is a wrong neuron rather than an error.
 */
export function quoteWideIntegers(text: string): string {
  return text.replace(
    VALUE_SCAN,
    (match, prefix: string | undefined, digits: string | undefined) => {
      if (prefix === undefined || digits === undefined) return match
      return Number.isSafeInteger(Number(digits)) ? match : `${prefix}"${digits}"`
    },
  )
}

/**
 * `JSON.parse` for a CAVE response body.
 *
 * A wide integer arrives as a **string** of decimal digits, which is exactly what `NeuronId`
 * is and what every id column on this source is typed as. A number that fits stays a number,
 * so synapse counts, scores and positions are untouched.
 */
export function parseCaveJson<T>(text: string): T {
  return JSON.parse(quoteWideIntegers(text)) as T
}

/**
 * A parsed CAVE value's Coda dtype, or `undefined` for a null.
 *
 * Here, beside `quoteWideIntegers`, because this mapping is that function's other half and only
 * makes sense next to it: a root id arrives as a **string** and so types as `str`, not because
 * CAVE calls it text but because a float64 cannot hold eighteen digits and `parseCaveJson` quoted
 * it before the parser ever saw it (invariant 8). Two readers of the same rows were deciding this
 * independently — `sampleColumns` in `tables.ts` and `dtypesOf` in `annotations/caveTable.ts` —
 * so a change to what gets quoted would have had to be found in both, and the CAVE table info
 * card could have listed a column as `str` while the annotation table typed the same column of
 * the same table as `i64`.
 *
 * What is deliberately *not* shared is the all-null policy, because the two genuinely differ:
 * a column listing leaves it blank as an admission, an annotation table widens it to `str`.
 */
export function caveDType(
  value: string | number | boolean | null | undefined,
): DType | undefined {
  if (typeof value === 'boolean') return 'bool'
  if (typeof value === 'number') return Number.isInteger(value) ? 'i64' : 'f64'
  if (typeof value === 'string') return 'str'
  return undefined
}
