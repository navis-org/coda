/**
 * The changelog's dates, spelled once for its three readers: the build-time renderer, the page's
 * script and the editor's What's New card.
 *
 * No imports, like `seen.ts`, so the static page and the editor can both afford it. Not `Intl`:
 * `en-GB` writes "Sept" and `en-US` puts the month first, and this is one format everywhere.
 *
 * A date is `YYYY-MM-DD` and, as an instant, **noon UTC** on that day — so an instant stepped by
 * whole days, or interpolated between two dates, never lands on the neighbouring day by rounding.
 */

export const DAY_MS = 86_400_000

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const

/** The date as an instant: noon UTC. */
export const ms = (date: string): number => Date.parse(`${date}T12:00:00Z`)
/** The date an instant falls on, in UTC. */
export const dayOf = (t: number): string => new Date(t).toISOString().slice(0, 10)

const month = (date: string): string => MONTHS[Number(date.slice(5, 7)) - 1] ?? ''
const day = (date: string): number => Number(date.slice(8, 10))

/** `25 Sep` */
export const shortDate = (date: string): string => `${day(date)} ${month(date).slice(0, 3)}`
/** `25 September 2026` */
export const longDate = (date: string): string =>
  `${day(date)} ${month(date)} ${date.slice(0, 4)}`
/** `Sep` */
export const shortMonth = (date: string): string => month(date).slice(0, 3)
/** `September 2026` */
export const monthYear = (date: string): string => `${month(date)} ${date.slice(0, 4)}`
