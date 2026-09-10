/**
 * What Explore Dataset's screen map labels — see `NodeMap.tsx` for the button, `mapSpots.ts` for
 * the rules a spot follows.
 *
 * Every finder asks `root`, the surface's own body, and never the document: the card on the
 * canvas draws the same search box and the same rows, and a document-wide query unions the two
 * into a box the width of the window.
 *
 * **A repeated control is boxed on the first row only.** The checkbox and the tile are on every
 * row — twenty-five of each on a page — and one box round the first reads as "this control" where
 * a column of them reads as a column. The right-click is boxed on the name for the same reason:
 * the menu opens anywhere on a row, but it names the neuron, and the name is what says which one.
 * Chips take the first row that *has* any, since a row with no sparse field draws none. Classes
 * rather than anchors, the one exception `mapSpots.ts` allows, extended here: a row is repeated
 * markup, and an anchor on it would be twenty-five of one name.
 *
 * The copy follows `mapSpots.ts`' rule — the sentence says what the control does not, and the
 * search's is the syntax, because that is the half nobody predicts from an empty text field.
 */

import type { MapSpot } from '../tour/mapSpots'

const firstRow = (root: ParentNode) => root.querySelector('.explore__list .explore-row')

export const EXPLORE_MAP_SPOTS: readonly MapSpot[] = [
  {
    id: 'search',
    find: (root) => [root.querySelector('.explore__input')],
    label: 'Search',
    note: 'Every term must match, in any field. /…/ is a regex; class==sensory or type~^LC keeps a term to one field.',
    side: 'below',
  },
  {
    id: 'columns',
    find: (root) => [...root.querySelectorAll('.explore-head__cell')],
    label: 'Columns',
    note: 'Click a heading to change how it draws, rename or move it, or merge several fields into one.',
    side: 'below',
  },
  {
    id: 'add',
    find: (root) => [root.querySelector('.explore-head__add')],
    label: 'Add a field',
    note: 'Show any field as a column or as a chip, or hide one you are not reading.',
    side: 'below',
  },
  {
    id: 'pick',
    find: (root) => [firstRow(root)?.querySelector('.explore-row__pick')],
    label: 'Select',
    note: 'Ticked neurons leave through the Selected output, and stay ticked through a new search.',
    side: 'below',
  },
  {
    id: 'thumbnail',
    find: (root) => [firstRow(root)?.querySelector('.explore-thumb-slot, .explore-thumb')],
    label: 'Thumbnail',
    note: 'Hover for a larger preview that turns, so the shape reads from more than one side.',
    side: 'below',
  },
  {
    id: 'menu',
    // The name's own children rather than the block: `.explore-row__name` is a flex row that
    // stretches to the first column, so a box round it ran most of the way across the row.
    find: (root) => [...(firstRow(root)?.querySelector('.explore-row__name')?.children ?? [])],
    label: 'Right-click a row',
    note: 'Copy its id, or select or search for every neuron of its type.',
    side: 'below',
  },
  {
    id: 'chips',
    find: (root) => [root.querySelector('.explore__list .explore-row__chips')],
    label: 'Chips',
    note: 'Fields drawn as tags under the name. Right-click one to make it a column instead.',
    side: 'below',
  },
  {
    id: 'bulk',
    find: (root) => [...root.querySelectorAll('.explore__foot .explore__link')],
    label: 'Select in bulk',
    note: '+ page ticks this page and + all every match; the count clears the selection.',
    side: 'above',
  },
]
