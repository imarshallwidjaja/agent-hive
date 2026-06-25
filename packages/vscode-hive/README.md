# vscode-arkive

[![License: MIT with Commons Clause](https://img.shields.io/badge/License-MIT%20with%20Commons%20Clause-blue.svg)](../../LICENSE)

VS Code companion for reviewing and commenting on Hive `.hive/` output: sidebar, `plan.md` and `overview.md` review, and inline comments.

## Why Hive?

OpenCode runs the work. This extension keeps the plan, comments, overviews, and feature status close to your editor.

## Installation

### From VSIX

Download from [Releases](https://github.com/tctinh/agent-hive/releases) and install manually.

## Features

### Feature Sidebar
Feature tree with status indicators and grouping. Archived features appear in a collapsed **Archived** group. Right-clicking a planning/approved/executing feature shows **Archive Feature**, which hides it from normal agent status without deleting worktrees, branches, tasks, or commits.

### Inline Review
Add comments on plan.md and overview.md.

### File Watching
Watches `.hive/` for changes and refreshes automatically.

### Background Jobs
Viewer + limited operator archive tree for `.hive/background-jobs.json`. It shows scoped background job state written by `oc-arkive`, including runtime state and coordination metadata. Right-clicking a non-archived job (Running, Stale, etc.) shows **Archive Background Job**, which moves it to the collapsed Ignored group without cancelling or killing any running process.

### Tracked Repositories
Viewer-only tree for `.hive/agent-hive.json` repository manifests. It shows the project-relative repositories that `oc-arkive` uses for manifest-backed workspaces.

## Usage

### Review a Hive feature

1. Create or open a repository that already has `.hive/` output from `oc-arkive`
2. Click the Hive icon in the Activity Bar
3. Open `plan.md` or `overview.md` from the sidebar and review
4. Add comments directly on the document, then click **Done Review** when ready

### What this extension does

- **Document review**: inspect `plan.md` and `overview.md` as the required review documents
- **Sidebar visibility**: features, tasks, status, and reports in one place
- **Background visibility**: Background Jobs and Tracked Repositories views read Hive state without agentic control
- **Operator archive**: Archive stale features and background jobs from the right-click context menu
- **Inline comments**: discuss changes directly in `plan.md` and `overview.md`
- **File watching**: tracks `.hive/` changes and refreshes in real time

## Commands

| Command | Description |
|---------|-------------|
| Hive: Refresh | Refresh the feature tree |
| Hive: Open File | Open a file from the sidebar |
| Hive: Copy to Clipboard | Copy a background job ID or repository ID from the sidebar |
| Hive: Done Review | Complete review of plan.md or overview.md |
| Hive: Add Comment | Add an inline comment on plan.md or overview.md |
| Hive: Reply Comment | Reply to an existing comment |
| Hive: Resolve Comment | Mark a comment as resolved |
| Hive: Delete Comment | Delete a comment |
| Hive: Archive Feature | Archive a feature (planning/approved/executing only) — hides from active tools, preserves files |
| Hive: Archive Background Job | Archive a background job — moves to Ignored group, does not kill running process |

### Tips

- **Context management**: Check `.hive/features/<name>/context/` for optional notes; files like `overview.md`, `decisions.md`, or `architecture.md` are ordinary context files, not separate review gates.
- **Plan and overview review**: `plan.md` and `overview.md` are the review documents available in the sidebar. Both support inline comments.

## Pair with OpenCode

For the supported workflow, install [oc-arkive](https://www.npmjs.com/package/oc-arkive) and use this extension as the review/sidebar companion.

## Scope: viewer + limited operator archive

This extension is **viewer-first** with limited operator archive actions. It reads `.hive/` artifacts (features, plans, tasks, contexts, comments, background jobs, and repository manifests) and surfaces them in the sidebar and review flow. Safe viewing actions are limited to Refresh, Open File, Copy to Clipboard, Done Review, and inline comment actions.

Two additional **operator archive** actions allow cleaning up stale state without agentic escape:
- **Archive Feature** — marks a feature with `archived` status, hiding it from normal agent tooling and active feature selection. Preserves all `.hive/` files for audit or manual recovery. Does not delete worktrees, branches, tasks, or commits.
- **Archive Background Job** — moves a background job to the collapsed Ignored group using existing ignored/archive fields. Does not mutate runtime state and does not cancel or kill any running process.

It does not start worktrees, commit changes, merge branches, cancel jobs, reconcile jobs, or ignore jobs, and it contributes no `languageModelTools`. Use `oc-arkive` in OpenCode for those operations. Multi-repo orchestration (composite workspaces, per-repo base commits, aggregate diff/commit/merge) is owned by `hive-core` and exposed through `oc-arkive`; any per-repo metadata the sidebar shows is read-through from those files. Reintroducing agentic command surfaces beyond archive would change the security and review posture of this extension and is out of scope.

## Requirements

- VS Code 1.64.0 or higher
- A project with `.hive/` folder (created by `oc-arkive`)

## License

MIT with Commons Clause — Free for personal and non-commercial use. See [LICENSE](../../LICENSE) for details.
