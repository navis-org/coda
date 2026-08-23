/**
 * The annotation providers, registered.
 *
 * Imported for the side effect, the same way `graphStore.ts` imports `../nodes`: a provider has
 * to exist before a saved graph resolves its refs, and a registration that happened later would
 * make one visibly lose its annotations on load.
 *
 * The re-exports are only what is consumed *outside* this directory. Modules inside it import
 * each other directly, and the tests reach their seams the same way — a barrel that re-exported
 * everything would be a list nobody reads, which is what it was.
 */

import './caveTable'
import './googleSheet'
import './seaTable'

export { CAVE_TABLE_PROVIDER } from './caveTable'
export {
  GOOGLE_SHEET_PROVIDER,
  parseSheetLocation,
  sheetConfigFrom,
  sheetExportUrl,
} from './googleSheet'
export { SEATABLE_PROVIDER, listBases } from './seaTable'
export { annotationProvider, peekRefColumns, subscribeAnnotationsLearned } from './registry'
export type { AnnotationRef } from './types'
export { refKey } from './types'
