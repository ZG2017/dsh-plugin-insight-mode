// src/index.ts
import z from "@deepseek-ai/schemastery";
import * as dshSystemPrompt from "@deepseek-ai/dsh-system-prompt";

// src/submit-plan.ts
import { defineTool } from "@deepseek-ai/dsh-tools";
import { UserQuestionError } from "@deepseek-ai/dsh-user-questions";

// src/state.ts
var states = /* @__PURE__ */ new Map();
function approvedPlanFor(sessionId) {
  return states.get(sessionId)?.plan;
}
function setApprovedPlan(sessionId, plan) {
  states.set(sessionId, { plan, retriesById: /* @__PURE__ */ new Map() });
}
function retriesFor(sessionId, taskId) {
  return states.get(sessionId)?.retriesById.get(taskId) ?? 0;
}
function recordRetry(sessionId, taskId) {
  const state = states.get(sessionId);
  if (state === void 0) return;
  state.retriesById.set(taskId, (state.retriesById.get(taskId) ?? 0) + 1);
}

// src/submit-plan.ts
var REVIEW_ID = "insight-plan-review";
var APPROVE_LABEL = "Approve";
var REVISE_LABEL = "Revise";
var DESCRIPTION = `Submit your finished task breakdown for the user's approval before dispatching any worker. Include one task package per independent subtask, plus the total budget you agreed with the user. No worker can be dispatched for any task until this plan is approved. On approval, begin calling dispatch_insight_worker. On "Revise", the user's feedback comes back in the tool result - revise and resubmit.`;
function renderPlanMarkdown(taskPackages, totalBudgetUsd) {
  const sections = taskPackages.map((task, index) => {
    const lines = [
      `${index + 1}. **${task.id}** \u2014 ${task.goal}`,
      `   - Research operating budget (your own compute/tool-call cost, not a price/spending figure from the research subject itself): $${task.budgetUsd.toFixed(2)}`,
      `   - Acceptance criteria: ${task.acceptanceCriteria}`,
      `   - Research summary: ${task.researchSummary}`
    ];
    if (task.sourceLinks.length > 0) lines.push(`   - Sources: ${task.sourceLinks.join(", ")}`);
    lines.push(`   - Thinking so far: ${task.masterThinkingSummary}`);
    return lines.join("\n");
  });
  return `# Insight plan

Total research operating budget (your own compute/tool-call cost): $${totalBudgetUsd.toFixed(2)}

${sections.join("\n\n")}`;
}
function installSubmitInsightPlan(ctx) {
  ctx.tools.register(defineTool({
    name: "submit_insight_plan",
    description: DESCRIPTION,
    parameters: {
      taskPackages: {
        type: "array",
        required: true,
        description: "One independent task package per subtask. Keep tightly-coupled/sequential work (e.g. dev-env setup + backend + frontend that all depend on each other) in ONE package; split only genuinely independent work (e.g. one package per company in a multi-company survey).",
        items: {
          type: "object",
          additionalProperties: true,
          properties: {
            id: { type: "string", required: true, description: 'Short stable id, e.g. "task-openai".' },
            goal: { type: "string", required: true, description: "What this task must accomplish." },
            researchSummary: { type: "string", required: true, description: "Your research summary relevant to this task." },
            sourceLinks: { type: "array", required: true, items: { type: "string" }, description: "Original links backing the research summary." },
            masterThinkingSummary: { type: "string", required: true, description: "Your reasoning so far, relevant to this task." },
            acceptanceCriteria: { type: "string", required: true, description: 'Concrete, checkable pass criteria, e.g. "cite at least 5 papers", "unit tests pass".' },
            budgetUsd: { type: "number", required: true, description: "Dollar budget for YOUR OWN research operation on this task (compute/tool-call cost) - not a price/spending figure that happens to be part of the research subject itself." }
          }
        }
      },
      totalBudgetUsd: { type: "number", required: true, description: "Total research operating budget (your own compute/tool-call cost) agreed with the user across all tasks - distinct from any price/spending figure that happens to be part of the research subject itself." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          approved: { type: "boolean", const: true, required: true }
        }
      },
      render: () => [{ type: "text", text: "Plan approved - you may now dispatch workers with dispatch_insight_worker." }]
    },
    execute: async (args, exec) => {
      const agent = exec.agent;
      if (agent === void 0) throw new Error("submit_insight_plan requires a calling agent (no session to review against)");
      if (args.taskPackages.length === 0) throw new Error("submit_insight_plan requires at least one task package");
      const interaction = ctx.get("userQuestions");
      if (interaction === void 0) {
        throw new Error("no user-questions channel is available to review the plan; ask the user to switch the session mode instead");
      }
      const answer = await interaction.ask({
        questions: [{
          id: REVIEW_ID,
          header: "Insight plan review",
          question: "Approve this insight plan and its budget?",
          detail: renderPlanMarkdown(args.taskPackages, args.totalBudgetUsd),
          options: [
            { label: APPROVE_LABEL, description: "Workers may now be dispatched for each task." },
            { label: REVISE_LABEL, description: "Feedback goes back to you; revise and resubmit." }
          ],
          intent: { kind: "plan-review", approve: APPROVE_LABEL }
        }],
        agent,
        signal: exec.signal
      }).catch((cause) => {
        if (cause instanceof UserQuestionError && cause.code === "ASK_CANCELLED") {
          throw new Error("The user dismissed the plan review to say something instead; stop here and wait for their message.");
        }
        throw cause;
      });
      const reviewItems = answer.answers.filter((entry) => entry.id === REVIEW_ID);
      const item = reviewItems.length === 1 ? reviewItems[0] : void 0;
      if (item?.selected.length !== 1 || item.selected[0] !== APPROVE_LABEL || item.custom !== void 0) {
        const feedback = item?.custom ?? "";
        throw new Error(feedback === "" ? "The user chose to revise; update the plan and submit it again." : `The user chose to revise; their feedback: ${feedback}`);
      }
      setApprovedPlan(agent.id, {
        tasksById: new Map(args.taskPackages.map((task) => [task.id, task])),
        totalBudgetUsd: args.totalBudgetUsd
      });
      return { approved: true };
    },
    presentCall: (args) => ({
      card: "generic",
      title: "Insight plan",
      kind: "other",
      content: [{ type: "text", text: renderPlanMarkdown(args.taskPackages, args.totalBudgetUsd) }]
    }),
    presentResult: (_args, result) => ({
      card: "generic",
      title: "Insight plan review",
      content: result.content
    })
  }));
}

// src/dispatch-worker.ts
import { delegationDepthOf } from "@deepseek-ai/dsh-subagent";
import { defineTool as defineTool2 } from "@deepseek-ai/dsh-tools";

// src/subagent-utils.ts
async function runSubagentAndDispose(run) {
  const [execution] = await Promise.allSettled([run.result]);
  const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())]);
  if (execution.status === "rejected") {
    if (disposal.status === "rejected") {
      throw new AggregateError(
        [execution.reason, disposal.reason],
        `subagent run failed: ${String(execution.reason)}; dispose failed: ${String(disposal.reason)}`
      );
    }
    throw execution.reason;
  }
  if (disposal.status === "rejected") throw disposal.reason;
  return execution.value;
}
async function runSubagentResilient(run) {
  try {
    return { result: await runSubagentAndDispose(run) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

// src/types.ts
var WORKER_RESULT_SCHEMA = {
  type: "object",
  properties: {
    output: {
      type: "string",
      description: "Your full result: findings, code, or whatever the task required."
    },
    metAcceptanceCriteria: {
      type: "boolean",
      description: "Whether your output actually satisfies the acceptance criteria you were given - check for real, do not assume."
    },
    selfAssessment: {
      type: "string",
      description: "Why the acceptance criteria are or are not met."
    },
    sourceLinks: {
      type: "array",
      items: { type: "string" },
      description: "Original links backing your findings, if any."
    }
  },
  required: ["output", "metAcceptanceCriteria", "selfAssessment", "sourceLinks"]
};

// src/dispatch-worker.ts
var SHELL_TOOL = process.platform === "win32" ? "pwsh" : "bash";
var WORKER_ALLOWED_TOOLS = [SHELL_TOOL, "read", "edit", "write", "read_image", "glob", "grep", "web_search", "skill", "todo_write"];
var WORKER_PERSONA = "You are an independent researcher/engineer with the depth and rigor of a PhD-level specialist. You work alone - there is no user to ask; make reasonable assumptions and note them in your output instead of asking. Check real state (run it, read it back) rather than trusting your own assumptions. Before returning, honestly assess whether your output actually meets the acceptance criteria you were given - do not claim success you have not verified.";
function buildWorkerPrompt(task, guidance) {
  const parts = [
    `Goal: ${task.goal}`,
    `Acceptance criteria (you must meet these before returning): ${task.acceptanceCriteria}`,
    `Your research operating budget for this task: $${task.budgetUsd.toFixed(2)} (your own compute/tool-call cost - NOT a price/spending limit related to the research subject itself, if one happens to be mentioned in the goal below). Stay within your own operating budget; work efficiently.`,
    task.researchSummary === "" ? void 0 : `Research so far:
${task.researchSummary}`,
    task.sourceLinks.length === 0 ? void 0 : `Sources:
${task.sourceLinks.join("\n")}`,
    task.masterThinkingSummary === "" ? void 0 : `Notes from whoever assigned this:
${task.masterThinkingSummary}`,
    guidance === void 0 ? void 0 : `Feedback from a previous attempt - address this:
${guidance}`
  ];
  return parts.filter((part) => part !== void 0).join("\n\n");
}
function resolveWorkerAgentOptions(ctx, config) {
  const workerModel = config.workerModel;
  if (workerModel === void 0) return void 0;
  const llm = ctx.get("llm");
  const configuredProviderAvailable = llm === void 0 || llm.listProviders().some((info) => info.id === workerModel.provider);
  if (configuredProviderAvailable) return { provider: workerModel.provider, model: workerModel.model };
  ctx.logger.warn(`insight-mode: workerModel provider "%s" has no registered adapter - falling back to the master's own model for this worker`, workerModel.provider);
  return void 0;
}
function installDispatchInsightWorker(ctx, config) {
  ctx.tools.register(defineTool2({
    name: "dispatch_insight_worker",
    description: "Dispatch an independent worker to carry out ONE approved task package. The worker cannot talk to the user and cannot dispatch further workers. Only task ids from an approved submit_insight_plan call can be dispatched. Call this multiple times in one step to run independent tasks in parallel. Pass `guidance` when re-dispatching a task that previously failed to meet its acceptance criteria.",
    parameters: {
      taskId: { type: "string", required: true, description: "The id of an approved task package." },
      guidance: { type: "string", description: "Specific feedback for a retry - what to fix from the previous attempt." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          output: { type: "string", required: true },
          metAcceptanceCriteria: { type: "boolean", required: true },
          selfAssessment: { type: "string", required: true },
          sourceLinks: { type: "array", required: true, items: { type: "string" } },
          budgetUsd: { type: "number", required: true },
          actualCostUsd: { type: "number" },
          stopReason: { type: "string", required: true }
        }
      },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }]
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
      const agent = exec.agent;
      if (agent === void 0) throw new Error("dispatch_insight_worker requires a calling agent");
      if (delegationDepthOf(agent) > 0) throw new Error("dispatch_insight_worker cannot be called from within a worker");
      const plan = approvedPlanFor(agent.id);
      const task = plan?.tasksById.get(args.taskId);
      if (task === void 0) {
        throw new Error(`no approved task "${args.taskId}" - call submit_insight_plan first, or check the task id`);
      }
      const retries = retriesFor(agent.id, args.taskId);
      if (retries >= config.maxWorkerRetries) {
        throw new Error(`task "${args.taskId}" has already been retried ${retries} time(s) (limit ${config.maxWorkerRetries}) - stop retrying and report this limitation to the user instead.`);
      }
      const workerAgentOptions = resolveWorkerAgentOptions(ctx, config);
      const activation = await ctx.subagents.startActivation({
        provider: "spawn",
        label: `insight_worker_${task.id}`,
        signal: exec.signal,
        // Caller delivery: the result comes back here, no parent completion notice.
        delivery: "caller",
        request: {
          prompt: [{ type: "text", text: buildWorkerPrompt(task, args.guidance) }],
          parent: agent,
          outputSchema: WORKER_RESULT_SCHEMA,
          toolFilter: { allow: WORKER_ALLOWED_TOOLS },
          persona: WORKER_PERSONA,
          // Fixed cheap route, independent of whatever model the master is
          // running on - see Config.workerModel's doc comment in index.ts.
          // Omitted (falls back to the master's own model) when that route
          // isn't available on this deployment - see resolveWorkerAgentOptions.
          ...workerAgentOptions === void 0 ? {} : { agentOptions: workerAgentOptions }
        }
      });
      const childSession = ctx.get("sessions")?.get(activation.childId);
      recordRetry(agent.id, args.taskId);
      const outcome = await runSubagentResilient(activation);
      if ("error" in outcome) {
        return {
          output: "",
          metAcceptanceCriteria: false,
          selfAssessment: `Worker failed to run: ${outcome.error}`,
          sourceLinks: [],
          budgetUsd: task.budgetUsd,
          stopReason: "error"
        };
      }
      const { result } = outcome;
      const costForSession = ctx.get("costForSession");
      const actualCostUsd = childSession === void 0 ? void 0 : costForSession?.(childSession);
      if (result.stopReason !== "completed" || result.structured === void 0) {
        return {
          output: "",
          metAcceptanceCriteria: false,
          selfAssessment: `Worker did not return a usable result (stopReason: ${result.stopReason}).`,
          sourceLinks: [],
          budgetUsd: task.budgetUsd,
          ...actualCostUsd === void 0 ? {} : { actualCostUsd },
          stopReason: result.stopReason
        };
      }
      const structured = result.structured;
      return {
        output: structured.output,
        metAcceptanceCriteria: structured.metAcceptanceCriteria,
        selfAssessment: structured.selfAssessment,
        sourceLinks: [...structured.sourceLinks],
        budgetUsd: task.budgetUsd,
        ...actualCostUsd === void 0 ? {} : { actualCostUsd },
        stopReason: result.stopReason
      };
    }
  }));
}

// src/persona.ts
var PERSONA_TEXT = `You are {{model}}, running Insight Mode: you are the MASTER agent for this session.

First, on every new message: judge whether it actually needs the full research workflow below, or is a simple, self-contained request unrelated to starting/continuing a research effort (a one-off question, a small direct edit, a status check). If it's simple, just answer it directly - do not call submit_insight_plan or dispatch_insight_worker for it.

When it does call for research: immediately call todo_write with a first-pass checklist for the whole effort (e.g. clarify request, comprehensive research, draft plan, get approval, dispatch workers, review results, final report) so the user sees progress from the very start, not only once workers are dispatched. Keep it updated throughout - call todo_write again whenever you complete a step, add a step you did not foresee, or the plan changes; this is expected to run many times over the course of one research effort, not once.

Talk with the user until their request is concrete enough to act on - ask clarifying questions rather than guessing. Concrete means more than the topic: pin down the exact fields, metrics, and dimensions the final deliverable must contain (e.g. for a business/product report, explicitly ask whether to include things like GMV, DAU/MAU, growth rate, or specific comparison axes - do not assume a generic shape). Vague acceptance criteria produce a plan the user cannot actually approve with confidence, so keep asking until you could write precise, checkable acceptance criteria without guessing any field. Once it's clear, do comprehensive research yourself (web_search, multiple queries from different angles) before drafting the breakdown - this step is what actually determines the research directions, technical approaches, and categories the plan will cover, so give it real time and depth rather than a shallow pass; a thin first look produces a thin breakdown.

Divide the confirmed request into independent task packages. Keep tightly-coupled, sequential work in ONE package - e.g. a project whose dev-environment setup, backend, and frontend all depend on each other is one task, not three. Split into separate packages only work that is genuinely independent - e.g. researching several companies' products is one package per company, run in parallel. Each package needs: a goal, a research summary with the original links behind it, your own thinking-so-far relevant to that task, and concrete, checkable acceptance criteria (e.g. "cite at least 5 papers", "unit tests pass").

submit_insight_plan's budgetUsd/totalBudgetUsd is YOUR OWN research operating budget - the compute/tool-call cost you and your workers are allowed to spend investigating each task - never confuse it with a price/spending figure that happens to be part of the research subject itself (e.g. researching "budget smartphones" or a company's own spending numbers is not the same "budget" as this one). Ask the user what they're comfortable with you spending on the research itself before you finalize per-task operating budgets. Then call submit_insight_plan with the full breakdown and total research operating budget - this blocks until the user approves it or asks you to revise. You cannot dispatch any worker before it is approved.

Keep your todo list truthful in real time, not after the fact: the instant the plan is approved, call todo_write to mark the draft/approval steps done and the dispatch step in progress - do this BEFORE calling dispatch_insight_worker, not afterward, so the list never lags behind what you've actually done. Once approved, dispatch a worker per task with dispatch_insight_worker - call it multiple times in the SAME step for every independent task so they actually run in parallel rather than one at a time; only call it once per step when tasks are genuinely sequential (a later task needs an earlier one's output). A worker cannot talk to the user or dispatch further workers; it self-assesses against its own acceptance criteria before returning. Review its output and self-assessment yourself - do not just trust a "met acceptance criteria: true". If it genuinely fell short, redispatch the SAME task with specific \`guidance\` on what to fix rather than redoing the whole breakdown; there is a limited number of retries per task, so stop and tell the user if you exhaust them.

Report progress to the user periodically as you go - between dispatch calls, not only at the very end - and give a final summary once every task has either succeeded or been reported as blocked. That final summary IS the deliverable, not a pointer to it: write the full report content directly into this closing chat message - the chat renders full markdown (headings, tables, lists, code blocks), so there is nothing extra the user needs to open. Never end by only naming a file or directory the report lives in and leaving it at that; if you also saved a copy to disk, mention the path in passing, but the actual content must already be in front of the user in the message itself.`;

// src/index.ts
var PERSONA_SECTION_NAME = dshSystemPrompt.PERSONA_PREFIX_SECTION ?? dshSystemPrompt.PERSONA_SECTION;
var name = "insight-mode";
var inject = ["tools", "subagents", "systemPrompt"];
var routeSchema = z.object({
  provider: z.string().required(),
  model: z.string().required()
});
var Config = z.object({
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
  workerModel: routeSchema.default(void 0)
});
function apply(ctx, config) {
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
    text: PERSONA_TEXT
  }), "insight-mode: persona.section()");
  installSubmitInsightPlan(ctx);
  installDispatchInsightWorker(ctx, config);
  ctx.logger.info("insight-mode: mounted with config: %o", config);
}
export {
  Config,
  apply,
  inject,
  name
};
