/**
 * The providers this build offers.
 *
 * A static list rather than a `registerSource`-style registry, for the same reason
 * `datasetFamilies` is one: these are all built in, the panel has to render before anything is
 * configured, and a provider added later is a file in this directory plus a line here.
 *
 * Its own module, and that is not tidiness: `credentials.ts` needs the list to know which keys
 * to load and what a provider's defaults are, while `registry.ts` needs the credentials to fill
 * a request in. Putting the list beside the request would make those two import each other,
 * and the loser of a cycle is whichever module happens to be evaluated first — silently.
 *
 * Anthropic is first because it is the one measured — see `assistant/live.test.ts`. The others
 * had their browser reachability verified by hand against the live endpoints; the *quality* of
 * the plans they produce has not been measured by anybody.
 */

import { anthropic } from './anthropic'
import { gemini } from './gemini'
import { ollama } from './ollama'
import { openai } from './openai'
import type { AiProvider } from './types'

export const PROVIDERS: readonly AiProvider[] = [anthropic, openai, gemini, ollama]

export function providerFor(id: string): AiProvider | undefined {
  return PROVIDERS.find((entry) => entry.id === id)
}
