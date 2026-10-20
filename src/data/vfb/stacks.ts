/**
 * A VFB image stack (`volume.nrrd`), fetched for the Line Gallery's slice view.
 *
 * Measured 2026-10-14: every stack is 8-bit and gzip-encoded, 0.15–26 MB on the wire (0.2–0.8 s),
 * decoding to 115–325 MB — JRC2018U brain is 1210×566×174 at 0.519 × 0.519 × 1 µm, JRC2018U VNC
 * 660×1290×382. So one stack at a time is affordable and a gallery's worth is not; the caller holds
 * at most one. The format is `data/nrrd.ts`'; what is VFB's here is which host may be asked.
 *
 * VFB's own slice viewer renders slices of the Woolz files server-side, one request per view,
 * which is why it feels slow; the NRRD itself is a single fast download.
 */

import type { ImageStack } from '../nrrd'
import { decodeNrrd } from '../nrrd'
import { fetchBytes } from '../precomputed/transport'
import { vfbFileUrl } from './common'

/** Download and decode one stack. Only VFB's own file server is fetched (`vfbFileUrl`). */
export async function fetchImageStack(url: string, signal?: AbortSignal): Promise<ImageStack> {
  const bytes = new Uint8Array(await fetchBytes(vfbFileUrl(url), { signal }))
  signal?.throwIfAborted()
  return decodeNrrd(bytes, signal)
}
