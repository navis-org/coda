/**
 * Which CAVE deployment something belongs to — the one vocabulary the rest of `data/cave` reads.
 *
 * **A deployment is a global server**, and it is the key for three things that used to hang off a
 * single user setting: which datastacks exist (the global info service lists them), which
 * credential a request carries (each deployment runs its own `middle_auth`, so a token is minted
 * *by* one), and which `CaveSource` a dataset belongs to. `global.daf-apis.com` fronts FlyWire,
 * BANC and MICrONS; `global.brain-wire-test.org` fronts H01. Those are unrelated services with
 * unrelated accounts, and one setting could only ever point at one of them — switching it dropped
 * every datastack of the other from the session.
 *
 * **Not a host pattern**, which is the difference from `catmaid/credentials.ts` and worth stating
 * because the two look alike. A CATMAID token belongs to the host it is sent to. A CAVE token
 * belongs to the login service that issued it and is sent to *many* unrelated hosts — the global
 * server, each datastack's `local_server`, its chunkedgraph, its skeleton service —
 * `prod.flywire-daf.com`, `cave.fanc-fly.com` and `minnie.microns-daf.com` all take the one
 * `global.daf-apis.com` token. None of those hosts is typed by anybody: each is read off a
 * datastack's info record. So a request cannot be matched to its credential by where it is going;
 * it has to *carry* the deployment it came from, which is `CaveRequestOptions.deployment`.
 *
 * Headless and import-free, so `credentials.ts`, `spec.ts`, `client.ts` and `CaveSource` can all
 * depend on it without a cycle.
 */

/**
 * The deployment every CAVE dataset Coda ships an entry for lives on, and the one a node that
 * names none means. FlyWire, BANC and MICrONS.
 */
export const DEFAULT_CAVE_SERVER = 'https://global.daf-apis.com'

/**
 * Canonical form of a global server URL.
 *
 * Tolerant on input — a bare host, a trailing slash, a pasted address bar with a path — because
 * all of those mean the same deployment and the obvious thing to do with a URL is paste it. Only
 * the origin survives: every endpoint Coda calls hangs off it, and a stray path would 404 in a way
 * that reads as a dead server. Empty or unparseable means the default, which is what an untouched
 * field should mean. `neuprint/servers.ts`' `normaliseServer`, for a different backend.
 */
export function normaliseCaveServer(raw: string | undefined): string {
  if (raw === undefined || raw === DEFAULT_CAVE_SERVER) return DEFAULT_CAVE_SERVER
  /*
   * Memoised because it sits on inference's hot path — every memo key, `specFor` and
   * `capabilitiesFor` normalise a deployment, nearly always one already canonical — and a `URL`
   * parse per call is paid on every graph mutation. Cleared rather than evicted when it grows,
   * since the only unbounded input is somebody typing into a Server field.
   */
  const known = normalised.get(raw)
  if (known !== undefined) return known
  if (normalised.size > 64) normalised.clear()
  const result = parseCaveServer(raw) ?? DEFAULT_CAVE_SERVER
  normalised.set(raw, result)
  return result
}

const normalised = new Map<string, string>()

/**
 * A global server's origin, or undefined where the text names none — empty, or not a URL.
 *
 * `normaliseCaveServer` is this with the default filled in, which is right for a param nobody
 * touched and wrong for a field somebody is typing a *new* deployment into: there,
 * `global brain-wire-test.org` quietly becoming FlyWire's server would store that deployment's
 * token as FlyWire's. So the Connections panel asks this one.
 */
export function parseCaveServer(raw: string | undefined): string | undefined {
  const trimmed = (raw ?? '').trim().replace(/\/+$/, '')
  if (!trimmed) return undefined
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    return new URL(withScheme).origin
  } catch {
    return undefined
  }
}

/**
 * The one spelling of "this, on that deployment" every memo in `data/cave` is keyed by — two info
 * services may each list a datastack of the same name, and an answer is about one of them.
 */
export function deploymentKey(deployment: string | undefined, rest: string): string {
  return `${normaliseCaveServer(deployment)}|${rest}`
}

/**
 * The source id for a deployment.
 *
 * The default keeps the bare `cave` id every saved graph and every IndexedDB cache key already
 * carries — `neuronIndexKey` and the geometry cache both fold the source id in, so renaming it
 * would silently re-download every cached index. Anything else is `cave:<origin>`, which
 * `backendOf` reads back as `cave` by the colon rule `neuprint:` and `catmaid:` already follow.
 */
export function caveSourceId(server: string | undefined): string {
  const deployment = normaliseCaveServer(server)
  return deployment === DEFAULT_CAVE_SERVER ? 'cave' : `cave:${deployment}`
}

/**
 * The deployment behind a CAVE source id, or undefined for a source that is not CAVE.
 *
 * The inverse of `caveSourceId`, and the only reader of that spelling: a node handed a Dataset —
 * by a wire or by a reference — learns which deployment to ask from the value's `sourceId`, since
 * that is the one field that travels with it everywhere.
 */
export function caveServerOfSource(sourceId: string | undefined): string | undefined {
  if (sourceId === 'cave') return DEFAULT_CAVE_SERVER
  if (!sourceId?.startsWith('cave:')) return undefined
  return normaliseCaveServer(sourceId.slice('cave:'.length))
}

/** The host alone, for messages and labels: `global.brain-wire-test.org`. */
export function caveServerLabel(server: string | undefined): string {
  return normaliseCaveServer(server).replace(/^https?:\/\//, '')
}
