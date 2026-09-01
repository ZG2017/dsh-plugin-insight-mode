/**
 * `dispatch_insight_worker`: runs ONE approved task package as an
 * independent `spawn` subagent (fresh child, no parent-conversation seed).
 *
 * Structural "cannot talk to the user" guarantee: `toolFilter.allow` is an
 * ALLOW-list, not a deny-list - `tools.restrict()` removes every other
 * globally-registered tool from both the child's prompt catalog and its
 * execution, so `ask_user_question` (and every delegation tool) is simply
 * never available to a worker, not just discouraged.
 *
 * Budget is soft-enforced only: the allocated budget rides in the worker's
 * own prompt as an instruction, and `costForSession` (cost-tracker's
 * escape hatch) reports actual spend back to the master in the tool result
 * once the worker returns - master factors overspend into its own judgment.
 * Nothing here aborts a worker mid-flight for going over budget.
 */

import type { Context } from '@deepseek-ai/cordis'
import type LlmRuntime from '@deepseek-ai/dsh-llm'
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from './index.ts'
import { runSubagentResilient } from './subagent-utils.ts'
import { approvedPlanFor, recordRetry, retriesFor } from './state.ts'
import { WORKER_RESULT_SCHEMA, type TaskPackage, type WorkerResult } from './types.ts'

/** Only the shell tool actually mounted on this OS is ever globally registered - see agent.cordis.yml's own platform `disabled` split. */
const SHELL_TOOL = process.platform === 'win32' ? 'pwsh' : 'bash'

const WORKER_ALLOWED_TOOLS = [SHELL_TOOL, 'read', 'edit', 'write', 'read_image', 'glob', 'grep', 'web_search', 'skill', 'todo_write']

const WORKER_PERSONA = 'You are an independent researcher/engineer with the depth and rigor of a PhD-level specialist. '
  + 'You work alone - there is no user to ask; make reasonable assumptions and note them in your output instead of '
  + 'asking. Check real state (run it, read it back) rather than trusting your own assumptions. Before returning, '
  + 'honestly assess whether your output actually meets the acceptance criteria you were given - do not claim '
  + 'success you have not verified.'

function buildWorkerPrompt(task: TaskPackage, guidance: string | undefined): string {
  const parts = [
    `Goal: ${task.goal}`,
    `Acceptance criteria (you must meet these before returning): ${task.acceptanceCriteria}`,
    `Your research operating budget for this task: $${task.budgetUsd.toFixed(2)} (your own compute/tool-call cost - `
      + 'NOT a price/spending limit related to the research subject itself, if one happens to be mentioned in the '
      + 'goal below). Stay within your own operating budget; work efficiently.',
    task.researchSummary === '' ? undefined : `Research so far:\n${task.researchSummary}`,
    task.sourceLinks.length === 0 ? undefined : `Sources:\n${task.sourceLinks.join('\n')}`,
    task.masterThinkingSummary === '' ? undefined : `Notes from whoever assigned this:\n${task.masterThinkingSummary}`,
    guidance === undefined ? undefined : `Feedback from a previous attempt - address this:\n${guidance}`,
  ]
  return parts.filter((part): part is string => part !== undefined).join('\n\n')
}

/**
 * No `Config.workerModel` set (the default) means a worker simply inherits
 * the master's own provider/model - `agentOptions` omitted entirely,
 * `resolveChildAgentOptions` (dsh-subagent) falls back to the parent's
 * route whenever a child doesn't specify its own. When `workerModel` IS
 * set, it's deployment-provided config, not a guarantee: a deployment with
 * no adapter registered for that provider (e.g. an OpenRouter route
 * configured on a deployment with no OpenRouter credentials) would
 * otherwise fail every worker with an `LlmError`/`NO_ADAPTER`. Checking
 * `ctx.llm.listProviders()` (the registered-adapter list) before dispatch
 * and falling back to the master's model the same way when the configured
 * provider isn't there trades away the cheap-worker cost savings only on a
 * deployment where the configured route genuinely isn't available, rather
 * than failing every worker outright.
 */
function resolveWorkerAgentOptions(ctx: Context, config: Config): { provider: string, model: string } | undefined {
  const workerModel = config.workerModel
  if (workerModel === undefined) return undefined
  const llm = ctx.get('llm') as LlmRuntime | undefined
  const configuredProviderAvailable = llm === undefined || llm.listProviders().some(info => info.id === workerModel.provider)
  if (configuredProviderAvailable) return { provider: workerModel.provider, model: workerModel.model }
  ctx.logger.warn('insight-mode: workerModel provider "%s" has no registered adapter - falling back to the master\'s own model for this worker', workerModel.provider)
  return undefined
}

export function installDispatchInsightWorker(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'dispatch_insight_worker',
    description: 'Dispatch an independent worker to carry out ONE approved task package. The worker cannot talk '
      + 'to the user and cannot dispatch further workers. Only task ids from an approved submit_insight_plan '
      + 'call can be dispatched. Call this multiple times in one step to run independent tasks in parallel. Pass '
      + '`guidance` when re-dispatching a task that previously failed to meet its acceptance criteria.',
    parameters: {
      taskId: { type: 'string', required: true, description: 'The id of an approved task package.' },
      guidance: { type: 'string', description: 'Specific feedback for a retry - what to fix from the previous attempt.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          output: { type: 'string', required: true },
          metAcceptanceCriteria: { type: 'boolean', required: true },
          selfAssessment: { type: 'string', required: true },
          sourceLinks: { type: 'array', required: true, items: { type: 'string' } },
          budgetUsd: { type: 'number', required: true },
          actualCostUsd: { type: 'number' },
          stopReason: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    // Same reasoning as dsh-tool-subagent's own dispatch tool: a worker never
    // mutates the parent session, and the one parent-owned write this tool
    // makes (recordRetry) is a synchronous, per-taskId Map insert - safe to
    // overlap across the different task ids that independent packages use.
    // Without this, calling the tool multiple times in one step still runs
    // the calls one at a time (defineTool defaults to 'exclusive'), which
    // defeats the whole point of dispatching independent tasks in parallel.
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const agent = exec.agent
      if (agent === undefined) throw new Error('dispatch_insight_worker requires a calling agent')
      if (delegationDepthOf(agent) > 0) throw new Error('dispatch_insight_worker cannot be called from within a worker')

      const plan = approvedPlanFor(agent.id)
      const task = plan?.tasksById.get(args.taskId)
      if (task === undefined) {
        throw new Error(`no approved task "${args.taskId}" - call submit_insight_plan first, or check the task id`)
      }
      const retries = retriesFor(agent.id, args.taskId)
      if (retries >= config.maxWorkerRetries) {
        throw new Error(`task "${args.taskId}" has already been retried ${retries} time(s) (limit ${config.maxWorkerRetries}) - `
          + 'stop retrying and report this limitation to the user instead.')
      }

      const workerAgentOptions = resolveWorkerAgentOptions(ctx, config)
      const run = await ctx.subagents.start('spawn', {
        label: `insight_worker_${task.id}`,
        prompt: [{ type: 'text', text: buildWorkerPrompt(task, args.guidance) }],
        parent: agent,
        signal: exec.signal,
        outputSchema: WORKER_RESULT_SCHEMA,
        toolFilter: { allow: WORKER_ALLOWED_TOOLS },
        persona: WORKER_PERSONA,
        // Fixed cheap route, independent of whatever model the master is
        // running on - see Config.workerModel's doc comment in index.ts.
        // Omitted (falls back to the master's own model) when that route
        // isn't available on this deployment - see resolveWorkerAgentOptions.
        ...workerAgentOptions === undefined ? {} : { agentOptions: workerAgentOptions },
      })
      recordRetry(agent.id, args.taskId)
      const outcome = await runSubagentResilient(run)

      if ('error' in outcome) {
        return {
          output: '',
          metAcceptanceCriteria: false,
          selfAssessment: `Worker failed to run: ${outcome.error}`,
          sourceLinks: [],
          budgetUsd: task.budgetUsd,
          stopReason: 'error',
        }
      }

      const { result } = outcome
      const costForSession = ctx.get('costForSession') as ((session: Session) => number | undefined) | undefined
      const actualCostUsd = run.localAgent === undefined ? undefined : costForSession?.(run.localAgent.session)

      if (result.stopReason !== 'completed' || result.structured === undefined) {
        return {
          output: '',
          metAcceptanceCriteria: false,
          selfAssessment: `Worker did not return a usable result (stopReason: ${result.stopReason}).`,
          sourceLinks: [],
          budgetUsd: task.budgetUsd,
          ...actualCostUsd === undefined ? {} : { actualCostUsd },
          stopReason: result.stopReason,
        }
      }

      const structured = result.structured as WorkerResult
      return {
        output: structured.output,
        metAcceptanceCriteria: structured.metAcceptanceCriteria,
        selfAssessment: structured.selfAssessment,
        sourceLinks: [...structured.sourceLinks],
        budgetUsd: task.budgetUsd,
        ...actualCostUsd === undefined ? {} : { actualCostUsd },
        stopReason: result.stopReason,
      }
    },
  }))
}
