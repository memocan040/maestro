# Task assistants (clean Maestro fork)

This branch starts from the original Maestro 0.35.1 UX. There is no separate
feature orchestrator, second Kanban, new project planner, or extra review gate.

## Setup and behavior

In Project Settings > Agents, open Implementation > Optional assistants and
select one or two ACP providers, such as Codex and Claude. The selection is
stored in .maestro/assistants.json. It does not launch any agent by itself.

When a normal Implementation task is running, its main agent (e.g. Cursor)
receives the approved provider IDs and can invoke the Maestro MCP tool
delegate_assistant with an agent_id and a bounded prompt. Maestro runs that
provider as an actual ACP agent with a separate Git worktree. It may edit code,
run tests, and commit on its own branch. The main agent calls wait_assistant
with the returned run_id to obtain its final response, branch and worktree.

The parent agent must review the returned changes and explicitly integrate
them into its own task worktree. Nothing is automatically merged into main.
Users can continue chatting with the normal main-agent session; the existing
Subagents panel recognizes tool calls with a prompt field.

Helpers cannot recursively delegate, no helpers start automatically, and
at most two helper executions can be active for the same parent task.

Writable delegations are **currently Implementation-only** to preserve
the original read-only gates for Refinement, Planning and Review. This is a
deliberate first-stage restriction, not full support for assistants in every
pipeline stage. Provider permissions/authentication still apply.

## Code

- StageAssistants.tsx: collapsed provider selector within the original setup.
- task_prompt.rs: targeted instructions only if a provider is selected.
- automation_tools.rs: task-scoped ACP execution via existing automation runner.
- host_tools.rs and mcp-tools.json: delegate_assistant / wait_assistant MCP tools.

This reuses Maestro automation runner, task worktree logic, sessions, and
provider authentication; it introduces no second scheduling engine. Runs are
persisted in the existing automation database, not new Kanban child tasks.
They currently appear as one-shot assistant automation records.

## Unverified and remaining tasks

These source changes were made on GitHub with no Rust toolchain or authenticated
ACP providers available to execute a real Windows acceptance test. This branch
is NOT a validated installed release.

Before merging to main, run Cargo check/test, the frontend build, Vitest, lint,
format checks, and a real Cursor -> Codex + Claude parallel coding test in a
temporary Git project. Confirm the assistants commit actual code and that the
parent can integrate both commits in its own worktree. Test helper failures,
timeouts, permission prompts and restarts. Review the assistant automation
record UX, worktree retention and security. Restore fork-specific app
identifier/data separation if a parallel installed version is needed.

The complex previous version remains backed up at
backup/pre-assistants-2026-10-10. No existing databases are downgraded.
