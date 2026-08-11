# Operator Guide

This guide covers day-to-day work after installation. Use the [root README](../README.md) for first setup.

## Mental model

Agent Hive separates decisions from execution:

- **You** set direction, review the plan, answer blockers, and approve risk.
- The **primary agent** turns the request into a plan and orchestrates the work.
- **Researchers and reviewers** inspect code, plans, or frozen review workspaces.
- **Workers** implement approved tasks in isolated git worktrees.
- **`.hive/`** stores durable plans, task state, reports, comments, and recovery metadata.

A plan does not authorize implementation until you approve it.

## Choose a workflow

Use a **feature** when the work needs a reviewed plan, multiple tasks, dependencies, isolated task worktrees, or a durable execution record.

Use an **ad-hoc run** for bounded work that is not a feature and should not create feature or task records. It still uses isolation and orchestration, but does not need the feature planning lifecycle.

## Feature lifecycle

### 1. Discuss and plan

Describe the outcome, constraints, and important context in plain language. The primary agent researches where needed and writes the feature plan.

### 2. Review

Read the plan in chat or in VS Code. Add comments when a requirement, dependency, or risk needs correction. Ask the primary agent to revise it until the scope is clear.

### 3. Approve and sync

Approve the reviewed plan. Hive then creates the executable task records.

### 4. Execute

The primary agent starts runnable tasks. Each worker receives a task-specific prompt and performs task-level, best-effort checks in its own isolated git worktree. Workers report completion, failure, or blockers through the task boundary.

A worker commit records the task branch. It does not merge that branch.

### 5. Inspect worker output

The operator/orchestrator inspects completed worker output. Worker claims and task-level checks are handoff evidence, not a substitute for verification.

### 6. Merge, verify, and complete

Merge completed task branches after inspecting their output. Then run fresh build/test verification against the merged result. Mark the feature complete only after that merged-result verification passes.

## When work blocks or fails

After a worker fails or reports partial progress, start again through the normal task-start path, [`hive_worktree_start`](../packages/opencode-hive/docs/HIVE-TOOLS.md#worktree-4-tools). This normal path covers retries; it is not restricted to pending or in-progress tasks.

When a worker is blocked, inspect the blocker and make the operator decision. The blocked path, [`hive_worktree_create`](../packages/opencode-hive/docs/HIVE-TOOLS.md#worktree-4-tools), launches a fresh worker in the existing worktree.

## Review options

- **Plan comments**: review requirements, dependencies, and scope in the plan document or chat.
- **`/dash-review`**: review one frozen disposable implementation workspace without changing source.
- **`/vuln-review`**: run an authorized bounded static review. It does not exploit systems, edit source, or create automatic fixes, and it does not prove exhaustive security coverage.
- **`/council`**: request read-only advice about a design or tradeoff. It does not approve, execute, or merge work.

Use the [package README](../packages/opencode-hive/README.md) for exact APIs and contracts.

## Background and trace notes

Background execution is optional and experimental. When enabled, wait for the native completion notification, then inspect and reconcile terminal jobs. Background controls do not roll back files, branches, worktrees, commits, or reports.

Trace output helps inspect delegated work. It is untrusted and does not authorize acceptance, merge, retry, or resume.

## Multi-repo projects

Single-repo projects use the normal git-root path. Hive manages multi-repo topology and uses a composite workspace with one checkout per selected repository.
