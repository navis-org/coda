/**
 * Feedback submission via Web3Forms — a serverless POST straight from the browser, no backend
 * of Coda's own to run or pay for.
 *
 * The access key is meant to be public: Web3Forms scopes and rate-limits by key on their end,
 * the same way a Stripe *publishable* key works, so committing it here rather than hiding it
 * behind a build-time env var costs nothing and keeps the whole path readable in one file.
 */

import type { CodaGraph } from '../core/graph'

const ENDPOINT = 'https://api.web3forms.com/submit'
const ACCESS_KEY = '055393c1-6e61-4df4-9a4a-989a0f19da0a'

export type FeedbackCategory = 'bug' | 'feature' | 'general'

export const FEEDBACK_CATEGORY_LABEL: Record<FeedbackCategory, string> = {
  bug: 'Bug Report',
  feature: 'Feature Request',
  general: 'Get in Touch',
}

export interface FeedbackSubmission {
  category: FeedbackCategory
  message: string
  /** Left out of the request entirely when blank — Web3Forms treats an empty field as given. */
  email?: string
  /** Only ever built for `bug`, and only when the sender left the checkbox on. */
  diagnostics?: string
  /**
   * A link that reopens the graph as it stood when the report was sent — either the packed
   * `#!` fragment, or a gist link pasted in by hand when the graph was too large to pack.
   * Only ever offered for `bug`.
   */
  graphLink?: string
}

/**
 * What a bug report can say for itself without the sender typing any of it: the app version
 * (which build), the graph's shape (empty canvas vs. a hundred nodes reads very differently),
 * and the browser (half of "reproduce this" is which engine to open).
 */
export function buildFeedbackDiagnostics(graph: CodaGraph): string {
  const name = graph.meta?.name?.trim() || 'Untitled'
  return [
    `App version: ${typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev'}`,
    `URL: ${window.location.href}`,
    `Graph: "${name}" — ${graph.nodes.length} node(s), ${graph.edges.length} link(s)`,
    `User agent: ${navigator.userAgent}`,
  ].join('\n')
}

/** Throws with a message fit to show, on any refusal — network, HTTP, or Web3Forms itself. */
export async function submitFeedback(submission: FeedbackSubmission): Promise<void> {
  const form = new FormData()
  form.append('access_key', ACCESS_KEY)
  form.append('subject', `Coda feedback: ${FEEDBACK_CATEGORY_LABEL[submission.category]}`)
  form.append('category', FEEDBACK_CATEGORY_LABEL[submission.category])
  form.append('message', submission.message)
  if (submission.email) form.append('email', submission.email)
  if (submission.diagnostics) form.append('diagnostics', submission.diagnostics)
  if (submission.graphLink) form.append('graph_link', submission.graphLink)
  // Web3Forms' own honeypot: a field no human fills in, left blank on purpose.
  form.append('botcheck', '')

  let response: Response
  try {
    response = await fetch(ENDPOINT, { method: 'POST', body: form })
  } catch {
    throw new Error('Could not reach Web3Forms. Check your connection and try again.')
  }

  let body: { success?: boolean; message?: string } = {}
  try {
    body = (await response.json()) as { success?: boolean; message?: string }
  } catch {
    // Web3Forms always answers JSON; a missing body is not worth a second message.
  }
  if (!response.ok || !body.success) {
    throw new Error(body.message ?? `Web3Forms refused the submission (${response.status}).`)
  }
}
