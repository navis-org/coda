/**
 * What two backends' popup sign-ins have in common, with nothing about a window in it.
 *
 * CAVE's `middle_auth` and Janelia's DatasetGateway (neuPrint) both end a Google login by posting
 * `{token}` to the page that opened them, and both tokens are seven-day credentials that look like
 * every other token. So two facts are shared: what counts as a token arriving, and what is kept
 * beside one to tell it from another. Where each service logs in, and who a token belongs to, are
 * not — see `cave/oauth.ts` and `neuprint/signIn.ts`. The window half is `ui/panels/popupSignIn.ts`,
 * since `src/data` has to stay runnable with no DOM at all.
 */

/**
 * The token in a `message` from an auth server, or undefined for anything that is not one.
 *
 * Deliberately a *reader* rather than a guard returning a boolean: the caller has one thing to
 * do with this event and it is take the token out, so a shape check that hands back nothing
 * would be checked once and then indexed again anyway.
 *
 * It has real work to do, because a login window posts more than one kind of message. The
 * terms-of-service arm of middle_auth posts the bare string `"success"`, and DatasetGateway posts
 * `"badorigin"` to an origin it has not registered — neither is a token, and either stored as one
 * gives somebody a session that fails on its first query with nothing to say why. And middle_auth
 * posts to `"*"`, so anything at all may post here: the shape check is the second half of a test
 * whose first half is the origin.
 */
export function readAuthMessage(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined
  const token = (data as { token?: unknown }).token
  if (typeof token !== 'string') return undefined
  const trimmed = token.trim()
  return trimmed || undefined
}

/**
 * What is known about a token that was *signed in for* rather than pasted.
 *
 * Two facts, and both are about telling one credential from another rather than about using it. A
 * token is a string that looks like every other token, and one person routinely holds a different
 * Google account at each service — so the account it was issued to is the label that makes a wrong
 * one visible. The date is the other half: both services issue a seven-day credential, so "signed
 * in a fortnight ago" is the answer to why a run started failing.
 *
 * Deliberately **not** an expiry. The seven days is a server-side default, and a countdown Coda
 * computed from a constant it copied would keep claiming a token was good after the service
 * shortened it — the 401 is the only thing that actually knows.
 */
export interface SignInSession {
  /** The Google account the token was issued to, where the service would say. */
  email?: string
  /** When the sign-in happened, ms since the epoch. */
  at: number
}

/** A stored session, or undefined for absent, corrupt, or written by some older shape. */
export function readSession(value: unknown): SignInSession | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { email, at } = value as { email?: unknown; at?: unknown }
  if (typeof at !== 'number' || !Number.isFinite(at)) return undefined
  return typeof email === 'string' && email ? { email, at } : { at }
}

/** A session as stored beside a token: the JSON text, read back or undefined. */
export function parseStoredSession(raw: string | undefined): SignInSession | undefined {
  if (!raw) return undefined
  try {
    return readSession(JSON.parse(raw))
  } catch {
    return undefined
  }
}

/** The session to record for a sign-in that has just finished, as the given account. */
export function sessionNow(email: string | undefined): SignInSession {
  return email ? { email, at: Date.now() } : { at: Date.now() }
}

/**
 * Whitespace stripped and a `Bearer ` prefix tolerated, because the obvious thing to do with a
 * token from a web page is paste whatever was on the clipboard. Every pasted credential goes
 * through this one rule.
 */
export function cleanToken(raw: string | undefined): string | undefined {
  return raw?.trim().replace(/^Bearer\s+/i, '') || undefined
}

/**
 * The account a token was issued to, read from one field of an authenticated JSON document, or
 * undefined where the service would not say.
 *
 * Worth a request of its own because one person routinely holds different Google accounts at
 * different services, and a token otherwise looks like every other token. **Degrades to silence
 * rather than failing the sign-in**: the token is already in hand and already works, and not being
 * able to put a name on it is a worse label, not a failure.
 */
export async function fetchSignedInEmail(
  url: string,
  token: string,
  field: string,
  options: { signal?: AbortSignal | undefined } = {},
): Promise<string | undefined> {
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      ...(options.signal ? { signal: options.signal } : {}),
    })
    if (!response.ok) return undefined
    const email = (JSON.parse(await response.text()) as Record<string, unknown>)[field]
    return typeof email === 'string' && email.trim() ? email.trim() : undefined
  } catch {
    return undefined
  }
}
