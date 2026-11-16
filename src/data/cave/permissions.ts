/**
 * Whether a token may edit a chunkedgraph table, asked of the auth service before anything is
 * sent (`docs/seam-merge-plan.md`, phase 0 and the pre-flight). Reads only.
 *
 * Two requests, both read off the live service (2026-11-16): the table's **permission dataset**
 * (`GET {auth}/service/pychunkedgraph/table/{table}/dataset`, a JSON string — `FANC_sandbox` for
 * `mar2021_test`, `wclee_aedes_brain` for Aedes), then the user's **cache**
 * (`GET {auth}/user/cache`), whose `permissions_v2` maps each dataset to what the user may do
 * there. `permissions_v2` already leaves out a dataset whose terms the user has not accepted, and
 * `permissions_v2_ignore_tos` keeps it; the difference is the one refusal worth naming, since
 * the remedy is a form rather than a group. `missing_tos` is not read: it lists every dataset's
 * unaccepted terms, most of them nothing to do with this table.
 *
 * `{auth}` is discovered here, never assumed or taken from a caller: the login service **the
 * chunkedgraph's own host names** in its `/auth_info` (`oauth.ts`), since that is the service
 * that judges its token. On `global.daf-apis.com` and `cave.fanc-fly.com` it is
 * `global.daf-apis.com/sticky_auth`; `/auth` only redirects there. **It must be the deployment's
 * own**: the token sent is the one signed in to the deployment (`options.deployment`), and a
 * chunkedgraph that logs in elsewhere would refuse it — so that is said, rather than the token
 * sent to a service that did not issue it. Both are held for the session.
 */

import type { CaveRequestOptions } from './client'
import { caveGet } from './client'
import { errorMessage } from '../../core/errors'
import { memoPromise, untilAborted } from '../memoPromise'
import { normaliseCaveServer } from './deployments'
import type { GrapheneSource } from './graphene'
import type { CaveLoginService } from './oauth'
import { discoverLoginService } from './oauth'

export interface EditPermission {
  /** The dataset the auth service keys this table's permissions by. */
  readonly dataset: string
  readonly mayEdit: boolean
  /** The user could edit, but has not accepted the dataset's terms of service. */
  readonly termsPending: boolean
}

interface UserCache {
  readonly permissions_v2?: Record<string, readonly string[]>
  readonly permissions_v2_ignore_tos?: Record<string, readonly string[]>
}

/** Where each host logs in, for the session: `/auth_info` names a service, and it does not move. */
const loginServices = new Map<string, Promise<CaveLoginService>>()

/** For tests: forget where hosts log in. */
export function resetLoginServices(): void {
  loginServices.clear()
}

/** Where a host logs in, shared by every caller asking — so it carries nobody's signal. */
function loginServiceOf(server: string): Promise<CaveLoginService> {
  return memoPromise(loginServices, server, () => discoverLoginService(server), {
    keep: 'resolved',
  })
}

export async function editPermission(
  graphene: GrapheneSource,
  options: CaveRequestOptions,
): Promise<EditPermission> {
  const deployment = normaliseCaveServer(options.deployment)
  /*
   * Each lookup with its own sentence on failure: `discoverLoginService`'s is about signing in
   * ("paste a token instead"), which is not the remedy for a check made with a token in hand. A
   * cancel is the caller's own and passes as it is.
   */
  const lookup = (server: string, failed: string) =>
    untilAborted(loginServiceOf(server), options.signal).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      throw new Error(`${failed} (${errorMessage(error)}).`)
    })
  const [judge, issuer] = await Promise.all([
    lookup(
      graphene.server,
      `Could not find where ${graphene.server} checks permissions, so whether you may edit there is unknown`,
    ),
    lookup(
      deployment,
      `Could not find where your CAVE deployment ${deployment} signs in, so whether its token is ` +
        `accepted at ${graphene.server} is unknown`,
    ),
  ])
  /*
   * By origin: one login service can be reached at more than one path (`/auth` redirects to
   * `/sticky_auth` on global), and comparing paths would refuse a reader who may edit.
   */
  if (judge.origin !== issuer.origin) {
    throw new Error(
      `${graphene.server} checks permissions with ${judge.origin}, but your token is from ` +
        `${issuer.origin}, so it would be refused there. Sign in to that deployment.`,
    )
  }
  const { apiBase } = judge
  const { table } = graphene
  // Two requests that wait on nothing but the discovery above, so they go together.
  const [dataset, user] = await Promise.all([
    caveGet<unknown>(
      `${apiBase}/service/pychunkedgraph/table/${encodeURIComponent(table)}/dataset`,
      options,
    ),
    caveGet<UserCache>(`${apiBase}/user/cache`, options),
  ])
  if (typeof dataset !== 'string' || dataset === '') {
    throw new Error(`The auth service names no permission dataset for table ${table}.`)
  }
  const mayEdit = (user.permissions_v2?.[dataset] ?? []).includes('edit')
  const ignoringTerms = (user.permissions_v2_ignore_tos?.[dataset] ?? []).includes('edit')
  return { dataset, mayEdit, termsPending: !mayEdit && ignoringTerms }
}
