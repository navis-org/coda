/**
 * The address a browser can actually read, for the addresses people actually paste.
 *
 * A link copied out of GitHub's file view — `github.com/<owner>/<repo>/blob/<ref>/<path>` — is a
 * *page*, not a file: it answers 200 with HTML, so a CSV parser reads one column of markup and a
 * person is left staring at a table that came back wrong rather than at an error. The `Raw`
 * button's link (`…/raw/refs/heads/main/…`) is no better from here for a different reason: it is
 * a 302 to `raw.githubusercontent.com`, and a cross-origin fetch checks *every* response in a
 * redirect chain — github.com answers that hop with an **empty** `Access-Control-Allow-Origin`,
 * which fails the check before the redirect that would have worked is ever followed. Both are
 * the address somebody has in their clipboard; neither can be fetched; and the fix is the same
 * one-line rewrite. Measured with `curl -D - -H 'Origin: …'` against all four addresses: the two
 * `raw.githubusercontent.com` forms, `main/…` and `refs/heads/…` alike, answer 200 with
 * `Access-Control-Allow-Origin: *`.
 *
 * So this is a rewrite rather than a validation error. The three rules that keep it honest:
 *
 * **It never changes the text the user typed.** The param keeps the pasted link — that is what a
 * colleague recognises in a shared workflow, and it is what they will click. The rewrite happens
 * at each door that turns the param into a request, which is why the exporters call this too: a
 * notebook emitting `pd.read_csv('https://github.com/…/blob/…')` reproduces the HTML-as-CSV bug
 * outside Coda, where there is nothing at all to explain it. `rawFileNote` is that explanation,
 * shared so the two documents cannot word it differently.
 *
 * **It is narrow, and stays narrow** — the rule `data/neuroglancer/sourceUrl.ts` records for
 * `precomputedToHttp`. Only `github.com` (and its `www.` spelling), only `/blob/` and `/raw/`,
 * only when an owner, a repo, a ref and a path are all present. Anything else is returned
 * untouched, including `raw.githubusercontent.com` itself, which already serves
 * `Access-Control-Allow-Origin: *` and needs nothing.
 *
 * **A URL it cannot parse is not an error here.** `validate` at the node is where an unusable
 * address is reported, and a rewriter that threw would be a second, differently-worded opinion
 * about the same string.
 *
 * The query and fragment are dropped with the host. They are the file view's own state —
 * `?plain=1`, `#L4-L20`, `?raw=true` — and mean nothing to the raw host; a fragment is not sent
 * by a fetch anyway.
 */

/** Hosts whose file pages this rewrites. GitHub Enterprise deliberately not guessed at. */
const GITHUB_HOSTS = new Set(['github.com', 'www.github.com'])

/**
 * The fetchable form of a pasted address, or the address itself when there is nothing to do.
 *
 * One function rather than a predicate and a converter: every caller wants the same
 * "…whatever this really is" answer, and a pair would let one of them ask the first question and
 * forget the second. Named for what it returns rather than `fetchableUrl`, which
 * `data/neuroglancer/sourceUrl.ts` already spells with the opposite convention — two functions of
 * one name two directories apart being the grep hazard `fetchText.ts` exists to point at.
 *
 * The substring test before the parse is not micro-optimisation for its own sake: this is on
 * `inferOutputs`, `validate` and both column pickers, so it runs several times per node per graph
 * mutation, and every URL that is not GitHub's — nearly all of them — gets a scan rather than a
 * WHATWG parse. It also stands in for an empty-string check, `new URL('')` throwing anyway.
 */
export function rawFileUrl(input: string): string {
  const text = input.trim()
  if (!text.includes('github.com/')) return text

  let url: URL
  try {
    url = new URL(text)
  } catch {
    return text
  }
  // `hostname` is already lowercased by the parser, so the set is asked in one spelling.
  if (!GITHUB_HOSTS.has(url.hostname)) return text

  // `/<owner>/<repo>/<blob|raw>/<rest…>`. `rest` is left whole rather than split into a ref and a
  // path: a branch name may hold slashes, and both `main/…` and `refs/heads/main/…` are spellings
  // raw.githubusercontent.com serves — so anything that decides where the ref ends can only be
  // wrong somewhere. Two segments at least, a ref and something under it: one is a link to a
  // *branch*, which has no raw form, and rewriting it would turn a link that opens a page in a
  // browser into a 404 with this function's fingerprints on it.
  const [owner, repo, kind, ...rest] = url.pathname.split('/').filter(Boolean)
  if (!owner || !repo || (kind !== 'blob' && kind !== 'raw') || rest.length < 2) return text

  return `https://raw.githubusercontent.com/${owner}/${repo}/${rest.join('/')}`
}

/**
 * What an exported document says about a link this rewrote, in one sentence both emitters share.
 *
 * The reader's name is the only difference between the notebook's copy and the R Markdown one,
 * and a sentence written out twice is one that comes to say two things — the reason
 * `sheetExportUrl` is shared across the same three consumers.
 */
export function rawFileNote(typed: string, reader: string): string {
  return `${typed} is a GitHub file page; ${reader} would read its HTML. Reading the raw file instead.`
}
