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

Subagents must not start background tasks. When opencode background subagents are enabled (`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` or `OPENCODE_EXPERIMENTAL`), `task({ background: true, ... })`, native `task_status`, and the bundled `background-delegation` protocol are primary-agent-only guidance.

Primary-agent-only board tools:

| Tool | Use |
|------|-----|
| `hive_background_status` | Inspect the scoped board before deciding what is still running, terminal, stale, or unreconciled |
| `hive_background_reconcile` | Mark a terminal native background job reconciled or ignored after inspecting the result |
| `hive_background_cancel` | Request cancellation for a visible job when it is stale, wrong, or no longer needed |

Cancellation is not rollback. Cancelling a background job does not revert files, branches, worktrees, commits, or task reports. Use native `task_status` before dependent decisions; use the board tools to keep scheduler state explicit.

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
