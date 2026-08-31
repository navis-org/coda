/**
 * Reading from a DVID server.
 *
 * Thin on purpose: the bytes go through `precomputed/transport.ts`, because a DVID deployment is
 * a plain HTTPS host with CORS and wants exactly that file's routing, its per-host memory of
 * what worked, and its one error type. What lives here is the three things that are DVID's own —
 * how a missing instance differs from a missing key, where a credential would go, and the fact
 * that neither of those is a reason to fail a whole scene.
 *
 * ## Two shapes of absence, and the server distinguishes them
 *
 * Measured against `flyem.dvid.io`:
 *
 *     GET …/groundtruth_meshes/info          200   the instance is there
 *     GET …/groundtruth_skeletons/info       400   no such instance
 *     GET …/groundtruth_meshes/key/1.ngmesh  200   the body has geometry
 *     GET …/…/key/5813020600.ngmesh          404   `Key "5813020600.ngmesh" not found`
 *
 * So **400 means the store does not exist and 404 means this body is not in it** — which is the
 * opposite way round from what a reader expecting REST would guess, and the reason both are
 * spelled out here rather than left to a status check at each call site. Both are ordinary:
 * a repo may publish meshes and no skeletons, and a body may be a fragment nobody has meshed.
 *
 * ## Where a credential goes
 *
 * These servers are unauthenticated today and reachable by anybody holding the URL. That is
 * changing, so the token is threaded from the start and nothing stores one yet: `DvidOptions`
 * carries it, `authHeaders` is the one place that knows the header's spelling, and a 401 or 403
 * is turned into a sentence saying what happened rather than surfacing as "could not read". When
 * a Connections field arrives it fills `token` and no other file changes.
 *
 * **Nothing here logs a URL.** A DVID address is the whole of the access control on these
 * deployments, so it belongs on screen where somebody asked for it and nowhere else — not in a
 * console, and Coda has no event analytics for it to reach. See `docs/backends.md`.
 */

import type { FetchOptions } from '../precomputed/transport'
import { PrecomputedFetchError, fetchBytes, fetchInfo } from '../precomputed/transport'
import type { DvidRef } from './refs'
import { instanceUrl, keyUrl, serverOf } from './refs'

export interface DvidOptions extends FetchOptions {
  /**
   * A DVID credential, when the deployment wants one.
   *
   * Undefined everywhere today — see the header. Threaded rather than reached for globally so
   * that a private server's token cannot leak into a request to a public one.
   */
  token?: string | undefined
}

/** The one place the credential header's spelling lives. */
function authHeaders(token: string | undefined): Record<string, string> | undefined {
  return token ? { Authorization: `Bearer ${token}` } : undefined
}

/**
 * `DvidOptions` as the transport's options: everything it already is, plus the credential.
 *
 * Extending rather than copying two fields across is what keeps `maxBytes` working — it was
 * being silently dropped here, which turned the streaming ceiling into no ceiling at all and
 * would have shown up only as a very large download nobody asked for.
 */
function fetchOptions({ token, ...rest }: DvidOptions): FetchOptions {
  const headers = authHeaders(token)
  return headers ? { ...rest, headers } : rest
}

/**
 * Rewrite an auth refusal into a sentence, and let everything else through.
 *
 * The message names the server rather than the whole URL: on these deployments the node is the
 * secret, and an error string is copied into bug reports.
 */
function describeFailure(error: unknown, base: string): unknown {
  if (!(error instanceof PrecomputedFetchError)) return error
  if (error.status !== 401 && error.status !== 403) return error
  return new Error(
    `${serverOf(base)} refused the request (${error.status}). This DVID deployment wants a ` +
      `credential, which Coda cannot supply yet.`,
  )
}

/**
 * The URL of a geometry instance that is there, or the refusal both stores share.
 *
 * One narrow question rather than `/api/repos/info`, which answers with every repo on the
 * server — see `refs.ts` for why that matters on a private deployment.
 *
 * Both openers wrote this sentence out and differed only in the noun, which is two places for
 * one message to drift; `live.test.ts` asserts on the wording.
 */
export async function requireInstance(
  ref: DvidRef,
  instance: string,
  kind: 'meshes' | 'skeletons',
  options: DvidOptions = {},
): Promise<string> {
  const base = instanceUrl(ref, instance)
  if (!(await readInstanceInfo(base, options))) {
    throw new Error(
      `${serverOf(base)} has no ${instance} instance on this node, so this segmentation ` +
        `publishes no ${kind}. Neuroglancer looks for exactly that name and would show none ` +
        `either.`,
    )
  }
  return base
}

/**
 * One key's bytes, or undefined when the body is not in the store.
 *
 * Undefined rather than a throw for 404, because a body with no geometry is the ordinary case —
 * a fragment, an unproofread segment — and a scene of two hundred neurons must not fail because
 * one of them was never meshed. `fetchMeshes` counts them as `missing`.
 */
export async function readKey(
  base: string,
  key: string,
  options: DvidOptions = {},
): Promise<ArrayBuffer | undefined> {
  try {
    return await fetchBytes(keyUrl(base, key), fetchOptions(options))
  } catch (error) {
    /*
     * 404 is "this body is not in the store"; 413 is `maxBytes` giving up on one that is. From
     * the caller's side they are the same fact — this neuron is not in the result — and
     * `fetchMeshes` reports both as `missing`.
     */
    if (
      error instanceof PrecomputedFetchError &&
      (error.status === 404 || error.status === 413)
    ) {
      return undefined
    }
    throw describeFailure(error, base)
  }
}

/** A data instance's own description. `Base.TypeName` is the part anything here reads. */
export interface DvidInstanceInfo {
  Base?: { TypeName?: string; Name?: string }
  Extended?: { VoxelSize?: number[]; VoxelUnits?: string[] }
}

/** An instance's `info`, parsed. Undefined when the instance is not there. */
export async function readInstanceInfo(
  base: string,
  options: DvidOptions = {},
): Promise<DvidInstanceInfo | undefined> {
  try {
    /*
     * `fetchInfo`, not a decode of our own: it appends `/info`, it is the same JSON step the
     * precomputed readers take, and it memoises the answer for the session — which is what the
     * two probes behind one skeleton read were otherwise paying twice. Successes only, so the
     * 400 below still re-asks, which is right for a store somebody may be creating.
     */
    return await fetchInfo<DvidInstanceInfo>(base, fetchOptions(options))
  } catch (error) {
    // 400 is DVID's "no such instance" — an answer, not a fault. Anything else is a real
    // failure and is raised, so an unreachable server does not read as an absent mesh store.
    if (error instanceof PrecomputedFetchError && error.status === 400) return undefined
    throw describeFailure(error, base)
  }
}
