/**
 * The half of an HTTP call every provider does agree about.
 *
 * Not a shared transport — the providers disagree about almost everything that matters: the
 * auth header's *name*, the shape of an error body, and even which status code means "bad key"
 * (Gemini says 400). Trying to unify those would be a config object with one entry per
 * provider, which is the same code with an indirection in front of it.
 *
 * What genuinely is shared is the part that has no provider in it: sending JSON, keeping an
 * abort an abort, and saying something useful when the request never left the browser.
 */

import { errorMessage } from '../../core/errors'
import { AiError } from './types'

/**
 * POST JSON and hand back the parsed body with its status.
 *
 * The body is returned for **any** status, error included, because every provider puts its
 * reason in the response body and each reads it differently. Deciding what a status means is
 * the caller's job; getting the bytes is this one's.
 */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal | undefined,
): Promise<{ status: number; ok: boolean; payload: unknown }> {
  return send(url, { method: 'POST', headers, body: JSON.stringify(body) }, signal)
}

export async function getJson(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal | undefined,
): Promise<{ status: number; ok: boolean; payload: unknown }> {
  return send(url, { method: 'GET', headers }, signal)
}

async function send(
  url: string,
  init: RequestInit,
  signal?: AbortSignal | undefined,
): Promise<{ status: number; ok: boolean; payload: unknown }> {
  let response: Response
  try {
    response = await fetch(url, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers as object) },
      ...(signal ? { signal } : {}),
    })
  } catch (error) {
    // An AbortError is the caller cancelling; it must stay an AbortError.
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new AiError(networkMessage(url, error), 0)
  }
  const payload = await response.json().catch(() => ({}))
  return { status: response.status, ok: response.ok, payload }
}

/**
 * What a `TypeError` from `fetch` means, which depends entirely on where it was going.
 *
 * A browser reports a CORS refusal, a dead host and a blocked port identically, so the message
 * cannot say which — but it can rule things out, and the two cases have completely different
 * fixes. A cloud endpoint is either unreachable or being blocked by something in the page; a
 * `localhost` one is almost always a local server that is not running or has not been told to
 * accept this origin, which is a setting the user owns and would otherwise never think of.
 */
function networkMessage(url: string, error: unknown): string {
  const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(url)
  const where = new URL(url).origin

  if (local) {
    return (
      `Could not reach ${where}. Is the server running, and is it set to accept requests from ` +
      `this page? Ollama needs OLLAMA_ORIGINS to include this origin. Note a page served over ` +
      `https may be blocked from reaching a plain-http local server at all. (${errorMessage(error)})`
    )
  }
  return (
    `Could not reach ${where}. This request goes straight from the browser, so there is no ` +
    `proxy to blame — check the connection, or whether an extension or a Content-Security-` +
    `Policy is blocking it. (${errorMessage(error)})`
  )
}

/** Dig a message out of whatever shape a provider buries it in. */
export function messageIn(payload: unknown, fallback: string): string {
  const body = payload as { error?: { message?: string } | string; message?: string }
  if (typeof body?.error === 'string') return body.error
  if (typeof body?.error?.message === 'string') return body.error.message
  if (typeof body?.message === 'string') return body.message
  return fallback
}

/**
 * Ask for JSON in words, for a model that will not be told it in a field.
 *
 * Two providers need this and they arrive at it from opposite directions, which is why it is
 * here rather than in either of them. Gemini cannot express the plan schema at all — its
 * `responseSchema` is an OpenAPI subset with no `anyOf`. Ollama can express it for a local GGUF
 * build and *silently cannot* for anything else: a cloud model accepts `format` and ignores it,
 * and so does an MLX build. Same remedy, same words, and a second copy would be a second thing
 * to keep in step — `raiseHttpError`'s reasoning one function down, for the same reason.
 *
 * Appended to the *system* text rather than to the user turn, so it is a standing instruction
 * rather than something restated per question. That also keeps it inside the cached prefix:
 * appending a constant leaves the prefix byte-identical between turns, which is what Anthropic's
 * cache breakpoint and llama.cpp's KV reuse both need.
 *
 * Measured against `gemma4:31b-cloud` on Coda's real prompt, five reps each: the schema sent as
 * `format` alone parsed **1/5**, and described here **5/5**, applying a six-node graph every
 * time. It costs 632 prompt tokens. See `ollama.ts`.
 */
export function withSchema(system: string, schema: object | undefined): string {
  if (!schema) return system
  return (
    `${system}\n\n---\n\nAnswer with a single JSON object and nothing else — no prose, no code ` +
    `fence. It must satisfy this JSON Schema:\n\n${JSON.stringify(schema)}`
  )
}

/**
 * The failure ladder every provider walks, and the verdicts they all reach.
 *
 * Shared even though `complete` deliberately is not — the header above argues against a common
 * *transport*, because the auth header, the error body and even which status means "bad key"
 * genuinely differ. None of that is in here. What is in here is the wording, and three copies
 * of a sentence is three chances for one to drift: `Check it in Connections` names a panel that
 * was called Sources a day ago, and a rename that finds three of four literals leaves the odd
 * one pointing at a button nobody can find.
 *
 * A provider still owns its own status mapping and calls this once it has decided. Gemini's
 * whole difference — a rejected key arriving as a 400 — is expressed by translating before it
 * gets here, which is exactly where that decision belongs.
 */
export function raiseHttpError(
  label: string,
  status: number,
  payload: unknown,
  rateHint = 'Wait a moment and try again.',
): never {
  if (status === 401 || status === 403) {
    throw new AiError(
      `${label} rejected the key${status === 401 ? '' : ` (${status})`}. ` +
        messageIn(payload, 'Check it in Connections.'),
      status,
    )
  }
  if (status === 429) {
    throw new AiError(`Rate limited by ${label}. ${messageIn(payload, rateHint)}`, 429)
  }
  throw new AiError(messageIn(payload, `${label} returned ${status}.`), status)
}

/*
 * The two verdicts that arrive as a *successful* response, so every provider has to look for
 * them and none can rely on a status code.
 *
 * Normalised here rather than left to each provider because the one that skipped them was the
 * one that needs them most: Ollama runs a local model at a fixed context against a ~10k-token
 * prompt, so a truncated reply is its ordinary case rather than its edge case — and untreated
 * it reaches `parsePlan` and is reported as "the reply was not JSON", which sends somebody
 * looking for a bug in the plan format.
 */
export function truncated(): never {
  throw new AiError(
    'The reply hit the length limit before it finished, so the plan is incomplete. ' +
      'Ask for a smaller change.',
    200,
  )
}

export function declined(category?: string | null | undefined): never {
  throw new AiError(
    `The model declined this request${category ? ` (${category})` : ''}. Rephrasing usually helps.`,
    200,
  )
}

export function noText(label: string): never {
  throw new AiError(`${label} returned no text to read.`, 200)
}
