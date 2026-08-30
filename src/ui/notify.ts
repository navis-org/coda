/**
 * Telling somebody a run finished while they were looking at something else.
 *
 * **Two channels, and only the second one asks for anything.** The tab's own title is rewritten
 * — `✓ Run finished` — whenever a long run lands on a tab nobody is watching; that costs no
 * permission, works in every browser including an iPhone's Safari, and is invisible to anyone
 * who *is* watching, because it is reverted the moment they come back. On top of that sits a
 * real OS notification, which is opt-in and is the whole reason the rest of this file exists.
 *
 * They are complementary rather than redundant, and the redundancy is load-bearing: a desktop
 * notification auto-dismisses after ~20s unless the OS is set to keep alerts, so somebody away
 * for an hour may well come back to no notification at all. The title is still saying it.
 *
 * **Permission can only be asked for from a user gesture.** Safari enforces it outright and the
 * others treat it as an abuse signal, so `requestNotifyPermission` is reachable only from the
 * toolbar's bell — the opt-in *is* the prompt. This is also why the preference cannot simply be
 * restored and acted on: the same rule `fullscreen.ts` records for the same reason.
 *
 * **`denied` is terminal.** Once refused, a page can never ask again — only the user can undo it
 * in browser settings, and there is no API to detect that they have. So the stored preference is
 * *not* the truth about whether notifications will appear; `notifyState()` is, and the bell draws
 * from both. A toggle that latched on while the browser was silently dropping every notification
 * is the failure this whole file would otherwise present as.
 */

import { useEffect, useRef } from 'react'

import type { RunSummary } from '../core/scheduler'
import { useGraphStore } from '../store/graphStore'
import { formatDuration, plural } from './format'

/**
 * How long a run must have taken before finishing it is worth saying anything about.
 *
 * A floor rather than a distinction between manual and automatic runs, because auto-run makes
 * the same wait: what decides whether somebody switched away is the duration, not which button
 * started it. Fifteen seconds is above every cached re-run and every mock-dataset graph — the
 * things that finish while you are still typing — and below any real neuPrint or CAVE query,
 * which is the regime this exists for.
 */
export const NOTIFY_AFTER_MS = 15_000

/**
 * One tag for every run, so a second notification *replaces* the first rather than stacking.
 *
 * Somebody away for an hour with auto-run on would otherwise come back to a column of them, each
 * saying the same thing about a graph that has since run again. Only the newest is true.
 */
const RUN_TAG = 'coda-run'

// ---------------------------------------------------------------------------
// Is anybody looking?
// ---------------------------------------------------------------------------

/**
 * Whether the tab is somewhere the user is not.
 *
 * Two tests, because `visibilityState` alone misses the case people actually hit: a second
 * monitor. A Coda window fully covered by another window — or simply sitting behind the editor
 * you switched to — is still `visible` by the spec, and only `hasFocus()` says otherwise.
 *
 * The cost of including focus is that anything else taking focus counts as away, devtools most
 * of all. That is a real false positive and it is accepted: the failure it causes is a
 * notification you did not need, against a missed one for the whole class of people who work
 * with two windows side by side.
 */
function awayFromTab(): boolean {
  if (typeof document === 'undefined') return true
  if (document.visibilityState === 'hidden') return true
  return typeof document.hasFocus === 'function' && !document.hasFocus()
}

// ---------------------------------------------------------------------------
// Permission
// ---------------------------------------------------------------------------

/**
 * `unsupported` covers three separate things that all mean "do not offer this": no
 * `Notification` at all, a non-secure origin, and an iOS Safari tab that has not been installed
 * to the home screen. None of them can be told apart from here and none of them needs to be.
 */
export type NotifyState = 'unsupported' | 'default' | 'granted' | 'denied'

/** What the bell is: lit, or struck through with nothing the user can do from here. */
export interface BellState {
  /** A notification really would appear. The preference **and** a live `granted`. */
  on: boolean
  /** The browser has taken the decision away, so the control cannot be pressed. */
  blocked: boolean
}

/**
 * The one place the two halves of "am I being notified" are combined.
 *
 * The rule this file's header states — that the stored preference is *not* the truth, because
 * the browser's permission can be revoked without this app hearing — is only worth anything if
 * it is applied in one spelling. Derived at the call site instead, a second surface wanting to
 * say something about notification state gets the `denied`/`unsupported` split subtly wrong and
 * nothing says so. Pure, so the table is testable; the `granted`-with-the-preference-off case is
 * not reachable from jsdom in any other way.
 */
export function bellState(preferred: boolean, state: NotifyState): BellState {
  return {
    on: preferred && state === 'granted',
    blocked: state === 'denied' || state === 'unsupported',
  }
}

export function notifyState(): NotifyState {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported'
  try {
    const held = window.Notification.permission
    return held === 'granted' || held === 'denied' ? held : 'default'
  } catch {
    // Reading `permission` throws in a few embedded webviews that expose the constructor and
    // nothing behind it. Same answer as not having it.
    return 'unsupported'
  }
}

/**
 * Ask, from a click. Resolves to what the answer left us at, whatever that is.
 *
 * Never throws: a refusal is an ordinary outcome here, and the one caller wants a state to draw
 * rather than an exception to handle. Safari before 16 took a callback and returned `undefined`
 * instead of a promise — `await undefined` is harmless, and the re-read below is what makes that
 * path degrade to "still `default`" rather than to a wrong claim.
 */
export async function requestNotifyPermission(): Promise<NotifyState> {
  if (notifyState() === 'unsupported') return 'unsupported'
  try {
    await window.Notification.requestPermission()
  } catch {
    /* Refused outside a gesture, or the callback form. `notifyState()` has the answer. */
  }
  return notifyState()
}

// ---------------------------------------------------------------------------
// What a finished run says
// ---------------------------------------------------------------------------

export interface RunAnnouncement {
  /** The notification's heading. */
  title: string
  /** Its second line: which graph, what happened, how long it took. */
  body: string
  /**
   * What the browser tab's title becomes.
   *
   * Leads with the glyph and stays short, because a tab strip truncates from the right and a
   * tab holding one of twenty is a few characters wide. The graph's name is deliberately not in
   * here — it is the first thing that would be cut, and the notification already carries it.
   */
  flash: string
}

/**
 * What to say about a finished run, or `undefined` for the runs that are not worth interrupting
 * anybody over.
 *
 * Pure, and separate from every DOM call in this file, because it is the half with rules in it:
 * three of them, and each is a decision rather than an implementation detail.
 *
 * **A cancelled run is silent.** The user pressed Cancel; they know.
 *
 * **A run that touched nothing is silent** even if it took a while. An auto pass over a graph of
 * expensive nodes defers all of them and reports a duration; announcing that would be announcing
 * that nothing happened.
 *
 * **A failure is announced, and differently.** It is arguably the outcome most worth knowing
 * about from another window — coming back in an hour to find the run died in the first minute is
 * the case this feature is meant to prevent.
 *
 * `iterations` is in the body when there were any, because `executed` is a *set of node ids* and
 * so reads "6 nodes" for a loop that made four hundred passes — see `RunSummary.loopNodes`. A
 * loop is also exactly what a run long enough to reach the floor usually is.
 *
 * The duration is `formatDuration`, the same spelling the status bar uses, so the notification
 * and the line you read when you come back to the tab agree. `formatAge` would print a prettier
 * `1m` for these longer runs, and would then disagree with the `95.4s` on screen.
 */
export function runAnnouncement(
  summary: RunSummary,
  graphName: string | undefined,
): RunAnnouncement | undefined {
  if (summary.cancelled) return undefined
  if (summary.durationMs < NOTIFY_AFTER_MS) return undefined

  const touched = summary.executed.length + summary.failed.length
  if (touched === 0) return undefined

  const name = graphName?.trim()
  const where = name ? `${name} · ` : ''
  const passes = summary.iterations > 0 ? ` · ${plural(summary.iterations, 'pass', 'passes')}` : ''
  const took = ` · ${formatDuration(summary.durationMs)}`

  if (summary.failed.length > 0) {
    return {
      title: 'Coda — run failed',
      body: `${where}${plural(summary.failed.length, 'node')} of ${touched} failed${passes}${took}`,
      flash: '⚠ Run failed',
    }
  }
  return {
    title: 'Coda — run finished',
    body: `${where}${plural(summary.executed.length, 'node')}${passes}${took}`,
    flash: '✓ Run finished',
  }
}

// ---------------------------------------------------------------------------
// The title flash
// ---------------------------------------------------------------------------

/**
 * The title we replaced, held only while a flash is up.
 *
 * Captured **once**, and that is the whole trick: re-reading `document.title` on a second flash
 * would latch our own text in as the base, and the tab would go on saying "Run finished" for the
 * rest of the session with nothing to restore.
 *
 * Module state rather than a ref, because the flash outlives the component that raised it — a
 * viewer going fullscreen remounts half the tree, and a title that reverted because of that
 * would revert while the user is still away, which is the one moment it exists for.
 */
let replacedTitle: string | undefined

export function flashTitle(text: string): void {
  if (typeof document === 'undefined') return
  if (replacedTitle === undefined) replacedTitle = document.title
  document.title = text
}

/** Put the real title back. Safe to call when nothing is flashing. */
export function clearTitleFlash(): void {
  if (replacedTitle === undefined) return
  document.title = replacedTitle
  replacedTitle = undefined
}

// ---------------------------------------------------------------------------
// The notification
// ---------------------------------------------------------------------------

/**
 * The 192px PNG rather than the SVG mark: notification icons are rasterised by the OS, and
 * Chrome on Windows in particular will draw nothing at all for an SVG.
 *
 * Through `import.meta.env.BASE_URL`, which is how every other `public/` asset in this app is
 * addressed — it is Vite's own answer for the subpath deploy `vite.config.ts`'s relative `base`
 * exists for, resolved at build time. A second spelling here would be a second thing to get
 * right when the deploy path changes.
 */
const ICON_URL = `${import.meta.env.BASE_URL}icon-192.png`

/**
 * Show one, and answer whether it went out.
 *
 * **The constructor is not available everywhere the permission is.** Android Chrome throws
 * `Illegal constructor` here outright — it serves notifications only through a service worker
 * registration, and there is none in this app. Caught rather than guarded against, because the
 * set of engines that do this is not something to keep a list of, and because by the time this
 * runs the title flash has already happened: the failure degrades to the other channel instead
 * of to nothing.
 */
export function showRunNotification(announcement: RunAnnouncement): boolean {
  if (notifyState() !== 'granted') return false
  try {
    const note = new window.Notification(announcement.title, {
      body: announcement.body,
      tag: RUN_TAG,
      icon: ICON_URL,
    })
    // Clicking it is a request to come and look, so bring the tab up and take the notification
    // away. Without the `close()` it lingers in the OS's centre after it has been acted on.
    note.onclick = () => {
      window.focus()
      note.close()
    }
    return true
  } catch {
    return false
  }
}

/**
 * Show one immediately, to prove the chain works, at the moment permission is granted.
 *
 * A deliberate exception to the away rule the rest of this file is built on, and it is worth
 * it because **granting permission otherwise produces no evidence of anything**. The next
 * notification is a run over the floor away, on a tab you have since left — so if any link in
 * the chain is broken, what you get is silence fifteen seconds later on another tab, which is
 * indistinguishable from the feature not existing. That is not a hypothetical: macOS swallows
 * notifications whole under a Focus mode, or when the browser itself is not allowed to post in
 * System Settings → Notifications, and the web API reports success in both cases. There is no
 * way to ask whether a notification was actually seen; showing one while the user is looking is
 * the only honest test.
 *
 * Its own tag, so it neither replaces nor is replaced by a run's notification.
 */
export function showTestNotification(): boolean {
  if (notifyState() !== 'granted') return false
  try {
    const note = new window.Notification('Coda notifications are on', {
      body: 'This is what a finished run will look like.',
      tag: `${RUN_TAG}-test`,
      icon: ICON_URL,
    })
    note.onclick = () => {
      window.focus()
      note.close()
    }
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

/**
 * Watch for a finished run and say so if nobody was looking.
 *
 * Mounted once, from `EditorCanvas`, on exactly the reasoning `useDownloads` records: a run
 * finishing is a whole-app event, and hanging it off any card's body would stop it happening the
 * moment somebody collapsed that card.
 *
 * `lastRun` is the trigger rather than `busy` going false, and it is written under `runFull`'s
 * token guard — so a run that was *superseded* by a newer one never gets here, which is the
 * behaviour you want: it is the newest run's completion that means the wait is over.
 *
 * The ref is **mount-seeded**, the same guard the request counters in the store use. A remount
 * with a run already in the store must not announce it a second time; only a `lastRun` that
 * changed identity *while mounted* is a run that just finished.
 */
export function useRunNotify(): void {
  const lastRun = useGraphStore((s) => s.lastRun)
  const notifyRuns = useGraphStore((s) => s.notifyRuns)
  // A primitive — invariant 7. `s.graph` would re-run this on every edit.
  const graphName = useGraphStore((s) => s.graph.meta?.name)
  const announced = useRef(lastRun)

  useEffect(() => {
    if (lastRun === undefined || lastRun === announced.current) return
    announced.current = lastRun
    if (!awayFromTab()) return
    const announcement = runAnnouncement(lastRun, graphName)
    if (!announcement) return
    flashTitle(announcement.flash)
    if (notifyRuns) showRunNotification(announcement)
  }, [lastRun, notifyRuns, graphName])

  useEffect(() => {
    const onReturn = () => {
      if (!awayFromTab()) clearTitleFlash()
    }
    // Both, for the same reason `awayFromTab` asks both questions: switching tabs raises the
    // first, and clicking back into a window that was never hidden raises only the second.
    document.addEventListener('visibilitychange', onReturn)
    window.addEventListener('focus', onReturn)
    return () => {
      document.removeEventListener('visibilitychange', onReturn)
      window.removeEventListener('focus', onReturn)
      clearTitleFlash()
    }
  }, [])
}
