/**
 * Google Gemini — `generateContent`.
 *
 * Verified to allow direct browser access: the preflight echoes the origin and allow-lists
 * `x-goog-api-key`, so no proxy here either.
 *
 * Two things differ from the others and both would be silent bugs.
 *
 * **A bad key is an HTTP 400, not a 401.** Every other provider here uses 401, so keying the
 * auth channel on the status code would file a rejected key as a malformed request — the panel
 * would not open, and the user would be told their *plan* was wrong. The body says
 * `reason: API_KEY_INVALID`, so that is what is read.
 *
 * **The schema is sent as JSON *mode*, not as a schema.** `responseSchema` is an OpenAPI subset
 * that historically did not accept `anyOf`, and the plan schema needs exactly one — a param
 * value is a string, a number, a boolean or a list of strings. Rather than ship a converter
 * whose failure mode is a 400 on a request the user paid for, the shape is described in the
 * prompt and the reply is only *required* to be JSON. `parsePlan` is lenient and the panel
 * reports a reply that is not a plan, so this degrades to a worse success rate rather than to a
 * broken feature.
 */

import { declined, noText, postJson, raiseHttpError, truncated } from './http'
import type { AiProvider, CompletionRequest, CompletionResult } from './types'

const BASE_URL = 'https://generativelanguage.googleapis.com'

interface ApiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> }
    finishReason?: string
  }>
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
}

function headers(key: string): Record<string, string> {
  return { 'x-goog-api-key': key }
}

/** True when a 400 is really "your key is wrong". See the header. */
function isKeyProblem(payload: unknown): boolean {
  const body = payload as {
    error?: { status?: string; message?: string; details?: Array<{ reason?: string }> }
  }
  if (body?.error?.details?.some((d) => d.reason === 'API_KEY_INVALID')) return true
  return /api key not valid|api_key_invalid/i.test(body?.error?.message ?? '')
}

/**
 * Gemini's one real difference, expressed where it belongs: translate, then delegate.
 *
 * A rejected key arrives as a 400. Every other provider uses 401, so passing the status
 * straight on would file it as a malformed request — the panel would not open and the user
 * would be told their *plan* was wrong.
 */
function raise(status: number, payload: unknown): never {
  const key = status === 400 && isKeyProblem(payload)
  raiseHttpError('Google', key ? 401 : status, payload, 'Wait a moment, or check your quota.')
}

/**
 * Ask for JSON in the prompt, since the request cannot carry the schema itself.
 *
 * Appended to the *system* text rather than to the user turn, so it is a standing instruction
 * rather than something restated per question. Nothing is lost by appending: this provider has
 * no prompt caching to invalidate, which is the only reason the prefix is otherwise sacred.
 */
function withSchema(system: string, schema: object | undefined): string {
  if (!schema) return system
  return (
    `${system}\n\n---\n\nAnswer with a single JSON object and nothing else — no prose, no code ` +
    `fence. It must satisfy this JSON Schema:\n\n${JSON.stringify(schema)}`
  )
}

export const gemini: AiProvider = {
  id: 'gemini',
  label: 'Google Gemini',
  keyUrl: 'https://aistudio.google.com/apikey',
  needsKey: true,
  note: 'Gemini models, with a free tier. The plan format is described in the prompt rather than enforced, so expect it to need a retry slightly more often.',
  models: [
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
  ],
  defaultModel: 'gemini-2.5-flash',
  defaultBaseUrl: BASE_URL,
  schemaSupport: 'json-mode',

  async verify({ apiKey, model, baseUrl, signal }) {
    /*
     * A real generation, unlike the other two — and deliberately the smallest one possible.
     * Gemini's model-metadata endpoint answers without a key at all on some deployments, so it
     * would confirm the model exists while saying nothing about whether the key works, which is
     * the question the button is actually asking.
     */
    const base = baseUrl || BASE_URL
    const id = model || gemini.defaultModel
    const { status, ok, payload } = await postJson(
      `${base}/v1beta/models/${encodeURIComponent(id)}:generateContent`,
      headers(apiKey ?? ''),
      {
        contents: [{ role: 'user', parts: [{ text: 'Reply with the single word OK.' }] }],
        generationConfig: { maxOutputTokens: 8 },
      },
      signal,
    )
    if (!ok) raise(status, payload)
    return { model: id, label: id, context: 0 }
  },

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const base = request.baseUrl || BASE_URL
    const model = request.model || gemini.defaultModel

    const body = {
      // Gemini has no assistant role: the model's turns are `model`.
      contents: request.messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      systemInstruction: { parts: [{ text: withSchema(request.system, request.schema) }] },
      ...(request.schema ? { generationConfig: { responseMimeType: 'application/json' } } : {}),
    }

    const { status, ok, payload } = await postJson(
      `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      headers(request.apiKey ?? ''),
      body,
      request.signal,
    )
    if (!ok) raise(status, payload)

    const reply = payload as ApiResponse
    const candidate = reply.candidates?.[0]

    if (candidate?.finishReason === 'MAX_TOKENS') truncated()
    if (
      candidate?.finishReason === 'SAFETY' ||
      candidate?.finishReason === 'PROHIBITED_CONTENT'
    ) {
      declined()
    }

    // Parts, joined: a reply can arrive split across several even when it is one JSON object.
    const text = (candidate?.content?.parts ?? []).map((part) => part.text ?? '').join('')
    if (!text) noText('Google')

    return {
      text,
      model,
      usage: {
        inputTokens: reply.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: reply.usageMetadata?.candidatesTokenCount ?? 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
      },
    }
  },
}
