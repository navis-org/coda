/**
 * Workflows in a GitHub Gist: the short half of a share link.
 *
 * A packed graph is 1.5–2 kB of fragment for an ordinary workflow, which is perfectly
 * pasteable — but an Explore select-all packs to roughly 56,000 characters, and past a few
 * thousand a link starts being cut short by the client it travels through. A gist turns any
 * graph into `#!gh://<user>/<id>`, which is 40 characters whatever the workflow does.
 *
 * **No proxy, and that was verified rather than assumed.** `api.github.com` answers the
 * preflight for `POST /gists` with 204, `Access-Control-Allow-Origin: *`,
 * `Access-Control-Allow-Headers` including `Authorization`, `Content-Type` and
 * `X-GitHub-Api-Version`, and `Access-Control-Allow-Methods` including POST. Reads carry ACAO
 * too. So this works from the static GitHub Pages build, where the Cypher API cannot reach —
 * the same finding shape as the AI providers, and the reason a gist is the shortening route
 * rather than something needing a server.
 *
 * **Anonymous gists do not exist.** GitHub removed them in March 2018; an unauthenticated POST
 * is a 401. That is why creating a link needs a token at all, and it is recorded here so nobody
 * re-checks it hoping otherwise.
 *
 * **Reading needs no token.** Every `gh://` link opens for a recipient who has never pasted
 * anything, which is the entire point of sharing one.
 */

import {
  getGithubToken,
  reportGithubAuthFailure,
  setGithubLogin,
  getGithubLogin,
} from './credentials'

const API = 'https://api.github.com'

/**
 * Pinned, as GitHub asks.
 *
 * Unversioned requests get whatever the current default is, which is fine until it is not, and
 * the failure would be a shape change in a response this app parses.
 */
const API_VERSION = '2022-11-28'

/** Where a workflow ends up. `owner` is what decides whether Share updates or creates. */
export interface GistRef {
  id: string
  owner: string | undefined
}

function headers(token: string | undefined): HeadersInit {
  return {
    accept: 'application/vnd.github+json',
    'x-github-api-version': API_VERSION,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  }
}

/**
 * Turn a failed response into a sentence.
 *
 * A 401 additionally goes down the auth channel, the same way a neuPrint 401 does, so the
 * Connections panel opens on the field that needs attention instead of the user reading a
 * status code on a dialog and having to work out where the fix lives.
 */
async function refuse(response: Response, what: string): Promise<never> {
  let detail = ''
  try {
    const body = (await response.json()) as { message?: string }
    detail = body.message ? ` — ${body.message}` : ''
  } catch {
    // GitHub always sends a JSON body; a missing one is not worth a second message.
  }
  if (response.status === 401) {
    reportGithubAuthFailure('GitHub rejected the token.')
    throw new Error(
      `GitHub rejected the token${detail}. Check it in Connections ▸ Sharing — it needs the "gist" scope.`,
    )
  }
  if (response.status === 403 || response.status === 429) {
    throw new Error(
      `GitHub refused the request${detail}. Without a token, gist reads are rate-limited by IP; adding one in Connections ▸ Sharing raises the limit.`,
    )
  }
  if (response.status === 404) {
    throw new Error(
      `${what} was not found${detail}. The gist may have been deleted, or it may be private to someone else.`,
    )
  }
  throw new Error(`GitHub returned ${response.status}${detail}.`)
}

/**
 * The login the stored token belongs to, cached.
 *
 * Asked so the share dialog can tell "update the gist this graph came from" from "that gist is
 * somebody else's, make a new one". Without it, pressing Share on a workflow you were *sent*
 * would PATCH the original author's gist and get a 404 with nothing explaining why.
 */
let inFlightLogin: { token: string; promise: Promise<string | undefined> } | undefined

export async function githubLogin(): Promise<string | undefined> {
  const cached = getGithubLogin()
  if (cached) return cached
  const token = getGithubToken()
  if (!token) return undefined
  /*
   * One request for concurrent askers, the idiom `loadCachedTable` uses. The cache is written
   * when the answer *lands*, so two callers starting a tick apart both miss it — which is not
   * hypothetical: `StrictMode` invokes the dialog's effect twice, and observed live that is two
   * `GET /user` calls against a rate-limited API for one dialog opening.
   */
  if (inFlightLogin?.token === token) return inFlightLogin.promise
  const promise = (async () => {
    const response = await fetch(`${API}/user`, { headers: headers(token) })
    if (!response.ok) return refuse(response, 'The signed-in account')
    const body = (await response.json()) as { login?: string }
    setGithubLogin(body.login)
    return body.login
  })().finally(() => {
    inFlightLogin = undefined
  })
  inFlightLogin = { token, promise }
  return promise
}

/**
 * What a Coda workflow is called inside a gist.
 *
 * It is how `readGist` picks the right file out of a gist somebody has since added notes to, and
 * it is what makes the file downloadable straight back into Coda. The *name* in front of it is
 * the caller's, deliberately: `Download .coda.json` already slugs the graph's name for its
 * filename, and computing the same user-facing name twice is how the two come to disagree.
 */
export const GIST_EXTENSION = '.coda.json'

export interface WriteGistOptions {
  /** The serialised graph, exactly as `Download .coda.json` would write it. */
  json: string
  /** The graph's name — part of the description, and shown to the user. */
  name: string
  /** The file's name inside the gist. Ends in `GIST_EXTENSION`; see the note there. */
  filename: string
  /**
   * A secret gist is **unlisted, not private**: anybody with the link can read it, and it is
   * not searchable. The dialog has to say that in those words, because "secret" reads as
   * "private" and somebody will otherwise put something in a graph they should not.
   */
  secret: boolean
  appVersion: string
}

/**
 * The request body.
 *
 * `extra` rather than a `forUpdate` flag, because the one key that differs is `public` and the
 * reason it differs is worth stating at the call site: a gist's visibility is fixed at creation,
 * so sending it on a PATCH is a 422 on an otherwise perfectly good update.
 */
function body({ json, name, filename, appVersion }: WriteGistOptions, extra?: object) {
  return JSON.stringify({
    description: `${name || 'Untitled'} — a Coda workflow (coda ${appVersion})`,
    ...extra,
    files: { [filename]: { content: json } },
  })
}

export async function createGist(options: WriteGistOptions): Promise<GistRef> {
  const token = getGithubToken()
  if (!token) throw new Error('No GitHub token — add one in Connections ▸ Sharing.')
  const response = await fetch(`${API}/gists`, {
    method: 'POST',
    headers: { ...headers(token), 'content-type': 'application/json' },
    body: body(options, { public: !options.secret }),
  })
  if (!response.ok) return refuse(response, 'The gist')
  const created = (await response.json()) as { id?: string; owner?: { login?: string } }
  if (!created.id) throw new Error('GitHub accepted the gist but named no id.')
  return { id: created.id, owner: created.owner?.login }
}

/**
 * Replace the file in an existing gist.
 *
 * The caller passes the filename built from the *current* name, so renaming the graph renames
 * the file — which would otherwise leave a gist whose description says one thing and whose file
 * says another. GitHub keeps the old file only if it is still named in `files`; it is not, so it
 * goes.
 */
export async function updateGist(id: string, options: WriteGistOptions): Promise<GistRef> {
  const token = getGithubToken()
  if (!token) throw new Error('No GitHub token — add one in Connections ▸ Sharing.')
  const response = await fetch(`${API}/gists/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { ...headers(token), 'content-type': 'application/json' },
    body: body(options),
  })
  if (!response.ok) return refuse(response, 'That gist')
  const updated = (await response.json()) as { id?: string; owner?: { login?: string } }
  return { id: updated.id ?? id, owner: updated.owner?.login }
}

interface GistFile {
  filename?: string
  content?: string
  truncated?: boolean
  raw_url?: string
}

/**
 * Read a gist back to graph JSON.
 *
 * Unauthenticated where there is no token, because that is the path every recipient takes. A
 * token is sent when one is present purely for the rate limit — anonymous gist reads are capped
 * per IP, which a shared institutional address can reach.
 *
 * Two things this has to get right, neither of which announces itself:
 *
 *  - **`truncated`.** The API stops inlining a file's content above 1 MB and hands back a
 *    `raw_url` instead. Coda's graphs are far under that, but a graph carrying a large Explore
 *    selection is not obviously so — and the failure mode is a *partial* graph that parses,
 *    which is worse than one that does not.
 *  - **Which file.** A gist can hold several, and people add notes to them. The one ending
 *    `.coda.json` wins; a single-file gist is taken as-is whatever it is called, so a link to
 *    somebody's hand-written `workflow.json` still opens.
 */
export async function readGist(id: string, revision?: string): Promise<string> {
  const token = getGithubToken()
  const path = revision
    ? `${API}/gists/${encodeURIComponent(id)}/${encodeURIComponent(revision)}`
    : `${API}/gists/${encodeURIComponent(id)}`
  const response = await fetch(path, { headers: headers(token) })
  if (!response.ok) return refuse(response, 'That gist')

  const gist = (await response.json()) as { files?: Record<string, GistFile | null> }
  const files = Object.values(gist.files ?? {}).filter((file): file is GistFile =>
    Boolean(file),
  )
  if (files.length === 0) throw new Error('That gist has no files in it.')

  const file =
    files.find((f) => f.filename?.endsWith(GIST_EXTENSION)) ??
    (files.length === 1 ? files[0] : undefined)
  if (!file) {
    const names = files
      .map((f) => f.filename)
      .filter(Boolean)
      .join(', ')
    throw new Error(
      `That gist holds no Coda workflow. It has ${names || 'files'}, and none of them ends in ${GIST_EXTENSION}.`,
    )
  }

  if (file.truncated && file.raw_url) {
    const raw = await fetch(file.raw_url)
    if (!raw.ok) throw new Error(`Could not read the workflow file: ${raw.status}.`)
    return raw.text()
  }
  if (typeof file.content !== 'string') {
    throw new Error('That gist file is empty.')
  }
  return file.content
}
