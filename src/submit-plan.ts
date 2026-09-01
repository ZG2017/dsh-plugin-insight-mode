/**
 * `submit_insight_plan`: the human-approval gate. The master proposes a
 * full task breakdown + total budget; nothing in this plugin lets a worker
 * run until the user approves it here. Mirrors dsh-plan-mode's own
 * `exit_plan_mode` tool (packages/plan/plan-mode/src/index.ts) - same
 * `ctx.userQuestions.ask()` call, same Approve/Revise review shape, same
 * `UserQuestionError`/`ASK_CANCELLED` handling, same reject-with-feedback
 * error that sends the model back to revise and resubmit. Reuses
 * plan-mode's own `intent: {kind: 'plan-review', ...}` presentation tag
 * rather than adding a new one - `AskUserQuestionIntent` is a closed union
 * baked into the wire schema and multiple client render paths, and the tag
 * only changes presentation, never the protocol, so widening it repo-wide
 * for a cosmetic label isn't worth it here.
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import { setApprovedPlan } from './state.ts'
import type { TaskPackage } from './types.ts'

const REVIEW_ID = 'insight-plan-review'
const APPROVE_LABEL = 'Approve'
const REVISE_LABEL = 'Revise'

const DESCRIPTION = 'Submit your finished task breakdown for the user\'s approval before dispatching any worker. '
  + 'Include one task package per independent subtask, plus the total budget you agreed with the user. '
  + 'No worker can be dispatched for any task until this plan is approved. On approval, begin calling '
  + 'dispatch_insight_worker. On "Revise", the user\'s feedback comes back in the tool result - revise and resubmit.'

function renderPlanMarkdown(taskPackages: readonly TaskPackage[], totalBudgetUsd: number): string {
  const sections = taskPackages.map((task, index) => {
    const lines = [
      `${index + 1}. **${task.id}** — ${task.goal}`,
      `   - Research operating budget (your own compute/tool-call cost, not a price/spending figure from the research subject itself): $${task.budgetUsd.toFixed(2)}`,
      `   - Acceptance criteria: ${task.acceptanceCriteria}`,
      `   - Research summary: ${task.researchSummary}`,
    ]
    if (task.sourceLinks.length > 0) lines.push(`   - Sources: ${task.sourceLinks.join(', ')}`)
    lines.push(`   - Thinking so far: ${task.masterThinkingSummary}`)
    return lines.join('\n')
  })
  return `# Insight plan\n\nTotal research operating budget (your own compute/tool-call cost): $${totalBudgetUsd.toFixed(2)}\n\n${sections.join('\n\n')}`
}

export function installSubmitInsightPlan(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'submit_insight_plan',
    description: DESCRIPTION,
    parameters: {
      taskPackages: {
        type: 'array',
        required: true,
        description: 'One independent task package per subtask. Keep tightly-coupled/sequential work (e.g. dev-env setup + backend + frontend that all depend on each other) in ONE package; split only genuinely independent work (e.g. one package per company in a multi-company survey).',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            id: { type: 'string', required: true, description: 'Short stable id, e.g. "task-openai".' },
            goal: { type: 'string', required: true, description: 'What this task must accomplish.' },
            researchSummary: { type: 'string', required: true, description: 'Your research summary relevant to this task.' },
            sourceLinks: { type: 'array', required: true, items: { type: 'string' }, description: 'Original links backing the research summary.' },
            masterThinkingSummary: { type: 'string', required: true, description: 'Your reasoning so far, relevant to this task.' },
            acceptanceCriteria: { type: 'string', required: true, description: 'Concrete, checkable pass criteria, e.g. "cite at least 5 papers", "unit tests pass".' },
            budgetUsd: { type: 'number', required: true, description: 'Dollar budget for YOUR OWN research operation on this task (compute/tool-call cost) - not a price/spending figure that happens to be part of the research subject itself.' },
          },
        },
      },
      totalBudgetUsd: { type: 'number', required: true, description: 'Total research operating budget (your own compute/tool-call cost) agreed with the user across all tasks - distinct from any price/spending figure that happens to be part of the research subject itself.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          approved: { type: 'boolean', const: true, required: true },
        },
      },
      render: () => [{ type: 'text', text: 'Plan approved - you may now dispatch workers with dispatch_insight_worker.' }],
    },
    execute: async (args, exec) => {
      const agent = exec.agent
      if (agent === undefined) throw new Error('submit_insight_plan requires a calling agent (no session to review against)')
      if (args.taskPackages.length === 0) throw new Error('submit_insight_plan requires at least one task package')

      const interaction = ctx.get('userQuestions')
      if (interaction === undefined) {
        throw new Error('no user-questions channel is available to review the plan; ask the user to switch the session mode instead')
      }

      const answer = await interaction.ask({
        questions: [{
          id: REVIEW_ID,
          header: 'Insight plan review',
          question: 'Approve this insight plan and its budget?',
          detail: renderPlanMarkdown(args.taskPackages, args.totalBudgetUsd),
          options: [
            { label: APPROVE_LABEL, description: 'Workers may now be dispatched for each task.' },
            { label: REVISE_LABEL, description: 'Feedback goes back to you; revise and resubmit.' },
          ],
          intent: { kind: 'plan-review', approve: APPROVE_LABEL },
        }],
        agent,
        signal: exec.signal,
      }).catch((cause: unknown) => {
        if (cause instanceof UserQuestionError && cause.code === 'ASK_CANCELLED') {
          throw new Error('The user dismissed the plan review to say something instead; stop here and wait for their message.')
        }
        throw cause
      })

      const reviewItems = answer.answers.filter(entry => entry.id === REVIEW_ID)
      const item = reviewItems.length === 1 ? reviewItems[0] : undefined
      if (item?.selected.length !== 1 || item.selected[0] !== APPROVE_LABEL || item.custom !== undefined) {
        const feedback = item?.custom ?? ''
        throw new Error(feedback === ''
          ? 'The user chose to revise; update the plan and submit it again.'
          : `The user chose to revise; their feedback: ${feedback}`)
      }

      setApprovedPlan(agent.id, {
        tasksById: new Map(args.taskPackages.map(task => [task.id, task])),
        totalBudgetUsd: args.totalBudgetUsd,
      })
      return { approved: true }
    },
    presentCall: args => ({
      card: 'generic',
      title: 'Insight plan',
      kind: 'other',
      content: [{ type: 'text', text: renderPlanMarkdown(args.taskPackages, args.totalBudgetUsd) }],
    }),
    presentResult: (_args, result) => ({
      card: 'generic',
      title: 'Insight plan review',
      content: result.content,
    }),
  }))
}
