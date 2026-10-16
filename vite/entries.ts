/**
 * Build entries that are frames rather than pages, read by `vite/seo.ts` and `vite/goatcounter.ts`
 * so the two cannot disagree. `neuroglancer.html` is Coda's own neuroglancer, only ever loaded inside
 * the Neuroglancer card with a scene in its fragment: no sitemap row, and no analytics tag, since a
 * hit per mounted card would be event tracking by another name (`docs/analytics.md`).
 */
export const FRAME_ENTRIES: ReadonlySet<string> = new Set(['neuroglancer.html'])
