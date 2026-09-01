/** Task-package and worker-result shapes shared across the master/worker tools. */

import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'

/** Provider/model pair for a worker's fixed agentOptions.model override - same shape as dsh-plugin-model-router's own ModelRoute. */
export interface ModelRoute {
  readonly provider: string
  readonly model: string
}

/** One independent subtask the master has divided the user's request into. */
export interface TaskPackage {
  readonly id: string
  readonly goal: string
  readonly researchSummary: string
  readonly sourceLinks: readonly string[]
  readonly masterThinkingSummary: string
  readonly acceptanceCriteria: string
  readonly budgetUsd: number
}

/** Structured result a dispatched worker must return. */
export interface WorkerResult {
  readonly output: string
  readonly metAcceptanceCriteria: boolean
  readonly selfAssessment: string
  readonly sourceLinks: readonly string[]
}

export const WORKER_RESULT_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  properties: {
    output: {
      type: 'string',
      description: 'Your full result: findings, code, or whatever the task required.',
    },
    metAcceptanceCriteria: {
      type: 'boolean',
      description: 'Whether your output actually satisfies the acceptance criteria you were given - check for real, do not assume.',
    },
    selfAssessment: {
      type: 'string',
      description: 'Why the acceptance criteria are or are not met.',
    },
    sourceLinks: {
      type: 'array',
      items: { type: 'string' },
      description: 'Original links backing your findings, if any.',
    },
  },
  required: ['output', 'metAcceptanceCriteria', 'selfAssessment', 'sourceLinks'],
}
