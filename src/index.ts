/**
 * Insight Mode: master/worker agentic architecture. The top-level agent
 * (the "master") is the model itself, conversing normally with the user -
 * there is no separate host-orchestrated automaton and no separate planner/
 * verifier subagent. This plugin mounts the two tools that give the master
 * a structured way to (1) get human approval for a task breakdown + budget
 * before any work starts, and (2) dispatch an independent, budget-aware,
 * user-isolated worker per approved task - and registers its own identity
 * directly as the `deployment:persona` prompt section (see persona.ts and
 * `apply()` below), so installing this plugin is sufficient on its own; no
 * external preset needs to supply persona text. Everything else - talking
 * to the user, comprehensive research, deciding the breakdown, reviewing a
 * worker's result and deciding whether to redispatch with guidance,
 * reporting progress - is ordinary model behavior driven by that persona,
 * not host code.
 *
 * The persona registration only takes effect the way `@deepseek-ai/dsh-persona`
 * itself does: mounted as a row inside an agent preset, it shadows the
 * deployment's default persona for that one session. A preset that also
 * mounts a separate `dsh-persona` row for the SAME session would collide -
 * `ctx.systemPrompt.section()` throws on two registrations of the same
 * section name within one scope layer - so a preset using this plugin
 * should not carry its own persona row (see this package's bundled
 * preset/agent.cordis.yml, which omits one for exactly this reason).
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { PERSONA_ORDER, PERSONA_SECTION } from '@deepseek-ai/dsh-system-prompt'
import { installSubmitInsightPlan } from './submit-plan.ts'
import { installDispatchInsightWorker } from './dispatch-worker.ts'
import { PERSONA_TEXT } from './persona.ts'
import type { ModelRoute } from './types.ts'

export interface Config {
  /** Per-task-id cap on how many times a worker can be redispatched with guidance before the master must stop and report the limitation. */
  maxWorkerRetries: number
  /**
   * Optional provider/model every dispatched worker runs on, independent of
   * whatever model the master (the top-level session) is on. Unset by
   * default: with no configured route, a worker simply inherits the
   * master's own model (see dispatch-worker.ts's resolveWorkerAgentOptions)
   * - the only zero-assumption default for a plugin installed on an
   * arbitrary deployment, since no particular provider is guaranteed to be
   * configured. Set this to a cheap route your own deployment actually has
   * if you want worker cost decoupled from whatever model the master runs;
   * it must stay vision-capable if used, since WORKER_ALLOWED_TOOLS
   * includes read_image.
   */
  workerModel?: ModelRoute
}

export const name = 'insight-mode'
export const inject = ['tools', 'subagents', 'systemPrompt']

const routeSchema: z<ModelRoute> = z.object({
  provider: z.string().required(),
  model: z.string().required(),
})

export const Config: z<Config> = z.object({
  maxWorkerRetries: z.number().step(1).min(1).default(3),
  workerModel: routeSchema,
})

export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => ctx.systemPrompt.section({
    name: PERSONA_SECTION,
    order: PERSONA_ORDER,
    text: PERSONA_TEXT,
  }), 'insight-mode: persona.section()')
  installSubmitInsightPlan(ctx)
  installDispatchInsightWorker(ctx, config)
  ctx.logger.info('insight-mode: mounted with config: %o', config)
}
