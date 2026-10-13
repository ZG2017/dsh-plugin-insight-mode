/**
 * Dispose-safe subagent result collection, used by dispatch-worker.ts for
 * every worker it spawns.
 *
 * Mirrors deepseek-harness's own
 * packages/subagent/tool-subagent/src/index.ts's settleForegroundRun (a
 * result failure must never be masked by a disposal failure, and disposal
 * always runs even when the result already failed), but preserves the full
 * SubagentResult - including .structured - rather than flattening to text,
 * since dispatch-worker.ts needs the structured outputSchema payload.
 */

import type { SubagentActivation, SubagentResult } from '@deepseek-ai/dsh-subagent'

export async function runSubagentAndDispose(run: SubagentActivation): Promise<SubagentResult> {
  const [execution] = await Promise.allSettled([run.result])
  const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())])
  if (execution.status === 'rejected') {
    if (disposal.status === 'rejected') {
      throw new AggregateError(
        [execution.reason, disposal.reason],
        `subagent run failed: ${String(execution.reason)}; dispose failed: ${String(disposal.reason)}`,
      )
    }
    throw execution.reason
  }
  if (disposal.status === 'rejected') throw disposal.reason
  return execution.value
}

/**
 * Same as runSubagentAndDispose, but never throws - converts any failure
 * (a subagent's own model request exhausting DSH's retry policy, a dispose
 * failure, anything) into a result the caller can turn into a normal FAILED
 * report instead of crashing the whole dispatch call.
 */
export async function runSubagentResilient(run: SubagentActivation): Promise<{ result: SubagentResult } | { error: string }> {
  try {
    return { result: await runSubagentAndDispose(run) }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}
