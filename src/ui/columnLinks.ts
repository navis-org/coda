/**
 * Where an identifier column's values point, for a viewer that draws them as links.
 *
 * The one table of URLs for `ColumnSchema.link`. Every URL here is built on a fixed `https`
 * prefix, so a value arriving from a remote server can change the path and never the scheme or the
 * host — which is what lets `IdLink` label it with something other than the URL (it states the
 * exception). How each kind is *drawn*, hover included, is
 * `ColumnLinkCell.tsx`.
 */

import type { ColumnLink } from '../core/types'

const HREFS: Record<ColumnLink, (value: string) => string | undefined> = {
  // `encodeURI` keeps a DOI's `/` and `:` readable but leaves `#` and `?`, which a URL parser would
  // read as a fragment or a query: SICI DOIs end in `-#` (`…CO;2-#`), so those two are escaped too.
  doi: (value) => `https://doi.org/${encodeURI(value).replace(/[#?]/g, encodeURIComponent)}`,
  pmid: (value) =>
    /^\d+$/.test(value) ? `https://pubmed.ncbi.nlm.nih.gov/${value}/` : undefined,
  // A VFB or FlyBase term id — `VFB_fw000040`, `FBbt_00100234`, `VFBexp_…` — on VFB's own page.
  vfb: (value) =>
    /^(VFB|FB)\w*$/.test(value)
      ? `https://virtualflybrain.org/reports/${encodeURIComponent(value)}`
      : undefined,
}

/** The URL an identifier of this kind points at, or undefined when the value is not one. */
export function columnHref(link: ColumnLink, value: string): string | undefined {
  return value ? HREFS[link](value) : undefined
}
