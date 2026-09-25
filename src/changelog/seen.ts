/**
 * The newest changelog entry this reader has seen, as its `YYYY-MM-DD` date.
 *
 * One definition for both readers: the editor, which decides whether to show What's New and
 * whether the `?` menu carries a dot, and `changelog.html`, which marks every entry as seen the
 * moment it is opened. Both are served from one origin, so they share `localStorage` — and a
 * static page cannot import `store/persistence.ts`, whose imports reach the graph model. Hence
 * a module with no imports at all, which either side can afford.
 *
 * A **date rather than an id** because the entries are dated and ordered by date anyway, and
 * "newer than what I saw" is then a string comparison. Two entries on one day would be one
 * update; `changelog.test.ts` refuses a repeated date so that stays true.
 *
 * `undefined` means *never recorded*, which is not the same as "has seen nothing": the editor
 * tells a first visit from a returning one by other means (`ui/whatsNew.ts`), and records the
 * newest date on a first visit so the whole history does not arrive as news.
 */

export const CHANGELOG_SEEN_KEY = 'coda.changelog.v1'

const DATE = /^\d{4}-\d{2}-\d{2}$/

export function loadChangelogSeen(): string | undefined {
  try {
    const raw = localStorage.getItem(CHANGELOG_SEEN_KEY)
    return raw && DATE.test(raw) ? raw : undefined
  } catch {
    return undefined
  }
}

/** Never moves backwards: a stale tab closing an old pop-up must not un-see a newer entry. */
export function saveChangelogSeen(date: string): void {
  try {
    const current = loadChangelogSeen()
    if (current !== undefined && current >= date) return
    localStorage.setItem(CHANGELOG_SEEN_KEY, date)
  } catch {
    /* no storage: every visit is a first visit, which shows nothing */
  }
}
