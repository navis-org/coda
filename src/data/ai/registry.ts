/**
 * The one call the assistant makes, and the only place a credential meets a provider.
 *
 * `PROVIDERS` itself lives in `providers.ts` and is re-exported here for callers that want
 * both — see that file for why the list cannot sit beside this function.
 *
 * The auth channel is raised here rather than in each provider, so a provider only has to get
 * its *status code* right. That matters most for Gemini, which reports a rejected key as a 400
 * and has to translate before this can recognise it.
 */

import { getBaseUrl, getKey, getModel, getProviderId, reportAuthFailure } from './credentials'
import { PROVIDERS, providerFor } from './providers'
import type { CompletionRequest, CompletionResult, KeyCheck } from './types'
import { AiError } from './types'

export { PROVIDERS, providerFor }

/**
 * Ask the selected provider, filling in whatever the caller did not override.
 *
 * The single entry point `assistant/converse.ts` uses, so nothing above this file knows a
 * provider exists — which is the property that made adding three of them a matter of writing
 * them rather than of changing the assistant.
 */
export async function complete(request: CompletionRequest): Promise<CompletionResult> {
  const id = getProviderId()
  const provider = providerFor(id)
  if (!provider) throw new AiError(`No AI provider called "${id}".`, 0)

  const apiKey = request.apiKey ?? getKey(id)
  if (provider.needsKey && !apiKey) {
    const message = `No ${provider.label} API key. Add one in Connections — the branch icon in the toolbar.`
    reportAuthFailure(message)
    throw new AiError(message, 401)
  }

  try {
    return await provider.complete({
      ...request,
      ...(apiKey ? { apiKey } : {}),
      model: request.model ?? getModel(id),
      baseUrl: request.baseUrl ?? getBaseUrl(id),
    })
  } catch (error) {
    // One place to raise the channel, so a provider only has to get its *status* right.
    if (error instanceof AiError && (error.status === 401 || error.status === 403)) {
      reportAuthFailure(error.message)
    }
    throw error
  }
}

/** Check a credential without committing to it. Used by the Connections panel's Test button. */
export async function verify(options: {
  providerId: string
  apiKey?: string | undefined
  model?: string | undefined
  baseUrl?: string | undefined
  signal?: AbortSignal | undefined
}): Promise<KeyCheck> {
  const provider = providerFor(options.providerId)
  if (!provider) throw new AiError(`No AI provider called "${options.providerId}".`, 0)
  return provider.verify(options)
}
