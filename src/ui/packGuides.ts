/**
 * Where a pack's guide is: its page (`PackDefinition.guide`, rendered at build time by
 * `src/packguide/render.ts`) beside the editor. Three surfaces link to it — the `?` menu's
 * Documentation, a node's help and the Plugins dialog's row — so the URL is spelled here once.
 */

import { useMemo } from 'react'

import type { PackDefinition } from '../core/registry'
import { getPack, packOfType, registeredPacks } from '../core/registry'
import { useOfferedPack } from './packSwitches'

/** A pack that has a guide. */
export type GuidedPack = PackDefinition & {
  readonly guide: NonNullable<PackDefinition['guide']>
}

export function isGuided(pack: PackDefinition | undefined): pack is GuidedPack {
  return pack?.guide !== undefined
}

/** Through `BASE_URL`, since `base` is './' and an absolute path breaks a subpath deploy. */
export function packGuideUrl(pack: GuidedPack): string {
  return `${import.meta.env.BASE_URL}${pack.guide.page}`
}

/** The pack a node type is from, where that pack has a guide. */
export function guidedPackOf(type: string): GuidedPack | undefined {
  const id = packOfType(type)
  const pack = id === undefined ? undefined : getPack(id)
  return isGuided(pack) ? pack : undefined
}

/** The packs with a guide that are offered here — a switched-off pack's guide is not listed. */
export function useOfferedGuides(): readonly GuidedPack[] {
  const offered = useOfferedPack()
  return useMemo(
    () =>
      registeredPacks()
        .filter(isGuided)
        .filter((p) => offered(p.id)),
    [offered],
  )
}
