/**
 * What the VFB modules share: one request helper and the guards their readers use.
 *
 * VFB computes an answer nobody has asked for recently on the spot (one `run_query` sent nothing
 * back within 90 s on 2026-10-14), so a slow answer is the ordinary cold case — and **time is never
 * a refusal** (CLAUDE.md, guard rails): a request waits for its answer and stops only when somebody
 * cancels it, its node's Cancel or a card moving on to another term. Both transports request
 * through `vfbJson`, so that cannot be decided two ways.
 */

import type { FetchTextOptions } from '../fetchText'
import { fetchText } from '../fetchText'

/** A JSON request to a VFB host: `fetchText`, parsed. */
export async function vfbJson(
  url: string,
  hint: string,
  signal: AbortSignal | undefined,
  init?: FetchTextOptions['init'],
): Promise<unknown> {
  const text = await fetchText(url, { hint, signal, init })
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error(`${url} did not answer JSON.`)
  }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A value that should be a list of strings, whether stored as a list or a single value. Neo4j
 * keeps many properties as one-element lists, and VFBquery's JSON is no more consistent.
 */
export function texts(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  return []
}

/** A non-empty string, or undefined: for a JSON field or a table cell that should be text. */
export function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

/** A value that should be one string: the first of `texts`. */
export function text(value: unknown): string | undefined {
  return texts(value)[0]
}

/**
 * A URL on VFB's own file server, upgraded to https, or undefined. VFB stores its file URLs as
 * `http://www.virtualflybrain.org/…`, which a page served over https would be refused as mixed
 * content, and the host serves https (measured), so the scheme is upgraded. Any other host or
 * scheme is dropped rather than followed — the value becomes an `<img src>` and a fetch, and a
 * table can carry anything. Read where a URL arrives and again where one is fetched.
 */
export function vfbUrl(value: unknown): string | undefined {
  const raw = text(value)
  if (!raw) return undefined
  try {
    const url = new URL(raw)
    const host =
      url.hostname === 'www.virtualflybrain.org' || url.hostname === 'virtualflybrain.org'
    if (!host || (url.protocol !== 'http:' && url.protocol !== 'https:')) return undefined
    url.protocol = 'https:'
    return url.href
  } catch {
    return undefined
  }
}

/** `vfbUrl` for a fetch: the https URL to ask for, or a refusal naming the URL that is not VFB's. */
export function vfbFileUrl(url: string): string {
  const safe = vfbUrl(url)
  if (!safe) throw new Error(`${url} is not on Virtual Fly Brain's file server.`)
  return safe
}
