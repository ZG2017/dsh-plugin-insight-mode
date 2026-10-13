/**
 * Insight Mode: master/worker agentic architecture. The top-level agent
 * (the "master") is the model itself, conversing normally with the user -
 * there is no separate host-orchestrated automaton and no separate planner/
 * verifier subagent. This plugin mounts the two tools that give the master
 * a structured way to (1) get human approval for a task breakdown + budget
 * before any work starts, and (2) dispatch an independent, budget-aware,
 * user-isolated worker per approved task - and registers its own identity
 * directly as the `deployment:persona-prefix` prompt section (see
 * persona.ts and `apply()` below), so installing this plugin is
 * sufficient on its own; no external preset needs to supply persona text.
 * Everything else - talking to the user, comprehensive research, deciding
 * the breakdown, reviewing a worker's result and deciding whether to
 * redispatch with guidance, reporting progress - is ordinary model
 * behavior driven by that persona, not host code.
 *
 * The persona registration only takes effect the way `@deepseek-ai/dsh-persona`
 * itself does: mounted as a row inside an agent preset, it shadows the
 * deployment's default persona for that one session (PERSONA_PREFIX_SECTION
 * is exported by dsh-system-prompt specifically so both sides name the
 * same section, which is what makes a preset's own persona SHADOW the
 * deployment default rather than duplicate it). A preset that also mounts
 * a separate `dsh-persona` row for the SAME session would collide -
 * `ctx.systemPrompt.section()` throws on two registrations of the same
 * section name within one scope layer - so a preset using this plugin
 * should not carry its own persona row (see this package's bundled
 * preset/agent.cordis.yml, which omits one for exactly this reason).
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import * as dshSystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { installSubmitInsightPlan } from './submit-plan.ts'
import { installDispatchInsightWorker } from './dispatch-worker.ts'
import { PERSONA_TEXT } from './persona.ts'
import type { ModelRoute } from './types.ts'

// dsh-system-prompt renamed its single `deployment:persona` section to
// `deployment:persona-prefix` (exported as PERSONA_PREFIX_SECTION,
// pairing it with a new PERSONA_SUFFIX_SECTION slot) at some point after
// the harness version this plugin was first written against, which only
// ever exported the older PERSONA_SECTION name. A static named import of
// either single name breaks whichever release doesn't have it - Node
// throws "does not provide an export" at module-load time, before any
// code here even runs, so there's nothing to catch. Reading the
// namespace object at runtime and falling back is what lets this same
// published source keep working against both.
const PERSONA_SECTION_NAME = ((dshSystemPrompt as Record<string, unknown>).PERSONA_PREFIX_SECTION
  ?? (dshSystemPrompt as Record<string, unknown>).PERSONA_SECTION) as string

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
  // z.object(...) sets an implicit meta.default of {} at construction time
  // (schemastery's own object/dict type factory), regardless of whether
  // .default() is ever called - so routeSchema alone, unqualified, would
  // still resolve an ABSENT workerModel to {} and then fail on routeSchema's
  // own required provider/model fields, exactly the mount-time crash this
  // field is meant to avoid on a deployment that never configures it.
  // .default(undefined) overrides that implicit default back to nullable,
  // which is what actually makes an absent workerModel resolve to
  // undefined - confirmed live: this exact line was the fix for a real
  // "missing required value (at workerModel.provider)" mount failure
  // reproduced on a vanilla DSH install with no workerModel configured.
  // `as never`: schemastery's typing has no nullable default for a required object.
  workerModel: routeSchema.default(undefined as never),
})

export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => ctx.systemPrompt.section({
    name: PERSONA_SECTION_NAME,
    // dsh-system-prompt's own centrally allocated position for this exact
    // section (SECTION_ORDERS.DEPLOYMENT_PERSONA_PREFIX) - hardcoded
    // rather than resolved through ctx.systemPrompt.getSectionOrder()
    // since that accessor doesn't exist on every dsh-system-prompt
    // release this plugin needs to run against; the position itself is a
    // fixed protocol constant of the package, not something that varies
    // per deployment.
    order: 0,
    text: PERSONA_TEXT,
  }), 'insight-mode: persona.section()')
  installSubmitInsightPlan(ctx)
  installDispatchInsightWorker(ctx, config)
  ctx.logger.info('insight-mode: mounted with config: %o', config)
}
