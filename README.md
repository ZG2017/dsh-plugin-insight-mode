# DSH | dsh-plugin-insight-mode | Master/worker deep research with a human approval gate before any work starts

A single agent doing deep research has to context-switch between scoping, researching, and writing - all in one thread, with no checkpoint to catch a bad plan before it burns budget. Insight Mode splits that into a **master** that clarifies your request and proposes a task breakdown + budget for your approval, and independent **worker** subagents, dispatched only after you approve, that run in parallel and can't talk to you or spawn further workers.

![Insight Mode in the preset picker after install](./screenshots/00-preset-picker.png)

## How it works

A real run - asking for a full history of LLM development:

**1. Receive the task** - does this need the full workflow, or a direct answer?

![The master recognizes a substantial research request](./screenshots/01-triage.png)

**2. List a todo checklist** up front, so progress is visible from the very start, not only once workers are dispatched:

![Todo checklist visible from the start](./screenshots/07-todo-list.png)

**3. Clarify** - concrete questions, one at a time, each with a recommended default; can take several turns until the request is precise enough to act on:

![Which companies/groups should the history cover](./screenshots/02-clarify-coverage.png)

**4. Comprehensive research** - the master does its own multi-angle `web_search` passes to work out the real research directions, technical approaches, and categories before drafting anything.

**5. Draft a plan and submit for approval** via `submit_insight_plan` - **this blocks on your approval**; Refuse sends feedback back for revision, so this can take a few rounds too:

![Plan review card with the task breakdown and operating budget](./screenshots/08-plan-approval.png)

**6. Dispatch workers in parallel** via `dispatch_insight_worker` - multiple calls in one step, so independent tasks genuinely run at once:

![Three insight_worker subagents running concurrently](./screenshots/09-parallel-workers.png)

**7. Workers report back, master finalizes** - each worker self-assesses and returns; the master reviews every output itself (not just trusting "criteria met: true"), can redispatch a task with corrective guidance, and once everything's in, writes the full report directly into its closing message - never just a pointer to a file:

![The finished report rendered directly in the chat](./screenshots/10-report-part1.png)

## How it integrates with DSH

A pure host-side plugin - no client code. It registers its own identity directly as DSH's `deployment:persona` prompt section (`ctx.systemPrompt.section()` - the same mechanism `@deepseek-ai/dsh-persona` itself uses), so installing this plugin is enough on its own; no separate persona to hand-assemble. It also mounts `submit_insight_plan` (the approval gate, same `ctx.userQuestions.ask()` primitive as `exit_plan_mode`) and `dispatch_insight_worker` (spawns an isolated `spawn` subagent per task via `ctx.subagents`). Workers can run on a separate model from the master, so master cost doesn't multiply across every dispatch - see Install.

## How this differs

A few research-oriented DSH plugins already exist - citation-integrity engines, an academic-paper workbench, a read-only code-project diagnostic preset. None combine a **domain-agnostic topic**, **true parallel multi-worker dispatch**, and a **human approval gate on the plan and budget before any work starts**. That combination is the actual point of difference, not a claim of deeper research than a domain-specialized tool.

## Install

Requires DeepSeek Harness **0.2.1-alpha.2 or newer** (see [DSH 0.2 update](#dsh-02-update)).

**From the app:** Plugins → install `github:ZG2017/dsh-plugin-insight-mode`. Installing from the Plugins page also turns the bundle on.

**From the CLI:**

```sh
dsh plugin --profile web add github:ZG2017/dsh-plugin-insight-mode
```

`dsh plugin add` only runs `pnpm add`. Also add `"@gz2016/dsh-plugin-insight-mode"` to `dsh.profile.bundles` in `~/.dsh/profiles/web/package.json`, then restart. DSH 0.2 loads a profile package only when it is selected as a bundle; it then applies this package's `cordis.patch.yml`.

## Known limitations

- The domain gate ("does this need the full workflow") is a persona instruction, not a code-enforced check - it can be misjudged.
- The operating budget is advisory: it rides in the worker's prompt as an instruction, and nothing aborts a worker mid-flight for exceeding it. Actual-spend reporting needs a separate cost-tracking plugin providing a `costForSession` service.
- Approved-plan and retry-count state is in-memory per process, not durable across a restart.


## DSH 0.2 update

DeepSeek Harness 0.2 (0.2.1-alpha.2) changed several plugin APIs this package used, so the 0.1 release does not load on it: DSH disables it at startup because its peer versions are pinned to 0.1.1-rc.2. This release targets 0.2.1-alpha.2.

What changed:

- Workers start through `ctx.subagents.startActivation({ ..., delivery: 'caller' })`. DSH 0.2 removed `ctx.subagents.start()` along with foreground/background subagent runs.
- A worker's actual cost is read from its child Session, captured right after the activation starts (`run.localAgent` no longer exists).
- The persona no longer uses `{{cwd}}`. DSH 0.2 removed that prompt variable (the working-directory service supplies it as context), and an unresolved variable fails the turn.
- The preset is now a `@deepseek-ai/dsh-agent-preset` declaration in `cordis.patch.yml`. DSH 0.2 no longer reads `$DSH_HOME/.agent-presets/<id>/` directories, so the old `preset/` folder and the copy step are gone. The plugin list is DSH 0.2's Standard preset minus its `persona` row, plus this plugin.
- `peerDependencies` now name the 0.2.1-alpha.2 packages.

---
*Unofficial project, independently developed and maintained by a community member. Not affiliated with or endorsed by DeepSeek.*
