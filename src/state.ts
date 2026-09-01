/**
 * Plugin-local, in-memory per-session state: which task packages the user
 * has approved (via submit_insight_plan), and how many times each has been
 * redispatched. NOT durable - lost on process restart: control-flow
 * bookkeeping only, not something a resumed session needs to reconstruct
 * (a restart just means the master has to call submit_insight_plan again
 * before dispatching further workers).
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import type { TaskPackage } from './types.ts'

export interface ApprovedPlan {
  readonly tasksById: ReadonlyMap<string, TaskPackage>
  readonly totalBudgetUsd: number
}

interface InsightState {
  plan: ApprovedPlan
  readonly retriesById: Map<string, number>
}

const states = new Map<SessionId, InsightState>()

export function approvedPlanFor(sessionId: SessionId): ApprovedPlan | undefined {
  return states.get(sessionId)?.plan
}

/** Replaces any previously approved plan and resets retry counters for this session. */
export function setApprovedPlan(sessionId: SessionId, plan: ApprovedPlan): void {
  states.set(sessionId, { plan, retriesById: new Map() })
}

export function retriesFor(sessionId: SessionId, taskId: string): number {
  return states.get(sessionId)?.retriesById.get(taskId) ?? 0
}

export function recordRetry(sessionId: SessionId, taskId: string): void {
  const state = states.get(sessionId)
  if (state === undefined) return
  state.retriesById.set(taskId, (state.retriesById.get(taskId) ?? 0) + 1)
}
