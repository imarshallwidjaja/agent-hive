import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import * as path from 'path';
import { QUEEN_BEE_PROMPT } from './hive';
import { ARCHITECT_BEE_PROMPT } from './architect';
import { SWARM_BEE_PROMPT } from './swarm';
import { FORAGER_BEE_PROMPT } from './forager';
import { SCOUT_BEE_PROMPT } from './scout';
import { HIVE_HELPER_PROMPT } from './hive-helper';
import { HIVE_BUILDER_PROMPT } from './hive-builder';
import { PLAN_REVIEWER_PROMPT } from './plan-reviewer';
import { CODE_REVIEWER_PROMPT } from './code-reviewer';
import { SIMPLICITY_REVIEWER_PROMPT } from './simplicity-reviewer';
import { APPROACH_ADVISOR_PROMPT } from './approach-advisor';
import { buildWorkerPrompt } from '../utils/worker-prompt';

describe('Orchestrator synthesis-before-delegation', () => {
  it('Hive prompt contains synthesis-before-delegating reminder', () => {
    expect(QUEEN_BEE_PROMPT).toContain('Synthesize Before Delegating');
    expect(QUEEN_BEE_PROMPT).toContain('Workers do not inherit your context');
  });

  it('Hive delegation check includes synthesis proof step', () => {
    expect(QUEEN_BEE_PROMPT).toContain('restate the task in concrete terms');
    expect(QUEEN_BEE_PROMPT).toContain('files, line ranges, expected outcome');
  });

  it('Swarm prompt has a dedicated synthesis section with rules', () => {
    expect(SWARM_BEE_PROMPT).toContain('## Synthesize Before Delegating');
    expect(SWARM_BEE_PROMPT).toContain('Workers do not inherit your context');
  });

  it('Swarm synthesis section forbids vague delegation phrases', () => {
    expect(SWARM_BEE_PROMPT).toContain('based on your findings');
    expect(SWARM_BEE_PROMPT).toContain('based on the research');
  });

  it('Swarm synthesis section includes good/bad delegation example', () => {
    expect(SWARM_BEE_PROMPT).toContain('<Bad>');
    expect(SWARM_BEE_PROMPT).toContain('<Good>');
  });

  it('Swarm synthesis section requires concrete hand-off anchors', () => {
    expect(SWARM_BEE_PROMPT).toContain('file paths and line ranges when known');
    expect(SWARM_BEE_PROMPT).toContain('expected result');
    expect(SWARM_BEE_PROMPT).toContain('what done looks like');
  });
});

describe('Primary agent subagent concurrency guidance', () => {
  const primaryPrompts = [
    ['Hive', QUEEN_BEE_PROMPT],
    ['Architect', ARCHITECT_BEE_PROMPT],
    ['Swarm', SWARM_BEE_PROMPT],
    ['Hive Builder', HIVE_BUILDER_PROMPT],
  ] as const;

  it('does not keep stale synchronous-exploration wording in primary prompts', () => {
    for (const [name, prompt] of primaryPrompts) {
      expect(prompt, name).not.toContain('default to synchronous exploration');
      expect(prompt, name).not.toContain('synchronous exploration');
    }
  });
});

describe('Scout operating contract', () => {
  it('enforces a read-only contract', () => {
    expect(SCOUT_BEE_PROMPT).toContain('### Read-Only Contract');
    expect(SCOUT_BEE_PROMPT).toContain('Scout must never modify project state');
  });

  it('prohibits file writes, temp files, and state-changing commands', () => {
    expect(SCOUT_BEE_PROMPT).toContain('No file edits, creation, or deletion');
    expect(SCOUT_BEE_PROMPT).toContain('No temporary files');
    expect(SCOUT_BEE_PROMPT).toContain('No state-changing shell commands');
  });

  it('defines a preferred search sequence', () => {
    expect(SCOUT_BEE_PROMPT).toContain('### Preferred Search Sequence');
    expect(SCOUT_BEE_PROMPT).toContain('Local discovery first');
    expect(SCOUT_BEE_PROMPT).toContain('Structured lookups next');
    expect(SCOUT_BEE_PROMPT).toContain('External sources when local is insufficient');
    expect(SCOUT_BEE_PROMPT).toContain('Shell as narrow fallback');
  });

  it('includes speed and efficiency rules', () => {
    expect(SCOUT_BEE_PROMPT).toContain('### Speed and Efficiency');
    expect(SCOUT_BEE_PROMPT).toContain('independent sub-parts');
    expect(SCOUT_BEE_PROMPT).toContain('answer immediately');
  });

  it('includes synthesis rules prohibiting speculation about unread files', () => {
    expect(SCOUT_BEE_PROMPT).toContain('## Synthesis Rules');
    expect(SCOUT_BEE_PROMPT).toContain('do not speculate about its contents');
    expect(SCOUT_BEE_PROMPT).toContain('cited synthesis');
  });
});

describe('Forager verification and tool-scope clarity', () => {
  it('defers tool scope to worker prompt', () => {
    expect(FORAGER_BEE_PROMPT).toContain('tool access is scoped to your role');
    expect(FORAGER_BEE_PROMPT).toContain('worker prompt');
  });

  it('records observed output in verification step', () => {
    expect(FORAGER_BEE_PROMPT).toContain('Record observed output');
    expect(FORAGER_BEE_PROMPT).toContain('do not substitute explanation for execution');
  });

  it('references the upstream ast-grep MCP tools without legacy names', () => {
    expect(FORAGER_BEE_PROMPT).toContain('ast_grep_dump_syntax_tree');
    expect(FORAGER_BEE_PROMPT).toContain('ast_grep_test_match_code_rule');
    expect(FORAGER_BEE_PROMPT).toContain('ast_grep_find_code');
    expect(FORAGER_BEE_PROMPT).toContain('ast_grep_find_code_by_rule');
    expect(FORAGER_BEE_PROMPT).not.toContain('ast_grep_search');
    expect(FORAGER_BEE_PROMPT).not.toContain('ast_grep_replace');
    expect(FORAGER_BEE_PROMPT).not.toContain('ast_grep_scan-code');
  });
});

describe('Scout ast-grep references', () => {
  it('names the upstream ast-grep MCP tools in guidance', () => {
    expect(SCOUT_BEE_PROMPT).toContain('ast_grep_dump_syntax_tree');
    expect(SCOUT_BEE_PROMPT).toContain('ast_grep_test_match_code_rule');
    expect(SCOUT_BEE_PROMPT).toContain('ast_grep_find_code');
    expect(SCOUT_BEE_PROMPT).toContain('ast_grep_find_code_by_rule');
    expect(SCOUT_BEE_PROMPT).not.toContain('ast_grep_search');
    expect(SCOUT_BEE_PROMPT).not.toContain('ast_grep_replace');
    expect(SCOUT_BEE_PROMPT).not.toContain('ast_grep_scan-code');
  });
});

describe('Specialized reviewer prompts', () => {
  it('keeps plan-reviewer focused on executable plans, not approach review', () => {
    expect(PLAN_REVIEWER_PROMPT).toContain('Can a capable Hive worker execute this plan without getting stuck?');
    expect(PLAN_REVIEWER_PROMPT).toContain('Do not judge whether the architecture or approach is optimal');
    expect(PLAN_REVIEWER_PROMPT).toContain('OKAY');
    expect(PLAN_REVIEWER_PROMPT).toContain('REJECT');
  });

  it('keeps code-reviewer focused on implementation diffs and verification boundaries', () => {
    expect(CODE_REVIEWER_PROMPT).toContain('Reviews implementation changes against a task or plan');
    expect(CODE_REVIEWER_PROMPT).toContain('REQUEST_CHANGES');
    expect(CODE_REVIEWER_PROMPT).toContain('canonical `verification` skill');
  });

  it('keeps simplicity-reviewer focused on diff-scoped deletion-biased cleanup', () => {
    expect(SIMPLICITY_REVIEWER_PROMPT).toContain('final post-implementation simplicity reviewer');
    expect(SIMPLICITY_REVIEWER_PROMPT).toContain('diff first');
    expect(SIMPLICITY_REVIEWER_PROMPT).toContain('SIMPLIFY');
    expect(SIMPLICITY_REVIEWER_PROMPT).toContain('ALREADY_MINIMAL');
    expect(SIMPLICITY_REVIEWER_PROMPT).toContain('Do not perform plan readiness review');
    expect(SIMPLICITY_REVIEWER_PROMPT).toContain('Do not claim builds, tests, or behavior pass');
  });

  it('keeps approach-advisor advisory rather than a gate', () => {
    expect(APPROACH_ADVISOR_PROMPT).toContain('Is this the right path, given the constraints?');
    expect(APPROACH_ADVISOR_PROMPT).toContain('Do not return `OKAY` or `REJECT`');
    expect(APPROACH_ADVISOR_PROMPT).toContain('Effort');
    expect(APPROACH_ADVISOR_PROMPT).toContain('Confidence');
  });
});

describe('Hive (Hybrid) prompt', () => {
  describe('delegation planning alignment', () => {
    it('contains the Canonical Delegation Threshold block', () => {
      expect(QUEEN_BEE_PROMPT).toContain('### Canonical Delegation Threshold');
      expect(QUEEN_BEE_PROMPT).toContain('cannot name the file path upfront');
      expect(QUEEN_BEE_PROMPT).toContain('expect to inspect 2+ files');
      expect(QUEEN_BEE_PROMPT).toContain('open-ended');
      expect(QUEEN_BEE_PROMPT).toContain('Local `read/grep/glob`');
    });

    it('contains read-only exploration is allowed', () => {
      expect(QUEEN_BEE_PROMPT).toContain('Read-only exploration is allowed');
    });

    it('does NOT contain the old planning iron law "Don\'t execute - plan only"', () => {
      expect(QUEEN_BEE_PROMPT).not.toContain("- Don't execute - plan only");
    });

    it('explains background-first scheduler mode when the env-gated appendix is present', () => {
      expect(QUEEN_BEE_PROMPT).toContain('background-first scheduler mode');
      expect(QUEEN_BEE_PROMPT).toContain('look for independent background lanes');
      expect(QUEEN_BEE_PROMPT).toContain('foreground/blocking escape');
      expect(QUEEN_BEE_PROMPT).toContain('exploratory/read-only and review lanes may be background-launched freely');
      expect(QUEEN_BEE_PROMPT).toContain('writing/change and execution lanes need file ownership');
      expect(QUEEN_BEE_PROMPT).toContain('normal initial fan-out of 2-4 lanes');
    });

    it('separates subagent concurrency from foreground wait mode', () => {
      expect(QUEEN_BEE_PROMPT).toContain('Dependency decides serial vs parallel');
      expect(QUEEN_BEE_PROMPT).toContain('Wait mode decides blocking foreground vs background');
      expect(QUEEN_BEE_PROMPT).toContain('Blocking does not mean serial');
      expect(QUEEN_BEE_PROMPT).toContain('If several subagent tasks are independent, emit all of their `task()` calls in the same assistant message');
    });

    it('includes internal codebase exploration in Research intent', () => {
      expect(QUEEN_BEE_PROMPT).toContain('Internal codebase exploration');
    });

    it('includes task() guidance for research', () => {
      expect(QUEEN_BEE_PROMPT).toContain('task(');
      expect(QUEEN_BEE_PROMPT).toContain('scout-researcher');
    });

    it('documents scout researcher routing by closest task fit', () => {
      expect(QUEEN_BEE_PROMPT).toContain('the scout researcher whose description best fits the research slice');
      expect(QUEEN_BEE_PROMPT).toContain('Use built-in `scout-researcher` when no configured scout-derived custom description is a closer domain/workflow match');
      expect(QUEEN_BEE_PROMPT).toContain('task({ subagent_type: "<chosen-researcher>"');
      expect(QUEEN_BEE_PROMPT).toContain('objective, known facts, references, prior failures, constraints, expected output');
    });

    it('requires hive_status() before any resume attempt', () => {
      expect(QUEEN_BEE_PROMPT).toContain('After `task()` returns, immediately call `hive_status()`');
      expect(QUEEN_BEE_PROMPT).toContain('before any resume attempt');
    });

    it('allows blocked resume only for exactly blocked tasks', () => {
      expect(QUEEN_BEE_PROMPT).toContain('Use `continueFrom: "blocked"` only when status is exactly `blocked`');
      expect(QUEEN_BEE_PROMPT).not.toContain('Use `continueFrom: "blocked"` when status is unresolved');
    });

    it('forbids blocked resume loops on non-blocked statuses', () => {
      expect(QUEEN_BEE_PROMPT).toContain('Never loop `continueFrom: "blocked"` on non-blocked statuses');
    });

    it('requires immediate status re-check before blocked resume', () => {
      expect(QUEEN_BEE_PROMPT).toContain('Before every blocked resume, call `hive_status()` immediately beforehand');
      expect(QUEEN_BEE_PROMPT).toContain('verify the task is still exactly `blocked`');
    });

    it('treats terminal tool responses as non-retriable for same parameters', () => {
      expect(QUEEN_BEE_PROMPT).toContain('If any Hive tool response has `terminal: true`');
      expect(QUEEN_BEE_PROMPT).toContain('do not retry the same parameters');
      expect(QUEEN_BEE_PROMPT).toContain('finality applies to the tool call parameters');
      expect(QUEEN_BEE_PROMPT).toContain('tool call parameters');
      expect(QUEEN_BEE_PROMPT).toContain('final natural-language handoff response');
    });

    it('redirects non-blocked unresolved tasks to normal dispatch', () => {
      expect(QUEEN_BEE_PROMPT).toContain('If status is not `blocked`');
      expect(QUEEN_BEE_PROMPT).toContain('do not use `continueFrom: "blocked"`');
      expect(QUEEN_BEE_PROMPT).toContain('only for normal starts (`pending` / `in_progress`)');
      expect(QUEEN_BEE_PROMPT).toContain('hive_worktree_start({ feature, task })');
    });

    it('documents plan-reviewer routing by closest task fit', () => {
      expect(QUEEN_BEE_PROMPT).toContain('the plan reviewer whose description best fits the plan review lens');
      expect(QUEEN_BEE_PROMPT).toContain('Use built-in `plan-reviewer` when no configured plan-reviewer-derived custom description is a closer match');
      expect(QUEEN_BEE_PROMPT).toContain('task({ subagent_type: "<chosen-reviewer>"');
    });

    it('documents approach-advisor routing by closest strategic fit', () => {
      expect(QUEEN_BEE_PROMPT).toContain('the approach advisor whose description best fits the strategic question');
      expect(QUEEN_BEE_PROMPT).toContain('Use built-in `approach-advisor` when no configured approach-advisor-derived custom description matches the domain or risk lens');
      expect(QUEEN_BEE_PROMPT).toContain('task({ subagent_type: "<chosen-advisor>"');
    });

    it('documents simplicity-reviewer routing by closest cleanup fit', () => {
      expect(QUEEN_BEE_PROMPT).toContain('simplicity reviewer whose description best fits the cleanup lens');
      expect(QUEEN_BEE_PROMPT).toContain('Use built-in `simplicity-reviewer` when no configured simplicity-reviewer-derived custom description is a closer match');
      expect(QUEEN_BEE_PROMPT).toContain('task({ subagent_type: "<chosen-reviewer>"');
      expect(QUEEN_BEE_PROMPT).toContain('post-implementation cleanup pass');
    });

    it('tells hybrid planners to split broad research earlier', () => {
      expect(QUEEN_BEE_PROMPT).toContain('split broad research earlier');
    });

    it('delegates batch merges to hive-helper and keeps post-batch verification with Hive', () => {
      expect(QUEEN_BEE_PROMPT).toContain("task({ subagent_type: 'hive-helper'");
      expect(QUEEN_BEE_PROMPT).toContain('delegate the merge batch');
      expect(QUEEN_BEE_PROMPT).toContain('After the helper returns');
      expect(QUEEN_BEE_PROMPT).toContain('bun run build');
      expect(QUEEN_BEE_PROMPT).toContain('bun run test');
    });

    it('teaches Hive to delegate bounded hard-task cleanup and safe follow-up handling to hive-helper', () => {
      expect(QUEEN_BEE_PROMPT).toContain('hard-task cleanup');
      expect(QUEEN_BEE_PROMPT).toContain('interrupted wrap-up candidates');
      expect(QUEEN_BEE_PROMPT).toContain('safe append-only manual follow-up');
      expect(QUEEN_BEE_PROMPT).toContain('observably mergeable/resumable/blocked');
    });

    it('keeps DAG-changing requests routed back to Hive for plan amendment', () => {
      expect(QUEEN_BEE_PROMPT).toContain('DAG-changing');
      expect(QUEEN_BEE_PROMPT).toContain('route back to Hive');
      expect(QUEEN_BEE_PROMPT).toContain('plan amendment');
    });
  });

  describe('turn termination and hard blocks', () => {
    it('defines turn termination rules', () => {
      expect(QUEEN_BEE_PROMPT).toContain('### Turn Termination');
      expect(QUEEN_BEE_PROMPT).toContain('Valid endings');
      expect(QUEEN_BEE_PROMPT).toContain('NEVER end with');
    });

    it('separates hard blocks from anti-patterns', () => {
      expect(QUEEN_BEE_PROMPT).toContain('### Hard Blocks');
      expect(QUEEN_BEE_PROMPT).toContain('### Anti-Patterns');
    });
  });

  it('contains hard blocks section', () => {
    expect(QUEEN_BEE_PROMPT).toContain('Hard Blocks');
  });

  it('contains turn termination', () => {
    expect(QUEEN_BEE_PROMPT).toContain('Turn Termination');
  });

  it('contains docker-mastery skill reference', () => {
    expect(QUEEN_BEE_PROMPT).toContain('docker-mastery');
  });

  it('teaches Hive Builder about the built-in simplicity-reviewer', () => {
    expect(HIVE_BUILDER_PROMPT).toContain('simplicity-reviewer');
    expect(HIVE_BUILDER_PROMPT).toContain('final post-implementation simplicity pass');
    expect(HIVE_BUILDER_PROMPT).toContain('simplicity reviewer whose description best fits the cleanup lens');
  });

  it('contains agents-md-mastery skill reference', () => {
    expect(QUEEN_BEE_PROMPT).toContain('agents-md-mastery');
  });
});

describe('Multi-repo planning guidance', () => {
  it('teaches hive hybrid planners to prefer per-repo task boundaries on manifest-backed projects', () => {
    expect(QUEEN_BEE_PROMPT).toContain('**Repos**:');
    expect(QUEEN_BEE_PROMPT).toContain('per-repo task');
    expect(QUEEN_BEE_PROMPT).toContain('coupled multi-repo');
  });

  it('teaches hive hybrid planners to discover and update repository manifests before writing repo-scoped tasks', () => {
    expect(QUEEN_BEE_PROMPT).toContain('hive_repositories_status');
    expect(QUEEN_BEE_PROMPT).toContain('hive_repositories_discover');
    expect(QUEEN_BEE_PROMPT).toContain('hive_repositories_update');
    expect(QUEEN_BEE_PROMPT).toContain('Add only repositories the feature or task will touch');
  });
});

describe('Architect (Planner) prompt', () => {
  describe('delegation planning alignment', () => {
    it('allows read-only research delegation to Scout', () => {
      expect(ARCHITECT_BEE_PROMPT).toContain('read-only research delegation to Scout is allowed');
    });

    it('permits research and review delegation via task()', () => {
      expect(ARCHITECT_BEE_PROMPT).toContain('You may use task() to delegate read-only research to Scout and plan review to plan-reviewer.');
      expect(ARCHITECT_BEE_PROMPT).toContain('Never use task() to delegate implementation or coding work.');
    });

    it('does NOT contain the blanket prohibition "Delegate work or spawn workers"', () => {
      expect(ARCHITECT_BEE_PROMPT).not.toContain('Delegate work or spawn workers');
    });

    it('contains the Canonical Delegation Threshold block', () => {
      expect(ARCHITECT_BEE_PROMPT).toContain('### Canonical Delegation Threshold');
      expect(ARCHITECT_BEE_PROMPT).toContain('cannot name the file path upfront');
      expect(ARCHITECT_BEE_PROMPT).toContain('expect to inspect 2+ files');
      expect(ARCHITECT_BEE_PROMPT).toContain('open-ended');
      expect(ARCHITECT_BEE_PROMPT).toContain('Local `read/grep/glob`');
    });

    it('broadens research to include internal repo exploration', () => {
      expect(ARCHITECT_BEE_PROMPT).toContain('internal codebase');
    });

    it('tells planners to split broad research earlier', () => {
      expect(ARCHITECT_BEE_PROMPT).toContain('split broad research earlier');
    });

    it('documents scout researcher routing by closest task fit', () => {
      expect(ARCHITECT_BEE_PROMPT).toContain('the scout researcher whose description best fits the research slice');
      expect(ARCHITECT_BEE_PROMPT).toContain('Use built-in `scout-researcher` when no configured scout-derived custom description is a closer domain/workflow match');
      expect(ARCHITECT_BEE_PROMPT).toContain('task({ subagent_type: "<chosen-researcher>"');
    });

    it('documents approach-advisor routing by closest strategic fit', () => {
      expect(ARCHITECT_BEE_PROMPT).toContain('the approach advisor whose description best fits the strategic question');
      expect(ARCHITECT_BEE_PROMPT).toContain('Use built-in `approach-advisor` when no configured approach-advisor-derived custom description matches the domain or risk lens');
      expect(ARCHITECT_BEE_PROMPT).toContain('task({ subagent_type: "<chosen-advisor>"');
    });

    it('documents simplicity-reviewer boundaries for planner awareness', () => {
      expect(ARCHITECT_BEE_PROMPT).toContain('simplicity-reviewer');
      expect(ARCHITECT_BEE_PROMPT).toContain('post-implementation cleanup pass');
      expect(ARCHITECT_BEE_PROMPT).toContain('Architect should not invoke it during planning');
    });

    it('explains env-gated background-first scheduling', () => {
      expect(ARCHITECT_BEE_PROMPT).toContain('background-first scheduler mode');
      expect(ARCHITECT_BEE_PROMPT).toContain('look for independent background lanes');
      expect(ARCHITECT_BEE_PROMPT).toContain('foreground/blocking escape');
      expect(ARCHITECT_BEE_PROMPT).toContain('read-only and plan-review lanes can run in background when independent');
      expect(ARCHITECT_BEE_PROMPT).toContain('Provide known findings and references');
    });

    it('separates subagent concurrency from foreground wait mode', () => {
      expect(ARCHITECT_BEE_PROMPT).toContain('Dependency decides serial vs parallel');
      expect(ARCHITECT_BEE_PROMPT).toContain('Wait mode decides blocking foreground vs background');
      expect(ARCHITECT_BEE_PROMPT).toContain('Blocking does not mean serial');
      expect(ARCHITECT_BEE_PROMPT).toContain('If several subagent tasks are independent, emit all of their `task()` calls in the same assistant message');
    });
  });

  it('contains expanded clearance checklist', () => {
    expect(ARCHITECT_BEE_PROMPT).toContain('Test strategy confirmed');
    expect(ARCHITECT_BEE_PROMPT).toContain('blocking questions outstanding');
  });

  it('contains turn termination rules', () => {
    expect(ARCHITECT_BEE_PROMPT).toContain('Turn Termination');
    expect(ARCHITECT_BEE_PROMPT).toContain('NEVER end with');
  });

  it('contains test strategy assessment', () => {
    expect(ARCHITECT_BEE_PROMPT).toContain('Test Strategy');
  });

  it('creates the feature before writing draft context', () => {
    const createIndex = ARCHITECT_BEE_PROMPT.indexOf('hive_feature_create');
    const contextIndex = ARCHITECT_BEE_PROMPT.indexOf('hive_context_write');

    expect(createIndex).toBeGreaterThan(-1);
    expect(contextIndex).toBeGreaterThan(-1);
    expect(createIndex).toBeLessThan(contextIndex);
    expect(ARCHITECT_BEE_PROMPT).toContain('Create the feature before writing feature context');
  });

  it('requires a human-facing summary in plan.md before tasks', () => {
    expect(ARCHITECT_BEE_PROMPT).toContain('Design Summary');
    expect(ARCHITECT_BEE_PROMPT).toContain('before `## Tasks`');
    expect(ARCHITECT_BEE_PROMPT).toContain('human-facing summary');
    expect(ARCHITECT_BEE_PROMPT).toContain('plan.md');
  });

  it('describes mermaid as optional in the plan preamble only', () => {
    expect(ARCHITECT_BEE_PROMPT).toContain('optional Mermaid');
    expect(ARCHITECT_BEE_PROMPT).toContain('dependency or sequence overview');
    expect(ARCHITECT_BEE_PROMPT).toContain('context/overview.md');
    expect(ARCHITECT_BEE_PROMPT).toContain('primary human-facing review surface');
  });

  it('teaches hive hybrid planning to keep the summary in plan.md', () => {
    expect(QUEEN_BEE_PROMPT).toContain('Design Summary');
    expect(QUEEN_BEE_PROMPT).toContain('before `## Tasks`');
    expect(QUEEN_BEE_PROMPT).toContain('optional Mermaid');
    expect(QUEEN_BEE_PROMPT).toContain('context/overview.md');
  });

  it('includes clarified context model in the hive agent', () => {
    expect(QUEEN_BEE_PROMPT).toContain('`overview` = human-facing summary/history');
    expect(QUEEN_BEE_PROMPT).toContain('`draft` = planner scratchpad');
    expect(QUEEN_BEE_PROMPT).toContain('`execution-decisions` = orchestration log');
    expect(QUEEN_BEE_PROMPT).toContain('all other names');
    expect(QUEEN_BEE_PROMPT).toContain('durable');
    expect(QUEEN_BEE_PROMPT).not.toContain('`plan.md` is the primary human-facing summary');
  });

  it('instructs planners to prefer per-repo task boundaries and use the `**Repos**:` annotation on manifest-backed projects', () => {
    expect(ARCHITECT_BEE_PROMPT).toContain('**Repos**:');
    expect(ARCHITECT_BEE_PROMPT).toContain('Prefer one repo per task');
    expect(ARCHITECT_BEE_PROMPT).toContain('coupled multi-repo');
  });

  it('instructs planners to inspect, discover, and update repository manifests before repo-scoped planning', () => {
    expect(ARCHITECT_BEE_PROMPT).toContain('hive_repositories_status');
    expect(ARCHITECT_BEE_PROMPT).toContain('hive_repositories_discover');
    expect(ARCHITECT_BEE_PROMPT).toContain('hive_repositories_update');
    expect(ARCHITECT_BEE_PROMPT).toContain('without asking the operator when the scope is clear');
  });
});

describe('Swarm (Orchestrator) prompt', () => {
  describe('delegation planning alignment', () => {
    it('does NOT contain "Cancel background tasks before completion"', () => {
      expect(SWARM_BEE_PROMPT).not.toContain('Cancel background tasks before completion');
    });

    it('contains the replacement cancel rule about stale tasks', () => {
      expect(SWARM_BEE_PROMPT).toContain('Cancel background tasks only when stale or no longer needed');
    });

    it('instructs orchestrators to manage repository manifests before starting repo-scoped tasks', () => {
      expect(SWARM_BEE_PROMPT).toContain('hive_repositories_status');
      expect(SWARM_BEE_PROMPT).toContain('hive_repositories_discover');
      expect(SWARM_BEE_PROMPT).toContain('hive_repositories_update');
      expect(SWARM_BEE_PROMPT).toContain('before hive_tasks_sync, hive_task_create, or hive_worktree_start');
    });

    it('explains env-gated background-first scheduling for delegation', () => {
      expect(SWARM_BEE_PROMPT).toContain('background-first scheduler mode');
      expect(SWARM_BEE_PROMPT).toContain('look for independent background lanes');
      expect(SWARM_BEE_PROMPT).toContain('foreground/blocking escape');
      expect(SWARM_BEE_PROMPT).toContain('exploratory/read-only and review lanes may be background-launched freely');
      expect(SWARM_BEE_PROMPT).toContain('writing/change and execution lanes need file ownership');
      expect(SWARM_BEE_PROMPT).toContain('normal initial fan-out of 2-4 lanes');
    });

    it('separates subagent concurrency from foreground wait mode', () => {
      expect(SWARM_BEE_PROMPT).toContain('Dependency decides serial vs parallel');
      expect(SWARM_BEE_PROMPT).toContain('Wait mode decides blocking foreground vs background');
      expect(SWARM_BEE_PROMPT).toContain('Blocking does not mean serial');
      expect(SWARM_BEE_PROMPT).toContain('If several subagent tasks are independent, emit all of their `task()` calls in the same assistant message');
      expect(SWARM_BEE_PROMPT).not.toContain('During planning, default to synchronous exploration');
    });

    it('tells to check hive_status() after task() returns', () => {
      expect(SWARM_BEE_PROMPT).toContain('hive_status()');
    });

    it('requires hive_status() before any resume attempt', () => {
      expect(SWARM_BEE_PROMPT).toContain('After `task()` returns, call `hive_status()` immediately');
      expect(SWARM_BEE_PROMPT).toContain('before any resume attempt');
    });

    it('allows blocked resume only for exactly blocked tasks', () => {
      expect(SWARM_BEE_PROMPT).toContain('Use `continueFrom: "blocked"` only when status is exactly `blocked`');
    });

    it('requires immediate status re-check before each blocked resume', () => {
      expect(SWARM_BEE_PROMPT).toContain('Before every blocked resume, call `hive_status()` immediately beforehand');
      expect(SWARM_BEE_PROMPT).toContain('verify the task is still exactly `blocked`');
    });

    it('forbids blocked resume loops on non-blocked statuses', () => {
      expect(SWARM_BEE_PROMPT).toContain('Never loop `continueFrom: "blocked"` on non-blocked statuses');
    });

    it('clarifies terminal finality scope while allowing final natural-language handoff', () => {
      expect(SWARM_BEE_PROMPT).toContain('If any Hive tool response has `terminal: true`');
      expect(SWARM_BEE_PROMPT).toContain('do not retry the same parameters');
      expect(SWARM_BEE_PROMPT).toContain('tool call parameters');
      expect(SWARM_BEE_PROMPT).toContain('final natural-language handoff response');
    });

    it('redirects non-blocked unresolved tasks to normal dispatch', () => {
      expect(SWARM_BEE_PROMPT).toContain('If status is not `blocked`');
      expect(SWARM_BEE_PROMPT).toContain('do not use `continueFrom: "blocked"`');
      expect(SWARM_BEE_PROMPT).toContain('only for normal starts (`pending` / `in_progress`)');
      expect(SWARM_BEE_PROMPT).toContain('hive_worktree_start({ feature, task })');
    });

    it('includes task() guidance for research fan-out', () => {
      expect(SWARM_BEE_PROMPT).toContain('task() for research fan-out');
    });

    it('documents scout researcher routing by closest task fit', () => {
      expect(SWARM_BEE_PROMPT).toContain('the scout researcher whose description best fits the research slice');
      expect(SWARM_BEE_PROMPT).toContain('Use built-in `scout-researcher` when no configured scout-derived custom description is a closer domain/workflow match');
      expect(SWARM_BEE_PROMPT).toContain('task({ subagent_type: "<chosen-researcher>"');
    });

    it('documents code-reviewer routing by closest review lens', () => {
      expect(SWARM_BEE_PROMPT).toContain('the code reviewer whose description best fits the review lens');
      expect(SWARM_BEE_PROMPT).toContain('Use built-in `code-reviewer` when no configured code-reviewer-derived custom description is a closer match');
      expect(SWARM_BEE_PROMPT).toContain('task({ subagent_type: "<chosen-reviewer>"');
    });

    it('documents approach-advisor routing by closest strategic fit', () => {
      expect(SWARM_BEE_PROMPT).toContain('the approach advisor whose description best fits the strategic question');
      expect(SWARM_BEE_PROMPT).toContain('Use built-in `approach-advisor` when no configured approach-advisor-derived custom description matches the domain or risk lens');
      expect(SWARM_BEE_PROMPT).toContain('task({ subagent_type: "<chosen-advisor>"');
    });

    it('documents simplicity-reviewer routing by closest cleanup fit', () => {
      expect(SWARM_BEE_PROMPT).toContain('simplicity reviewer whose description best fits the cleanup lens');
      expect(SWARM_BEE_PROMPT).toContain('Use built-in `simplicity-reviewer` when no configured simplicity-reviewer-derived custom description is a closer match');
      expect(SWARM_BEE_PROMPT).toContain('task({ subagent_type: "<chosen-reviewer>"');
      expect(SWARM_BEE_PROMPT).toContain('post-implementation cleanup pass');
    });

    it('tells orchestrators to split broad research earlier', () => {
      expect(SWARM_BEE_PROMPT).toContain('split broad research earlier');
    });

    it('delegates batch merges to hive-helper and keeps post-batch verification with Swarm', () => {
      expect(SWARM_BEE_PROMPT).toContain("task({ subagent_type: 'hive-helper'");
      expect(SWARM_BEE_PROMPT).toContain('delegate the merge batch');
      expect(SWARM_BEE_PROMPT).toContain('After the helper returns');
      expect(SWARM_BEE_PROMPT).toContain('bun run build');
      expect(SWARM_BEE_PROMPT).toContain('bun run test');
    });

    it('teaches Swarm to delegate bounded hard-task cleanup and safe follow-up handling to hive-helper', () => {
      expect(SWARM_BEE_PROMPT).toContain('hard-task cleanup');
      expect(SWARM_BEE_PROMPT).toContain('interrupted wrap-up candidates');
      expect(SWARM_BEE_PROMPT).toContain('safe append-only manual follow-up');
      expect(SWARM_BEE_PROMPT).toContain('observably mergeable/resumable/blocked');
    });

    it('keeps DAG-changing requests routed back to Swarm for plan amendment', () => {
      expect(SWARM_BEE_PROMPT).toContain('DAG-changing');
      expect(SWARM_BEE_PROMPT).toContain('route back to Swarm');
      expect(SWARM_BEE_PROMPT).toContain('plan amendment');
    });
  });

  it('does NOT contain oracle reference', () => {
    expect(SWARM_BEE_PROMPT).not.toContain('oracle');
  });

  it('contains turn termination', () => {
    expect(SWARM_BEE_PROMPT).toContain('Turn Termination');
  });

  it('contains verification checklist', () => {
    expect(SWARM_BEE_PROMPT).toContain('After Delegation - VERIFY');
    expect(SWARM_BEE_PROMPT).toContain('Delegate diff-level review, correctness assessment, and deep verification actions');
    expect(SWARM_BEE_PROMPT).toContain('Cheap final integration checks remain allowed');
  });

  it('teaches orchestrators to maintain overview at execution milestones', () => {
    expect(SWARM_BEE_PROMPT).toContain('hive_context_write({ name: "overview", content: ... })');
    expect(SWARM_BEE_PROMPT).toContain('execution start');
    expect(SWARM_BEE_PROMPT).toContain('scope shift');
    expect(SWARM_BEE_PROMPT).toContain('completion');
    expect(SWARM_BEE_PROMPT).toContain('primary human-facing document');
    expect(SWARM_BEE_PROMPT).toContain('plan.md');
  });

  it('treats reserved context names as special-purpose files', () => {
    expect(SWARM_BEE_PROMPT).toContain('reserved special-purpose files');
    expect(SWARM_BEE_PROMPT).toContain('research-*');
    expect(SWARM_BEE_PROMPT).toContain('learnings');
  });

  it('teaches swarm about aggregate per-repo merge outcomes and partial failure handling', () => {
    expect(SWARM_BEE_PROMPT).toContain('per-repo outcomes');
    expect(SWARM_BEE_PROMPT).toContain('partial: true');
    expect(SWARM_BEE_PROMPT).toContain('aggregate');
  });

  it('tells swarm not to treat partial multi-repo merges as complete', () => {
    expect(SWARM_BEE_PROMPT).toContain('do not treat a partial merge as complete');
  });
});

describe('Forager (Worker/Coder) prompt', () => {
  it('contains resolve before blocking', () => {
    expect(FORAGER_BEE_PROMPT).toContain('Resolve Before Blocking');
    expect(FORAGER_BEE_PROMPT).toContain('tried 3');
  });

  it('contains completion checklist', () => {
    expect(FORAGER_BEE_PROMPT).toContain('Completion Checklist');
  });

  it('requires terminal commit result before stopping', () => {
    expect(FORAGER_BEE_PROMPT).toContain('regardless of `ok`');
    expect(FORAGER_BEE_PROMPT).toContain('terminal');
    expect(FORAGER_BEE_PROMPT).toContain('DO NOT STOP');
  });

  it('requires a final concise handoff response after terminal commit', () => {
    expect(FORAGER_BEE_PROMPT).toContain('send one final concise handoff response');
    expect(FORAGER_BEE_PROMPT).toContain('to the orchestrator');
    expect(FORAGER_BEE_PROMPT).toContain('what changed');
    expect(FORAGER_BEE_PROMPT).toContain('why (if relevant)');
    expect(FORAGER_BEE_PROMPT).toContain('verification evidence');
    expect(FORAGER_BEE_PROMPT).not.toContain('stop and hand off to orchestrator');
    expect(FORAGER_BEE_PROMPT).not.toContain('Do NOT respond further');
  });

  it('adds resolve-before-blocking guidance', () => {
    expect(FORAGER_BEE_PROMPT).toContain('## Resolve Before Blocking');
    expect(FORAGER_BEE_PROMPT).toContain('Default to exploration, questions are LAST resort');
    expect(FORAGER_BEE_PROMPT).toContain('Context inference: Before asking "what does X do?", READ X first.');
  });

  it('adds a completion checklist before reporting done', () => {
    expect(FORAGER_BEE_PROMPT).toContain('## Completion Checklist');
    expect(FORAGER_BEE_PROMPT).toContain('Record exact commands and results');
  });

  it('expands the orient step with explicit pre-flight actions', () => {
    expect(FORAGER_BEE_PROMPT).toContain('Read the referenced files and surrounding code');
    expect(FORAGER_BEE_PROMPT).toContain('Search for similar patterns in the codebase');
  });

  it('contains Docker Sandbox section in Iron Laws', () => {
    expect(FORAGER_BEE_PROMPT).toContain('Docker Sandbox');
  });

  it('instructs to report as blocked instead of HOST: escape', () => {
    expect(FORAGER_BEE_PROMPT).toContain('report as blocked');
    expect(FORAGER_BEE_PROMPT).not.toContain('HOST:');
  });

  it('contains docker-mastery skill reference', () => {
    expect(FORAGER_BEE_PROMPT).toContain('docker-mastery');
  });

  it('directs forager to honor declared repository scope and escalate out-of-scope files through the blocker protocol', () => {
    expect(FORAGER_BEE_PROMPT).toContain('declared repository paths');
    expect(FORAGER_BEE_PROMPT).toContain('out of scope');
    expect(FORAGER_BEE_PROMPT).toContain('blocker protocol');
  });
});

describe('Hive Helper prompt', () => {
  it('defines the bounded helper modes and forbids generalized orchestration', () => {
    expect(HIVE_HELPER_PROMPT).toContain('bounded hard-task operational assistant');
    expect(HIVE_HELPER_PROMPT).toContain('merge recovery');
    expect(HIVE_HELPER_PROMPT).toContain('state clarification');
    expect(HIVE_HELPER_PROMPT).toContain('safe manual-follow-up assistance');
    expect(HIVE_HELPER_PROMPT).toContain('never plans, orchestrates, or broadens the assignment');
  });

  it('uses hive_merge first and resolves preserved conflicts locally', () => {
    expect(HIVE_HELPER_PROMPT).toContain('hive_merge');
    expect(HIVE_HELPER_PROMPT).toContain("conflictState: 'preserved'");
    expect(HIVE_HELPER_PROMPT).toContain('resolves locally');
    expect(HIVE_HELPER_PROMPT).toContain('continues the merge batch');
  });

  it('allows state summaries and append-only manual tasks but forbids plan-backed task updates', () => {
    expect(HIVE_HELPER_PROMPT).toContain('summarize observable state');
    expect(HIVE_HELPER_PROMPT).toContain('safe append-only manual tasks');
    expect(HIVE_HELPER_PROMPT).toContain('never update plan-backed task state');
    expect(HIVE_HELPER_PROMPT).toContain('Hive Master / Swarm');
    expect(HIVE_HELPER_PROMPT).toContain('plan amendment');
  });

  it('requires concise operational summaries only', () => {
    expect(HIVE_HELPER_PROMPT).toContain('concise');
    expect(HIVE_HELPER_PROMPT).toContain('merged/state/task/blocker summary');
  });

  it('does not auto-load a Hive Skill appendix into the helper prompt', () => {
    expect(HIVE_HELPER_PROMPT).not.toContain('## Hive Skill:');
  });
});

describe('Scout (Explorer/Researcher) prompt', () => {
  it('has clean persistence example', () => {
    expect(SCOUT_BEE_PROMPT).not.toContain('Worker Prompt Builder');
    expect(SCOUT_BEE_PROMPT).toContain('research-{topic}');
  });

  it('treats reserved context names as special-purpose files', () => {
    expect(SCOUT_BEE_PROMPT).toContain('reserved names like `overview`, `draft`, and `execution-decisions`');
    expect(SCOUT_BEE_PROMPT).toContain('not for general research notes');
  });

  it('covers the sharpened operating contract with structural anchors', () => {
    expect(SCOUT_BEE_PROMPT).toContain('### Read-Only Contract');
    expect(SCOUT_BEE_PROMPT).toContain('### Preferred Search Sequence');
    expect(SCOUT_BEE_PROMPT).toContain('### Speed and Efficiency');
  });

  it('protects anti-speculation and cited-synthesis guidance', () => {
    expect(SCOUT_BEE_PROMPT).toContain('## Synthesis Rules');
    expect(SCOUT_BEE_PROMPT).toContain('cited synthesis');
    expect(SCOUT_BEE_PROMPT).toContain('unverified');
  });

  it('mentions year awareness', () => {
    expect(SCOUT_BEE_PROMPT).toContain('current year');
  });

  it('limits discovery to one context window', () => {
    expect(SCOUT_BEE_PROMPT).toContain('fit in one context window');
  });

  it('teaches return-to-hive escalation', () => {
    expect(SCOUT_BEE_PROMPT).toContain('return to Hive');
  });
});

describe('Plan reviewer prompt', () => {
  it('contains agent-executable verification guidance', () => {
    expect(PLAN_REVIEWER_PROMPT).toContain('agent-executable');
  });

  it('keeps verification routed to the canonical skill', () => {
    expect(PLAN_REVIEWER_PROMPT).toContain('verification` skill');
  });
});

describe('removed historical lookup guidance', () => {
  const removedTerms = [
    ['hive', 'network', 'query'].join('_'),
    ['Hive', 'Network'].join(' '),
  ];

  it('keeps historical lookup references out of agent prompts', () => {
    const prompts = [QUEEN_BEE_PROMPT, ARCHITECT_BEE_PROMPT, SWARM_BEE_PROMPT, PLAN_REVIEWER_PROMPT, CODE_REVIEWER_PROMPT, SIMPLICITY_REVIEWER_PROMPT, APPROACH_ADVISOR_PROMPT];

    for (const prompt of prompts) {
      for (const term of removedTerms) {
        expect(prompt).not.toContain(term);
      }
    }
  });
});

describe('README.md documentation', () => {
  const README_PATH = path.resolve(import.meta.dir, '..', '..', 'README.md');
  const readmeContent = readFileSync(README_PATH, 'utf-8');
  const ROOT_README_PATH = path.resolve(import.meta.dir, '..', '..', '..', '..', 'README.md');
  const rootReadmeContent = readFileSync(ROOT_README_PATH, 'utf-8');
  const HIVE_TOOLS_PATH = path.resolve(import.meta.dir, '..', '..', 'docs', 'HIVE-TOOLS.md');
  const hiveToolsContent = readFileSync(HIVE_TOOLS_PATH, 'utf-8');
  const VSCODE_README_PATH = path.resolve(import.meta.dir, '..', '..', '..', 'vscode-hive', 'README.md');
  const vscodeReadmeContent = readFileSync(VSCODE_README_PATH, 'utf-8');
  const PHILOSOPHY_PATH = path.resolve(import.meta.dir, '..', '..', '..', '..', 'PHILOSOPHY.md');
  const philosophyContent = readFileSync(PHILOSOPHY_PATH, 'utf-8');
  const GITHUB_HIVE_AGENT_PATH = path.resolve(import.meta.dir, '..', '..', '..', '..', '.github', 'agents', 'hive.agent.md');
  const githubHiveAgentContent = readFileSync(GITHUB_HIVE_AGENT_PATH, 'utf-8');
  const GITHUB_EXECUTING_PLANS_PATH = path.resolve(import.meta.dir, '..', '..', '..', '..', '.github', 'skills', 'executing-plans', 'SKILL.md');
  const githubExecutingPlansContent = readFileSync(GITHUB_EXECUTING_PLANS_PATH, 'utf-8');
  const GITHUB_VERIFY_COMPLETION_PATH = path.resolve(import.meta.dir, '..', '..', '..', '..', '.github', 'prompts', 'verify-completion.prompt.md');
  const githubVerifyCompletionContent = readFileSync(GITHUB_VERIFY_COMPLETION_PATH, 'utf-8');

  describe('delegation planning alignment', () => {
    it('contains the heading "### Planning-mode delegation"', () => {
      expect(readmeContent).toContain('### Planning-mode delegation');
    });

    it('explains task() delegation model', () => {
      expect(readmeContent).toContain('Delegate to Scout');
      expect(readmeContent).toContain('Read-only exploration');
    });

    it('clarifies that "don\'t execute" means "don\'t implement"', () => {
      expect(readmeContent).toContain("don't implement");
    });

    it('contains the Canonical Delegation Threshold content', () => {
      expect(readmeContent).toContain('cannot name the file path upfront');
      expect(readmeContent).toContain('2+ files');
    });
  });

  describe('background-delegation docs alignment', () => {
    it('mentions background-delegation in the available skills table', () => {
      expect(readmeContent).toContain('background-delegation');
    });

    it('documents the env gate for background-delegation', () => {
      expect(readmeContent).toContain('OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS');
    });

    it('clarifies background-delegation is not a default autoLoadSkills entry', () => {
      expect(readmeContent).toContain('is not a default');
      expect(readmeContent).toContain('autoLoadSkills');
    });

    it('documents background-first env gate behavior with native completion notifications', () => {
      expect(readmeContent).toContain('background-first scheduler');
      expect(readmeContent).toContain('hive_background_status');
      expect(readmeContent).toContain('hive_background_reconcile');
      expect(readmeContent).toContain('hive_background_cancel');
      expect(hiveToolsContent).toContain('Background Orchestration');
      expect(hiveToolsContent).toContain('native completion notifications');
      expect(hiveToolsContent).toContain('Cancellation is not rollback');
      expect(hiveToolsContent).toContain('no-resume retry/escalation');
      expect(hiveToolsContent).not.toContain('task_status');
    });

    it('documents current env-gate false behavior and env-gate true scheduler behavior', () => {
      expect(readmeContent).toContain('With the env gate unset');
      expect(readmeContent).toContain('With the env gate set');
      expect(readmeContent).not.toContain('prompt appendix text only');
      expect(hiveToolsContent).not.toContain('only controls primary-agent prompt appendix text');
    });

    it('does not keep stale root README runtime counts', () => {
      expect(rootReadmeContent).not.toContain('7 agents, 17 tools');
      expect(rootReadmeContent).not.toContain('9 agents');
      expect(rootReadmeContent).not.toContain('25 Hive tools');
    });

    it('documents VS Code background views as viewer-only surfaces', () => {
      expect(vscodeReadmeContent).toContain('Background Jobs');
      expect(vscodeReadmeContent).toContain('Tracked Repositories');
      expect(vscodeReadmeContent).toContain('does not start worktrees, commit changes, merge branches, cancel jobs, reconcile jobs, or ignore jobs');
    });
  });

  describe('hive-helper runtime docs alignment', () => {
    it('documents hive-helper in runtime-facing recovery docs', () => {
      expect(readmeContent).toContain('`hive-helper`');
      expect(readmeContent).toContain('runtime-only');
      expect(readmeContent).toContain('merge recovery');
      expect(readmeContent).toContain('state clarification');
      expect(readmeContent).toContain('safe manual-follow-up assistance');
    });

    it('documents hive-helper in the built-in agent defaults table', () => {
      expect(readmeContent).toContain('| `hive-helper` | (none) |');
    });

    it('keeps hive-helper out of custom derived subagent docs while documenting simplicity-reviewer as a custom base', () => {
      expect(readmeContent).toContain('does not appear in `.github/agents/`');
      expect(readmeContent).toContain('### Custom Derived Subagents');
      expect(readmeContent).toContain('`baseAgent`: one of `scout-researcher`, `forager-worker`, `plan-reviewer`, `code-reviewer`, `simplicity-reviewer`, or `approach-advisor`');
      expect(readmeContent).not.toContain('`simplicity-reviewer` is also not a custom base agent');
      expect(readmeContent).not.toContain('`baseAgent`: one of `forager-worker`, `code-reviewer`, or `hive-helper`');
    });

    it('mentions hive-helper and simplicity-reviewer in the top-level README so users know the agents exist', () => {
      expect(rootReadmeContent).toContain('helper recovery');
      expect(rootReadmeContent).toContain('simplicity review');
      expect(readmeContent).toContain('simplicity-reviewer');
    });

    it('documents the expanded hive_merge contract', () => {
      expect(hiveToolsContent).toContain('preserveConflicts');
      expect(hiveToolsContent).toContain('cleanup');
      expect(hiveToolsContent).toContain('conflictState');
      expect(hiveToolsContent).toContain('worktreeRemoved');
      expect(hiveToolsContent).toContain('branchDeleted');
      expect(hiveToolsContent).toContain('pruned');
      expect(hiveToolsContent).toContain('message');
    });
  });

  describe('removed historical lookup docs', () => {
    const removedNetworkTool = ['hive', 'network', 'query'].join('_');
    const removedNetworkName = ['Hive', 'Network'].join(' ');

    it('keeps current docs free of historical lookup references', () => {
      const docs = [readmeContent, hiveToolsContent, philosophyContent];

      for (const doc of docs) {
        expect(doc).not.toContain(removedNetworkTool);
        expect(doc).not.toContain(removedNetworkName);
      }
    });
  });

  describe('github workflow reviewer guidance', () => {
    it('does not route current GitHub guidance to retired hygienic or verification-before-completion flows', () => {
      const currentGuidance = [
        githubHiveAgentContent,
        githubExecutingPlansContent,
        githubVerifyCompletionContent,
      ];

      for (const doc of currentGuidance) {
        expect(doc).not.toContain('@hygienic');
        expect(doc).not.toContain('Hygienic');
        expect(doc).not.toContain('verification-before-completion');
      }
    });
  });
});

describe('AGENTS.md tool guidance', () => {
  describe('Hive (Hybrid) prompt', () => {
    it('does not reference the removed hive_agents_md tool', () => {
      expect(QUEEN_BEE_PROMPT).not.toContain('hive_agents_md');
    });

    it('instructs to review whole feature context before documentation updates', () => {
      expect(QUEEN_BEE_PROMPT).toContain('feature completion');
      expect(QUEEN_BEE_PROMPT).toContain('read the whole feature record');
      expect(QUEEN_BEE_PROMPT).toContain('task reports');
      expect(QUEEN_BEE_PROMPT).toContain('context files');
    });

    it('routes documentation conflicts to the operator with recommendations', () => {
      expect(QUEEN_BEE_PROMPT).toContain('conflicts');
      expect(QUEEN_BEE_PROMPT).toContain('operator');
      expect(QUEEN_BEE_PROMPT).toContain('recommendation');
      expect(QUEEN_BEE_PROMPT).toContain('AGENTS.md');
    });
  });

  describe('Swarm (Orchestrator) prompt', () => {
    it('does not reference the removed hive_agents_md tool', () => {
      expect(SWARM_BEE_PROMPT).not.toContain('hive_agents_md');
    });

    it('instructs to review whole feature context before documentation updates', () => {
      expect(SWARM_BEE_PROMPT).toContain('feature completion');
      expect(SWARM_BEE_PROMPT).toContain('read the whole feature record');
      expect(SWARM_BEE_PROMPT).toContain('task reports');
      expect(SWARM_BEE_PROMPT).toContain('context files');
    });

    it('contains agents-md-mastery skill reference', () => {
      expect(SWARM_BEE_PROMPT).toContain('agents-md-mastery');
    });
  });
});

describe('no removed Hive skill tool references in agent prompts', () => {
  const removedHiveSkillCall = `${['hive', 'skill'].join('_')}(`;

  it('Hive prompt does not contain the removed tool call', () => {
    expect(QUEEN_BEE_PROMPT).not.toContain(removedHiveSkillCall);
  });

  it('Swarm prompt does not contain the removed tool call', () => {
    expect(SWARM_BEE_PROMPT).not.toContain(removedHiveSkillCall);
  });

  it('Forager prompt does not contain the removed tool call', () => {
    expect(FORAGER_BEE_PROMPT).not.toContain(removedHiveSkillCall);
  });

  it('reviewer prompts do not contain the removed tool call', () => {
    expect(PLAN_REVIEWER_PROMPT).not.toContain(removedHiveSkillCall);
    expect(CODE_REVIEWER_PROMPT).not.toContain(removedHiveSkillCall);
    expect(APPROACH_ADVISOR_PROMPT).not.toContain(removedHiveSkillCall);
  });
});

describe('trimmed OpenCode runtime prompts', () => {
  const removedProjectedTodoField = ['todo', 'Projection'].join('');
  const legacyIdleReplayPhrase = ['child-session', ' idle'].join('');

  it('removes Hive projected-todo and checkpoint rituals from the Hive prompt', () => {
    expect(QUEEN_BEE_PROMPT).not.toContain(removedProjectedTodoField);
    expect(QUEEN_BEE_PROMPT).not.toContain('todoread');
    expect(QUEEN_BEE_PROMPT).not.toContain('todowrite');
    expect(QUEEN_BEE_PROMPT).not.toContain('task checkpoints');
    expect(QUEEN_BEE_PROMPT).not.toContain(legacyIdleReplayPhrase);
  });

  it('removes planner projected-todo and checkpoint rituals from the Architect prompt', () => {
    expect(ARCHITECT_BEE_PROMPT).not.toContain(removedProjectedTodoField);
    expect(ARCHITECT_BEE_PROMPT).not.toContain('todoread');
    expect(ARCHITECT_BEE_PROMPT).not.toContain('todowrite');
    expect(ARCHITECT_BEE_PROMPT).not.toContain('task checkpoints');
    expect(ARCHITECT_BEE_PROMPT).not.toContain('task-checkpoint');
  });

  it('removes orchestration projected-todo and checkpoint rituals from the Swarm prompt', () => {
    expect(SWARM_BEE_PROMPT).not.toContain(removedProjectedTodoField);
    expect(SWARM_BEE_PROMPT).not.toContain('todoread');
    expect(SWARM_BEE_PROMPT).not.toContain('todowrite');
    expect(SWARM_BEE_PROMPT).not.toContain('task checkpoints');
    expect(SWARM_BEE_PROMPT).not.toContain('worker return/block');
  });
});

describe('Hive Builder (ad-hoc executor) prompt', () => {
  it('identifies role as ad-hoc executor, not planner-first', () => {
    expect(HIVE_BUILDER_PROMPT).toContain('Hive Builder');
    expect(HIVE_BUILDER_PROMPT).toContain('ad-hoc executor');
    expect(HIVE_BUILDER_PROMPT).toContain('not planner-first');
  });

  it('contains default lifecycle: inspect, isolate, execute, verify, commit, merge, cleanup', () => {
    expect(HIVE_BUILDER_PROMPT).toContain('inspect');
    expect(HIVE_BUILDER_PROMPT).toContain('isolate');
    expect(HIVE_BUILDER_PROMPT).toContain('execute');
    expect(HIVE_BUILDER_PROMPT).toContain('verify');
    expect(HIVE_BUILDER_PROMPT).toContain('commit');
    expect(HIVE_BUILDER_PROMPT).toContain('merge');
    expect(HIVE_BUILDER_PROMPT).toContain('cleanup');
  });

  it('contains verification before integration and forbids claiming checks passed without output', () => {
    expect(HIVE_BUILDER_PROMPT).toContain('Verification before integration');
    expect(HIVE_BUILDER_PROMPT).toContain('never claim');
  });

  it('says do not create Hive features/plans/tasks by default', () => {
    expect(HIVE_BUILDER_PROMPT).toContain('do not create');
    expect(HIVE_BUILDER_PROMPT).toContain('features');
    expect(HIVE_BUILDER_PROMPT).toContain('plans');
    expect(HIVE_BUILDER_PROMPT).toContain('tasks');
    expect(HIVE_BUILDER_PROMPT).toContain('by default');
  });

  it('says escalation is advisory only and rejected escalation must continue ad-hoc', () => {
    expect(HIVE_BUILDER_PROMPT).toContain('question()');
    expect(HIVE_BUILDER_PROMPT).toContain('advisory');
    expect(HIVE_BUILDER_PROMPT).toContain('continue ad-hoc');
  });

  it('contains synthesis-before-delegation wording', () => {
    expect(HIVE_BUILDER_PROMPT).toContain('subagents do not inherit');
    expect(HIVE_BUILDER_PROMPT).toContain('evidence');
    expect(HIVE_BUILDER_PROMPT).toContain('expected result');
    expect(HIVE_BUILDER_PROMPT).toContain('done criteria');
  });

  it('contains explicit ad-hoc tool names', () => {
    expect(HIVE_BUILDER_PROMPT).toContain('hive_adhoc_worktree_create');
    expect(HIVE_BUILDER_PROMPT).toContain('hive_adhoc_worktree_commit');
    expect(HIVE_BUILDER_PROMPT).toContain('hive_adhoc_merge');
    expect(HIVE_BUILDER_PROMPT).toContain('hive_adhoc_cleanup');
    expect(HIVE_BUILDER_PROMPT).toContain('workspacePath');
    expect(HIVE_BUILDER_PROMPT).toContain('branch');
  });

  it('prefers squash merges while allowing explicit normal merges', () => {
    expect(HIVE_BUILDER_PROMPT).toContain('Prefer squash merges');
    expect(HIVE_BUILDER_PROMPT).toContain('explicit normal merge');
  });

  it('tells agents to omit unused optional ad-hoc arguments', () => {
    expect(HIVE_BUILDER_PROMPT).toContain('omit it instead of sending an empty string');
  });

  it('contains background-first scheduler policy', () => {
    expect(HIVE_BUILDER_PROMPT).toContain('background-first scheduler mode');
    expect(HIVE_BUILDER_PROMPT).toContain('background-delegation');
    expect(HIVE_BUILDER_PROMPT).toContain('look for independent background lanes');
    expect(HIVE_BUILDER_PROMPT).toContain('foreground/blocking escape');
    expect(HIVE_BUILDER_PROMPT).toContain('task_id');
    expect(HIVE_BUILDER_PROMPT).toContain('native completion notification');
    expect(HIVE_BUILDER_PROMPT).not.toContain('task_status');
  });

  it('scopes Hive Builder behavior to gate-closed ad-hoc execution and gate-open non-feature orchestration', () => {
    expect(HIVE_BUILDER_PROMPT).toContain('Gate closed');
    expect(HIVE_BUILDER_PROMPT).toContain('Gate open');
    expect(HIVE_BUILDER_PROMPT).toContain('delegate-first non-feature orchestration');
    expect(HIVE_BUILDER_PROMPT).toContain('not the default implementation worker');
  });

  it('requires complete context packets and delegation-kind classification for ad-hoc delegation', () => {
    expect(HIVE_BUILDER_PROMPT).toContain('context packet');
    expect(HIVE_BUILDER_PROMPT).toContain('prior failures');
    expect(HIVE_BUILDER_PROMPT).toContain('run IDs');
    expect(HIVE_BUILDER_PROMPT).toContain('verification requirements');
    expect(HIVE_BUILDER_PROMPT).toContain('Exploratory/read-only');
    expect(HIVE_BUILDER_PROMPT).toContain('Writing/change');
    expect(HIVE_BUILDER_PROMPT).toContain('- **Review**: lightweight background lane');
    expect(HIVE_BUILDER_PROMPT).toContain('- **Execution**: managed ad-hoc lifecycle');
  });

  it('requires lane tracking, unresolved-lane checks, and prompt-level write-conflict boundaries', () => {
    expect(HIVE_BUILDER_PROMPT).toContain('todowrite');
    expect(HIVE_BUILDER_PROMPT).toContain('task ID/state');
    expect(HIVE_BUILDER_PROMPT).toContain('unresolved lanes');
    expect(HIVE_BUILDER_PROMPT).toContain('Before merge, cleanup, final reporting');
    expect(HIVE_BUILDER_PROMPT).toContain('one active writing/change lane per owned path/module');
    expect(HIVE_BUILDER_PROMPT).toContain('Assign file/path boundaries');
    expect(HIVE_BUILDER_PROMPT).toContain('auto-abort conflicts by default');
  });

  it('routes verification and durable execution decisions through the gate-open orchestrator contract', () => {
    expect(HIVE_BUILDER_PROMPT).toContain('Workers verify their own changes before commit');
    expect(HIVE_BUILDER_PROMPT).toContain('delegates diff/deep verification');
    expect(HIVE_BUILDER_PROMPT).toContain('cheap integration checks');
    expect(HIVE_BUILDER_PROMPT).toContain("hive_context_write({ name: 'execution-decisions'");
    expect(HIVE_BUILDER_PROMPT).toContain('non-trivial orchestration');
    expect(HIVE_BUILDER_PROMPT).toContain('Skip durable context for trivial single-lane ad-hoc work');
  });

  it('keeps primary prompts aligned on scheduler-first escape reasons', () => {
    for (const prompt of [QUEEN_BEE_PROMPT, ARCHITECT_BEE_PROMPT, SWARM_BEE_PROMPT, HIVE_BUILDER_PROMPT]) {
      expect(prompt).toContain('background-first scheduler mode');
      expect(prompt).toContain('dependency, risk, simplicity, user interaction, or ownership conflict');
    }
  });

  it('separates subagent concurrency from foreground wait mode', () => {
    expect(HIVE_BUILDER_PROMPT).toContain('Dependency decides serial vs parallel');
    expect(HIVE_BUILDER_PROMPT).toContain('Wait mode decides blocking foreground vs background');
    expect(HIVE_BUILDER_PROMPT).toContain('Blocking does not mean serial');
    expect(HIVE_BUILDER_PROMPT).toContain('If several subagent tasks are independent, emit all of their `task()` calls in the same assistant message');
  });

  it('says subagents must not call task() recursively', () => {
    expect(HIVE_BUILDER_PROMPT).toContain('subagents');
    expect(HIVE_BUILDER_PROMPT).toContain('not call');
    expect(HIVE_BUILDER_PROMPT).toContain('task()');
    expect(HIVE_BUILDER_PROMPT).toContain('recursively');
  });

  it('does NOT contain task-DAG defaults', () => {
    expect(HIVE_BUILDER_PROMPT).not.toContain('hive_tasks_sync({ refreshPending: true })');
    expect(HIVE_BUILDER_PROMPT).not.toContain('Depends on:');
    expect(HIVE_BUILDER_PROMPT).not.toContain('hive_worktree_start(task)');
  });

  it('does NOT contain stale background wrappers', () => {
    expect(HIVE_BUILDER_PROMPT).not.toContain('hive_background_task');
    expect(HIVE_BUILDER_PROMPT).not.toContain('hive_background_output');
  });
});

describe('Worker prompt composite workspace boundaries', () => {
  const baseParams = {
    feature: 'multi-repo-feature',
    task: '01-multi-task',
    taskOrder: 1,
    branch: 'hive/api/multi-repo-feature/01-multi-task',
    plan: '# Plan',
    contextFiles: [],
    spec: '# Task: 01-multi-task\n\n## Plan Section\n\nDo it.',
  };

  it('uses the composite workspace root as the worktree label and lists declared repos with paths and branches', () => {
    const prompt = buildWorkerPrompt({
      ...baseParams,
      worktreePath: '/tmp/composite-root',
      workspacePath: '/tmp/composite-root',
      repos: {
        api: { path: '/tmp/composite-root/repos/api', branch: 'hive/api/multi-repo-feature/01-multi-task' },
        web: { path: '/tmp/composite-root/repos/web', branch: 'hive/web/multi-repo-feature/01-multi-task' },
      },
    });

    expect(prompt).toContain('| Workspace Root | /tmp/composite-root |');
    expect(prompt).toContain('## Declared Repositories');
    expect(prompt).toContain('`api`');
    expect(prompt).toContain('`/tmp/composite-root/repos/api`');
    expect(prompt).toContain('`web`');
    expect(prompt).toContain('`/tmp/composite-root/repos/web`');
    expect(prompt).toContain('`hive/api/multi-repo-feature/01-multi-task`');
    expect(prompt).toContain('`hive/web/multi-repo-feature/01-multi-task`');
  });

  it('forbids edits outside declared repository paths and points elsewhere in the orchestration root as out of scope', () => {
    const prompt = buildWorkerPrompt({
      ...baseParams,
      worktreePath: '/tmp/composite-root',
      workspacePath: '/tmp/composite-root',
      repos: {
        api: { path: '/tmp/composite-root/repos/api', branch: 'b1' },
      },
    });

    expect(prompt).toContain('All file operations MUST stay within the declared repository paths');
    expect(prompt).toContain('do NOT assume edits are allowed anywhere under the orchestration root');
  });

  it('directs the worker to escalate via the blocker protocol when an undeclared repo is needed', () => {
    const prompt = buildWorkerPrompt({
      ...baseParams,
      worktreePath: '/tmp/composite-root',
      workspacePath: '/tmp/composite-root',
      repos: {
        api: { path: '/tmp/composite-root/repos/api', branch: 'b1' },
      },
    });

    expect(prompt).toContain('not in this list');
    expect(prompt).toContain('blocker protocol');
  });

  it('keeps legacy single-worktree assignment text when no composite metadata is provided', () => {
    const prompt = buildWorkerPrompt({
      ...baseParams,
      worktreePath: '/tmp/legacy-worktree',
      branch: 'hive/legacy-feature/01-task',
    });

    expect(prompt).toContain('| Worktree | /tmp/legacy-worktree |');
    expect(prompt).toContain('All file operations MUST be within this worktree path');
    expect(prompt).not.toContain('## Declared Repositories');
  });
});
