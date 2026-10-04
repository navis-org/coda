/**
 * Targets by configuration: one instance per backend and location, so the base token, the column
 * list and the field list each target memoises are shared by every card on the same table and
 * survive a card re-rendering, collapsing or expanding. Keyed without building a target, so a card
 * can ask on every render.
 */

import { ClioTarget, clioKey, resetClioListings } from './clio'
import { CsvTarget, csvKey } from './csvFile'
import type { CsvTargetConfig } from './csvFile'
import { SeaTableTarget, seaTableKey } from './seaTable'
import type { SeaTableTargetConfig } from './seaTable'
import type { AnnotationTarget } from './types'

export type TargetConfig =
  | ({ backend: 'seaTable' } & SeaTableTargetConfig)
  | { backend: 'clio'; dataset: string }
  | ({ backend: 'csv' } & CsvTargetConfig)

const targets = new Map<string, AnnotationTarget>()

function keyOf(config: TargetConfig): string {
  if (config.backend === 'clio') return clioKey(config)
  return config.backend === 'csv' ? csvKey(config) : seaTableKey(config)
}

export function annotationTarget(config: TargetConfig): AnnotationTarget {
  const key = keyOf(config)
  let target = targets.get(key)
  if (!target) {
    target =
      config.backend === 'clio'
        ? new ClioTarget(config)
        : config.backend === 'csv'
          ? new CsvTarget(config)
          : new SeaTableTarget(config)
    targets.set(key, target)
  }
  return target
}

/** Test seam: the target a card configured this way gets — a card test's fake, under its key. */
export function registerAnnotationTarget(config: TargetConfig, target: AnnotationTarget): void {
  targets.set(keyOf(config), target)
}

/** Test seam: forget every target, and with them what each had memoised. */
export function resetAnnotationTargets(): void {
  targets.clear()
  resetClioListings()
}
