# Available Research Tools

Reference for Forager and Scout Bees on available MCP tools.

## Code Search

| Tool | Purpose | When to Use |
|------|---------|-------------|
| `grep_app_searchGitHub` | GitHub code search | Find real-world examples, patterns in OSS |
| `ast_grep_dump_syntax_tree` | AST inspection | Understand code shape or debug patterns |
| `ast_grep_test_match_code_rule` | Rule validation | Test YAML rules before searching the repo |
| `ast_grep_find_code` | Simple structural search | Find code structures with a single AST pattern |
| `ast_grep_find_code_by_rule` | Advanced structural search | Find relational or composite code patterns |

### grep_app Examples
```
grep_app_searchGitHub({ query: "useEffect cleanup", language: ["TypeScript"] })
grep_app_searchGitHub({ query: "(?s)try {.*await", useRegexp: true })
```

### ast_grep Examples
```
ast_grep_dump_syntax_tree({ code: "console.log(value)", language: "typescript", format: "pattern" })
ast_grep_test_match_code_rule({ code: "async function run() { await work(); }", yaml: "id: async-with-await\nlanguage: typescript\nrule:\n  kind: function_declaration\n  has:\n    pattern: await $EXPR\n    stopBy: end" })
ast_grep_find_code({ project_folder: "/repo", pattern: "console.log($MSG)", language: "typescript" })
ast_grep_find_code_by_rule({ project_folder: "/repo", yaml: "id: async-with-await\nlanguage: typescript\nrule:\n  kind: function_declaration\n  has:\n    pattern: await $EXPR\n    stopBy: end" })
```

## Documentation

| Tool | Purpose | When to Use |
|------|---------|-------------|
| `context7_resolve-library-id` | Find library ID | Before querying docs |
| `context7_query-docs` | Query library docs | API usage, best practices |

### context7 Flow
1. `context7_resolve-library-id({ query: "how to use X", libraryName: "react" })`
2. Get libraryId from result (e.g., `/facebook/react`)
3. `context7_query-docs({ libraryId: "/facebook/react", query: "useEffect cleanup" })`

## Web Search

| Tool | Purpose | When to Use |
|------|---------|-------------|
| `websearch_web_search_exa` | Exa AI search | Current info, recent developments |

### websearch Examples
```
websearch_web_search_exa({ query: "Next.js 15 new features 2026", numResults: 5 })
```

## Delegation

### Parallel Exploration (Preferred)

In task mode, use task() for research fan-out.

For exploratory research, load the native `parallel-exploration` skill for the full playbook.
When custom Scout-derived subagents are configured, choose one only when its description is a better match than the built-in `scout-researcher`.

Quick pattern:
```
task({
  subagent_name: "<chosen-researcher>",
  prompt: "Find all API routes in src/ and summarize patterns",
  description: "Explore API patterns"
})
```

### Background-First Scheduling

Subagents must not start background tasks. With `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` or `OPENCODE_EXPERIMENTAL` unset, Hive keeps the direct/blocking workflow and background board tools are disabled. When either env flag is set, `task({ background: true, ... })`, the bundled `background-delegation` protocol, and the board tools are primary-agent-only guidance.

Gate-open primary orchestrators treat exploratory/read-only and review lanes as lightweight background candidates. Writing/change and execution lanes are managed lanes: define path ownership, state tracking, verification routing, unresolved-lane checks, and integration control. Every delegated lane needs a context packet with objective, known facts, references, constraints, prior failures, expected output, and where to find missing context. For ad-hoc or non-feature work, include this packet in the prompt because there may be no plan/task context file.

Choose specialists from built-in and custom agent descriptors instead of fixed routing tables. Hive Builder remains a direct ad-hoc executor with the gate closed; with the gate open, non-trivial non-feature work should be decomposed, routed, tracked, verified, and integrated like orchestration. For inspection, routing, or setup-only ad-hoc worktrees, call `hive_adhoc_worktree_create` with `autoSpawnWorker: false` so no worker is auto-launched.

Primary-agent-only board tools:

| Tool | Use |
|------|-----|
| `hive_background_status` | Inspect the scoped board before deciding what is still running, terminal, stale, unreconciled, or wait-only |
| `hive_background_reconcile` | Mark a terminal native background job reconciled or ignored after inspecting the result; the tool archives it from normal status |
| `hive_background_reconcile_batch` | Mark multiple terminal native background jobs reconciled or ignored after inspecting their results; the tool archives them from normal status |
| `hive_background_cancel` | Request cancellation for a visible job when it is stale, wrong, or no longer needed |

Prompt acknowledgment only means Hive showed the terminal result once; it is not reconciliation. Cancellation is not rollback. Cancelling a background job does not revert files, branches, worktrees, commits, or task reports. Wait for OpenCode's native completion notification before dependent decisions; use `hive_background_status` to refresh the board and keep scheduler state explicit. When `schedulerGuidance.reason` is `wait_for_native_completion_notification`, do not refresh repeatedly; wait for native completion or continue unrelated foreground work. Do not edit `.hive/background-jobs.json` directly.

---

## Tool Selection Guide

| Need | Best Tool |
|------|-----------|
| Find code in THIS repo | `grep`, `glob`, `ast_grep_find_code`, `ast_grep_find_code_by_rule` |
| Find code in OTHER repos | `grep_app_searchGitHub` |
| Understand a library | `context7_query-docs` |
| Current events/info | `websearch_web_search_exa` |
| Inspect AST structure | `ast_grep_dump_syntax_tree` |
| Validate a YAML rule | `ast_grep_test_match_code_rule` |
| Multi-domain exploration | `parallel-exploration` skill + `task()` |
