/**
 * A place in a full-size surface's header that the viewer inside may draw into.
 *
 * `ViewerSurface` owns the header and the viewer owns its own caption, so a viewer that would
 * rather stand its buttons in the header than in a footer of its own needs somewhere to put them
 * — a portal target, since the header is not an ancestor of the body. `null` means there is no
 * such header (a canvas card, a test), and the viewer draws its footer as before. Opt-in per
 * viewer: one that never reads this keeps its caption where it was.
 */
import { createContext } from 'react'

export const HeaderSlot = createContext<HTMLElement | null>(null)
