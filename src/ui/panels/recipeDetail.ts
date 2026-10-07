import type { RecipeSummary } from '../../store/recipes'
import { plural } from '../../style/format'

/** What a stored recipe holds and what it attaches to — the palette row's hint and the shelf's line. */
export function recipeDetail(entry: RecipeSummary): string {
  const parts = [plural(entry.nodeTypes.length, 'card')]
  if (entry.slots.length) parts.push(`attaches to ${entry.slots.join(' or ')}`)
  return parts.join(' · ')
}
