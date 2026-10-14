/**
 * The VFB term `id`, asked for while a component wants it: the hover's panel (mounted only while
 * open) and the VFB Info card's page. `termInfo` holds each term once per session, so asking again
 * — a second hover, a page turned back — costs nothing.
 */

import { useEffect, useState } from 'react'

import { errorMessage } from '../../core/errors'
import type { VfbTermInfo } from '../../data/vfb/client'
import { termInfo } from '../../data/vfb/client'

export interface LoadedTerm {
  readonly info?: VfbTermInfo
  readonly error?: string
}

/** What VFB said about `id`, or undefined while asking; an answer for another id is never shown. */
export function useTermInfo(id: string | undefined): LoadedTerm | undefined {
  const [loaded, setLoaded] = useState<(LoadedTerm & { id: string }) | undefined>(undefined)
  useEffect(() => {
    if (!id) return
    let current = true
    termInfo(id).then(
      (info) => current && setLoaded({ id, info }),
      (error: unknown) => current && setLoaded({ id, error: errorMessage(error) }),
    )
    return () => {
      current = false
    }
  }, [id])
  return loaded?.id === id ? loaded : undefined
}
