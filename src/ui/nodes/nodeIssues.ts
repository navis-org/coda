/**
 * Everything a node has to say about itself, in one order.
 *
 * There are three sources and they arrive by different routes: `evaluate` throwing (run state),
 * type inference (`NodeIssue[]`, edit-time), and `ctx.warn` (run state again, but about a result
 * that exists). The card shows the first of them and the inspector lists them all — which is
 * exactly the arrangement where two call sites quietly disagree, and they did: the card ranked a
 * run warning below an inference *error*, and the inspector put it above one.
 *
 * So the ranking lives here, stated once:
 *
 * 1. **A run error.** There is no result, and this says why.
 * 2. **A type error.** There will not be one, and this says why.
 * 3. **A run warning.** There *is* a result and it cost something — see `EvalContext.warn`.
 * 4. **A type warning.** A guess about a run, which by now may already have happened.
 *
 * The middle pair is the one worth stating rather than deriving: a warning about the result in
 * hand beats a warning about a run that has not happened, and both lose to either error, because
 * an error is about whether there is anything at all.
 */

import type { NodeIssue } from '../../core/inference'
import type { NodeRunInfo } from '../../core/scheduler'

export function nodeIssues(
  info: NodeRunInfo,
  inferred: readonly NodeIssue[] | undefined,
  runWarning: string | undefined,
): NodeIssue[] {
  const issues: NodeIssue[] = []
  if (info.state === 'error' && info.error) {
    issues.push({ severity: 'error', message: info.error })
  }
  for (const issue of inferred ?? []) if (issue.severity === 'error') issues.push(issue)
  if (runWarning) issues.push({ severity: 'warning', message: runWarning })
  for (const issue of inferred ?? []) if (issue.severity === 'warning') issues.push(issue)
  return issues
}
