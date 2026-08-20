/**
 * OpenAI — Chat Completions.
 *
 * Verified to allow direct browser access: the preflight echoes the origin and allow-lists
 * `authorization`, so like Anthropic it needs no proxy and works on the static build.
 *
 * **The plan schema already satisfies strict mode**, which is a coincidence worth recording
 * rather than relying on: `planJsonSchema` marks every property `required` and every object
 * `additionalProperties: false` because *Anthropic's* structured outputs demanded it, and those
 * happen to be exactly OpenAI's two strict-mode rules. If that schema is ever loosened for one
 * provider it silently stops working on the other, and the failure is a 400 at request time.
 *
 * There is no cache control here. OpenAI caches long prefixes automatically and does not let a
 * caller ask, so the usage this reports has zeroes in the cache fields — meaning "no decision
 * of ours", not "nothing was cached".
 */

import { declined, getJson, noText, postJson, raiseHttpError, truncated } from './http'
import type { AiProvider, CompletionRequest, CompletionResult, KeyCheck } from './types'

const BASE_URL = 'https://api.openai.com'

interface ApiResponse {
  model?: string
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

function headers(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}` }
}

export const openai: AiProvider = {
  id: 'openai',
  label: 'OpenAI',
  keyUrl: 'https://platform.openai.com/api-keys',
  needsKey: true,
  note: 'GPT models. Long prompts are cached automatically, so repeat turns are cheaper without anything being configured.',
  models: [
    { id: 'gpt-4o', label: 'GPT-4o' },
    { id: 'gpt-4o-mini', label: 'GPT-4o mini' },
    { id: 'gpt-4.1', label: 'GPT-4.1' },
    { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini' },
  ],
  defaultModel: 'gpt-4o',
  defaultBaseUrl: BASE_URL,
  schemaSupport: 'native',

  async verify({ apiKey, model, baseUrl, signal }) {
    // `GET /v1/models/{id}` costs nothing and checks the key and the id together, the same
    // trade as the Anthropic tab: a typo'd model would otherwise wait for the first request.
    const base = baseUrl || BASE_URL
    const id = model || openai.defaultModel
    const { status, ok, payload } = await getJson(
      `${base}/v1/models/${encodeURIComponent(id)}`,
      headers(apiKey ?? ''),
      signal,
    )
    if (!ok) raiseHttpError('OpenAI', status, payload, 'Wait a moment, or check your quota.')
    const body = payload as { id?: string }
    return { model: body.id ?? id, label: body.id ?? id, context: 0 } satisfies KeyCheck
  },

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const base = request.baseUrl || BASE_URL
    const model = request.model || openai.defaultModel

    const body = {
      model,
      messages: [
        { role: 'system', content: request.system },
        ...request.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
      ...(request.schema
        ? {
            response_format: {
              type: 'json_schema',
              // `strict` is what makes the schema binding rather than advisory. The name is
              // required and is not otherwise used.
              json_schema: { name: 'coda_plan', schema: request.schema, strict: true },
            },
          }
        : {}),
    }

    const { status, ok, payload } = await postJson(
      `${base}/v1/chat/completions`,
      headers(request.apiKey ?? ''),
      body,
      request.signal,
    )
    if (!ok) raiseHttpError('OpenAI', status, payload, 'Wait a moment, or check your quota.')

    const reply = payload as ApiResponse
    const choice = reply.choices?.[0]

    /*
     * A truncated reply is a successful 200 whose JSON is half-written, so it has to be caught
     * here rather than left to the parser — "unexpected end of JSON" sends somebody looking for
     * a bug in the plan format when the answer is that the reply was cut off.
     */
    if (choice?.finish_reason === 'length') truncated()
    if (choice?.finish_reason === 'content_filter') declined()

    const text = choice?.message?.content ?? ''
    if (!text) noText('OpenAI')

    return {
      text,
      model: reply.model ?? model,
      usage: {
        inputTokens: reply.usage?.prompt_tokens ?? 0,
        outputTokens: reply.usage?.completion_tokens ?? 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
      },
    }
  },
}
