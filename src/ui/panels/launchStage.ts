/**
 * Which of the two launch modals is showing, in one place.
 *
 * The sequence a first visit sees is: the guides dialog, then the welcome page, then the canvas.
 * Two surfaces have to agree about that — `GuidesDialog` decides whether to draw, and
 * `StartPage` has to stand down while it is up — and written per surface it would be the same
 * boolean expression twice, of which the second copy is the one that goes stale.
 *
 * **The stage is derived rather than stored, and that is what keeps the sequence closable.**
 * `startPageOpen` means "the launch sequence is on screen"; `guidesOpen` means "it is still at
 * its first stage". So everything that already ended the sequence — the toolbar, a share link,
 * `openZoo`, every test that just wants the canvas — ends it from either stage, without having
 * learned that there is a new modal to close. A second independent boolean would have needed
 * each of those callers to say so again.
 *
 * Both selectors read primitives, per invariant 7.
 */

import { useGraphStore } from '../../store/graphStore'

export type LaunchStage = 'guides' | 'welcome' | 'none'

export function useLaunchStage(): LaunchStage {
  const open = useGraphStore((s) => s.startPageOpen)
  const guides = useGraphStore((s) => s.guidesOpen)
  if (!open) return 'none'
  return guides ? 'guides' : 'welcome'
}
