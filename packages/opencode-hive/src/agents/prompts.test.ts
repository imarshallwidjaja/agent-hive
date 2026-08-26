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
import { DASH_REVIEWER_PROMPT } from './dash-reviewer';
import { VULNERABILITY_REVIEW_PRIMARY_PROMPT } from './vulnerability-review-primary';
import { VULNERABILITY_REVIEWER_PROMPT } from './vulnerability-reviewer';
import { buildWorkerPrompt } from '../utils/worker-prompt';
import { HIVE_SYSTEM_PROMPT } from '../hooks/system-hook';
import { ENGINEERING_JUDGMENT_PROMPT } from './engineering-judgment';

function countOccurrences(content: string, needle: string): number {
  return content.split(needle).length - 1;
}

describe('Engineering judgment prompt reach', () => {
  const includedPrompts = [
    ['Hive', QUEEN_BEE_PROMPT],
    ['Architect', ARCHITECT_BEE_PROMPT],
    ['Forager', FORAGER_BEE_PROMPT],
    ['Plan Reviewer', PLAN_REVIEWER_PROMPT],
    ['Code Reviewer', CODE_REVIEWER_PROMPT],
    ['Simplicity Reviewer', SIMPLICITY_REVIEWER_PROMPT],
  ] as const;

  const omittedPrompts = [
    ['Swarm', SWARM_BEE_PROMPT],
    ['Scout', SCOUT_BEE_PROMPT],
    ['Hive Helper', HIVE_HELPER_PROMPT],
    ['Hive Builder', HIVE_BUILDER_PROMPT],
    ['Approach Advisor', APPROACH_ADVISOR_PROMPT],
    ['Dash Reviewer', DASH_REVIEWER_PROMPT],
    ['Vulnerability Review Primary', VULNERABILITY_REVIEW_PRIMARY_PROMPT],
    ['Vulnerability Reviewer', VULNERABILITY_REVIEWER_PROMPT],
  ] as const;

  it('includes the canonical fragment exactly once in planners, workers, and ordinary reviewers', () => {
    for (const [name, prompt] of includedPrompts) {
      expect(countOccurrences(prompt, ENGINEERING_JUDGMENT_PROMPT), name).toBe(1);
    }
  });

  it('omits the fragment from unrelated researchers, orchestrators, helpers, and specialized reviewers', () => {
    for (const [name, prompt] of omittedPrompts) {
      expect(prompt, name).not.toContain(ENGINEERING_JUDGMENT_PROMPT);
    }
  });

  it('keeps the canonical fragment compact', () => {
    expect(ENGINEERING_JUDGMENT_PROMPT.split('\n').length).toBeLessThanOrEqual(40);
    expect(Buffer.byteLength(ENGINEERING_JUDGMENT_PROMPT, 'utf8')).toBeLessThanOrEqual(3_000);
  });

  it('anchors role-specific application at existing decision points', () => {
    expect(ARCHITECT_BEE_PROMPT).toContain('When drafting the plan');
    expect(QUEEN_BEE_PROMPT).toContain('When drafting the plan');
    expect(FORAGER_BEE_PROMPT).toContain('Apply Engineering Judgment during PLAN and VERIFY');
    expect(PLAN_REVIEWER_PROMPT).toContain('Apply Engineering Judgment only as an execution-readiness lens');
    expect(CODE_REVIEWER_PROMPT).toContain('Apply Engineering Judgment to the changed scope');
    expect(SIMPLICITY_REVIEWER_PROMPT).toContain('total cognitive burden and ownership clarity');
  });
});

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

const DELEGATION_POLICY_NUMERIC_FANOUT =
  /three Scouts|up to\s+\d+\s+lanes?|\b\d+\s+tasks?\b(?=[^\n]{0,80}(?:fan-out|parallel|dispatch))|\b2-4\b|\b5\+/i;

function subagentConcurrencySection(prompt: string): string {
  const start = prompt.indexOf('### Subagent Concurrency');
  if (start < 0) return '';
  const rest = prompt.slice(start);
  const next = rest.search(/\n### |\n## /);
  return next < 0 ? rest : rest.slice(0, next);
}

describe('Primary agent subagent concurrency guidance', () => {
  const primaryPrompts = [
    ['Hive', QUEEN_BEE_PROMPT],
    ['Architect', ARCHITECT_BEE_PROMPT],
    ['Swarm', SWARM_BEE_PROMPT],
    ['Hive Builder', HIVE_BUILDER_PROMPT],
  ] as const;

  const backgroundPrimaries = [
    ['Hive', QUEEN_BEE_PROMPT],
    ['Architect', ARCHITECT_BEE_PROMPT],
    ['Swarm', SWARM_BEE_PROMPT],
  ] as const;

  it('does not keep stale synchronous-exploration wording in primary prompts', () => {
    for (const [name, prompt] of primaryPrompts) {
      expect(prompt, name).not.toContain('default to synchronous exploration');
      expect(prompt, name).not.toContain('synchronous exploration');
    }
  });

  it('routes Scout fan-out to parallel-exploration without copying canonical detail or numeric caps', () => {
    for (const [name, prompt] of primaryPrompts) {
      const policy = subagentConcurrencySection(prompt);
      expect(policy, name).toMatch(/load and use [`']?parallel-exploration/i);
      expect(policy, name).not.toContain('one independently answerable question per Scout');
      expect(policy, name).not.toMatch(
        /launch all currently admitted independent Scout questions together/i
      );
      expect(policy, name).not.toMatch(/defer only evidence-dependent Scout questions/i);
      expect(policy, name).not.toMatch(DELEGATION_POLICY_NUMERIC_FANOUT);
    }
  });

  it('routes background wait mode to background-delegation without copying eligibility detail', () => {
    for (const [name, prompt] of backgroundPrimaries) {
      const policy = subagentConcurrencySection(prompt);
      expect(policy, name).toMatch(/load and use [`']?background-delegation/i);
      expect(policy, name).not.toMatch(/useful unrelated foreground work/i);
      expect(policy, name).not.toMatch(
        /otherwise launch independent lanes together in blocking mode/i
      );
      expect(policy, name).not.toMatch(
        /foreground\/blocking escape for dependency, risk, simplicity/i
      );
      expect(policy, name).not.toMatch(
        /background-launched freely when independent|run in background when independent|freely when independent/i
      );
    }
  });
});

describe('/grill and /interview primary-agent mode exception', () => {
  const routedPrimaryPrompts = [
    ['Hive', QUEEN_BEE_PROMPT],
    ['Architect', ARCHITECT_BEE_PROMPT],
  ] as const;

  it('keeps both grilling commands conversation-scoped until separately authorized action', () => {
    for (const [name, prompt] of routedPrimaryPrompts) {
      expect(prompt, name).toContain('## Grilling Command Mode Exception');
      expect(prompt, name).toContain('When `/grill` or `/interview` is invoked');
      expect(prompt, name).toContain('`/grill` ends at explicit alignment');
      expect(prompt, name).toContain('`/interview` keeps questioning implementation-oriented');
      expect(prompt, name).toContain('context for the separate `/implementation-brief`');
      expect(prompt, name).toContain('suspend automatic plan generation, Hive-state persistence or mutation, implementation, and follow-on action');
      expect(prompt, name).toContain('Confirmed alignment ends the interaction');
      expect(prompt, name).toContain('separately invokes `/implementation-brief` or explicitly requests another action');
      expect(prompt, name).toContain('A named destination authorizes writing only the confirmed alignment brief there');
    }
  });

  it('lets the grilling research policy override normal delegation and fan-out mandates', () => {
    for (const [name, prompt] of routedPrimaryPrompts) {
      expect(prompt, name).toContain("The `grilling` skill's research policy overrides otherwise universal or default delegation, direct-work, concurrency, and fan-out mandates");
      expect(prompt, name).toContain('Choose direct retrieval, one agent, or multiple agents based only on bounded material evidence needs and dependencies');
      expect(prompt, name).toContain('No minimum, maximum, fixed timing, or forced delegation applies');
    }
  });
});

describe('Fresh-session delegation contract', () => {
  const primaryPrompts = [
    ['Hive', QUEEN_BEE_PROMPT],
    ['Swarm', SWARM_BEE_PROMPT],
    ['Hive Builder', HIVE_BUILDER_PROMPT],
  ] as const;

  it('treats every task launch as one fresh session with one primary goal and terminal handoff', () => {
    for (const [name, prompt] of primaryPrompts) {
      expect(prompt, name).toContain('one primary goal');
      expect(prompt, name).toContain('fresh subagent session');
      expect(prompt, name).toContain('one terminal handoff');
      expect(prompt, name).toContain('tightly coupled code, tests, docs, and multiple files');
    }
  });

  it('forbids task session reuse and task_id input reuse', () => {
    for (const [name, prompt] of primaryPrompts) {
      expect(prompt, name).toContain('Never pass `task_id` to `task()`');
      expect(prompt, name).toContain('observe-only board handles');
      expect(prompt, name).toContain('Do not send a follow-up prompt to a completed, failed, or blocked session');
    }
  });

  it('distinguishes feature continuation, retry, and compaction from re-delegation', () => {
    for (const [name, prompt] of primaryPrompts) {
      expect(prompt, name).toContain('concise self-contained handoff');
      expect(prompt, name).toContain('Compaction may re-anchor a currently running worker; it is not re-delegation');
      expect(prompt, name).toContain('Subagents are terminal and cannot recurse, except a delegated `architect-planner`');
      expect(prompt, name).toContain('those children cannot delegate');
    }

    for (const [name, prompt] of [
      ['Hive', QUEEN_BEE_PROMPT],
      ['Swarm', SWARM_BEE_PROMPT],
    ] as const) {
      expect(prompt, name).toContain('new worker session in the same worktree');
    }
  });

  it('keeps feature DAG granularity distinct from ad-hoc lane ownership', () => {
    for (const [name, prompt] of [
      ['Hive', QUEEN_BEE_PROMPT],
      ['Swarm', SWARM_BEE_PROMPT],
    ] as const) {
      expect(prompt.toLowerCase(), name).toContain('one implementation assignment normally maps to one numbered task');
      expect(prompt, name).toContain('amend the DAG or create an append-only manual task');
    }

    expect(HIVE_BUILDER_PROMPT).toContain('disjoint path ownership or sequence overlapping writers');
  });

  it('requests semantic recovery handoffs and treats every generated claim as untrusted context coverage', () => {
    for (const [name, prompt] of [
      ['Hive', QUEEN_BEE_PROMPT],
      ['Architect', ARCHITECT_BEE_PROMPT],
      ['Swarm', SWARM_BEE_PROMPT],
      ['Hive Builder', HIVE_BUILDER_PROMPT],
    ] as const) {
      expect(prompt, name).toContain('hive_task_trace({ task_id, recovery: true })');
      expect(prompt, name).toContain('semantic handoff');
      expect(prompt, name).toContain('untrusted');
      expect(prompt, name).toContain('source coverage');
      expect(prompt, name).toContain('not evidence or proof');
      expect(prompt, name).toContain('Never accept, merge, retry, resume, or auto-run');
    }
  });
});

describe('Direct Work Boundary prompt hygiene', () => {
  const staleBroadDirectPhrases = [
    'Single-file, <10-line changes — do directly',
    'Questions answerable with one grep + one file read',
    '| Explicit | Specific file/line, clear command | Execute directly |',
    '| Simple | 1-2 files, <30 min | Light discovery → act |',
  ] as const;

  it('Hive and Swarm do not retain stale broad direct-execution allowances', () => {
    for (const phrase of staleBroadDirectPhrases) {
      expect(QUEEN_BEE_PROMPT).not.toContain(phrase);
      expect(SWARM_BEE_PROMPT).not.toContain(phrase);
    }
    expect(QUEEN_BEE_PROMPT).toContain('Direct Work Boundary');
    expect(SWARM_BEE_PROMPT).toContain('Direct Work Boundary');
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
    expect(SCOUT_BEE_PROMPT).toContain('independent evidence');
    expect(SCOUT_BEE_PROMPT).toContain('answer immediately');
  });

  it('includes synthesis rules prohibiting speculation about unread files', () => {
    expect(SCOUT_BEE_PROMPT).toContain('## Synthesis Rules');
    expect(SCOUT_BEE_PROMPT).toContain('do not speculate about its contents');
    expect(SCOUT_BEE_PROMPT).toContain('cited synthesis');
  });

  it('forbids Scout from delegating or orchestrating other agents', () => {
    expect(SCOUT_BEE_PROMPT).toContain('Do not delegate or orchestrate other agents');
  });

  it('answers only the assigned primary question and returns partial findings before expanding scope', () => {
    expect(SCOUT_BEE_PROMPT).toContain('Answer the assigned primary question');
    expect(SCOUT_BEE_PROMPT).toContain('Follow subordinate evidence needed to answer it');
    expect(SCOUT_BEE_PROMPT).toContain('Do not investigate adjacent questions');
    expect(SCOUT_BEE_PROMPT).toContain('fresh-lane recommendations');
    expect(SCOUT_BEE_PROMPT).toMatch(/return partial findings if further progress requires scope expansion/i);
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
  it('keeps vulnerability review orchestration and evidence review in separate no-fix roles', () => {
    expect(VULNERABILITY_REVIEW_PRIMARY_PROMPT).toContain('private orchestrator');
    expect(VULNERABILITY_REVIEW_PRIMARY_PROMPT).toContain('do not review, falsify, or fix code');
    expect(VULNERABILITY_REVIEW_PRIMARY_PROMPT).toContain('mandatory baseline and fixed falsifier');
    expect(VULNERABILITY_REVIEW_PRIMARY_PROMPT).toContain('two fresh blocking scope-scout tasks');
    expect(VULNERABILITY_REVIEW_PRIMARY_PROMPT).toContain('exact `scopeEcho`');
    expect(VULNERABILITY_REVIEW_PRIMARY_PROMPT).toContain('one clarification question');
    expect(VULNERABILITY_REVIEW_PRIMARY_PROMPT).toContain('report the run as INCOMPLETE');
    expect(VULNERABILITY_REVIEWER_PROMPT).toContain('attacker-controlled input or capabilities');
    expect(VULNERABILITY_REVIEWER_PROMPT).toContain('concrete impact');
    expect(VULNERABILITY_REVIEWER_PROMPT).toContain('Do not edit or create files');
    expect(VULNERABILITY_REVIEWER_PROMPT).toContain('Do not delegate');
    expect(VULNERABILITY_REVIEWER_PROMPT).toContain('Do not propose or apply a patch');
  });

  it('keeps dash-reviewer as a read-only review orchestrator rather than a reviewer or fixer', () => {
    expect(DASH_REVIEWER_PROMPT).toContain('review orchestrator');
    expect(DASH_REVIEWER_PROMPT).toContain('not a reviewer or fixer');
    expect(DASH_REVIEWER_PROMPT).toContain('Do not use direct `hive_git_snapshot`');
    expect(DASH_REVIEWER_PROMPT).toContain('realpath containment');
    expect(DASH_REVIEWER_PROMPT).toContain('untrusted data');
    expect(DASH_REVIEWER_PROMPT).toContain('native `task()`');
    expect(DASH_REVIEWER_PROMPT).toContain('runtime-rendered review-lane aliases');
    expect(DASH_REVIEWER_PROMPT).toContain('hive_review_evidence_resolve');
    expect(DASH_REVIEWER_PROMPT).toContain('primary claim, primary inspect, and primary cleanup');
    expect(DASH_REVIEWER_PROMPT).toContain('orchestration tools only');
    expect(DASH_REVIEWER_PROMPT).toContain('Do not inspect local files, run shell or Git commands, or access the network');
    expect(DASH_REVIEWER_PROMPT).not.toContain('sole lifecycle exception');
    expect(DASH_REVIEWER_PROMPT).not.toContain('commit, merge, clean up');
    expect(DASH_REVIEWER_PROMPT).not.toContain('scope/lead scout');
    expect(DASH_REVIEWER_PROMPT).not.toContain('Do not run Git');
  });

  it('leaves provider and scope workflow details to the active dash-review command contract', () => {
    expect(DASH_REVIEWER_PROMPT).toContain('Follow the active `/dash-review` command contract');
    for (const commandContractDetail of [
      'GitHub',
      'githubPullRequest',
      'gh api',
      'baseSha',
      'headSha',
      'verified PR commits',
      'local snapshot scope',
      'unverified local checkout',
      'targetRef',
      'provider refs',
    ]) {
      expect(DASH_REVIEWER_PROMPT).not.toContain(commandContractDetail);
    }
  });

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

    it('separates subagent concurrency from foreground wait mode', () => {
      expect(QUEEN_BEE_PROMPT).toContain('Dependency decides serial vs parallel');
      expect(QUEEN_BEE_PROMPT).toContain('Wait mode decides blocking foreground vs background');
      expect(QUEEN_BEE_PROMPT).toContain('Blocking does not mean serial');
      expect(QUEEN_BEE_PROMPT).toContain(
        'If several subagent tasks are independent, emit all of their `task()` calls in the same assistant message'
      );
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

    it('requires hive_status() before any blocked-continuation launch', () => {
      expect(QUEEN_BEE_PROMPT).toContain('After `task()` returns, immediately call `hive_status()`');
      expect(QUEEN_BEE_PROMPT).toContain('before any blocked-continuation launch');
    });

    it('allows blocked continuation only for exactly blocked tasks', () => {
      expect(QUEEN_BEE_PROMPT).toContain('Use `continueFrom: "blocked"` only when status is exactly `blocked`');
      expect(QUEEN_BEE_PROMPT).not.toContain('Use `continueFrom: "blocked"` when status is unresolved');
    });

    it('forbids blocked-continuation loops on non-blocked statuses', () => {
      expect(QUEEN_BEE_PROMPT).toContain('Never loop `continueFrom: "blocked"` on non-blocked statuses');
    });

    it('requires immediate status re-check before blocked continuation', () => {
      expect(QUEEN_BEE_PROMPT).toContain('Before every blocked-continuation launch, call `hive_status()` immediately beforehand');
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

    it('defaults to one polished squash commit per task', () => {
      expect(QUEEN_BEE_PROMPT).toContain('Default to `strategy: "squash"`');
      expect(QUEEN_BEE_PROMPT).toContain('subject, a blank line, and a descriptive body');
      expect(QUEEN_BEE_PROMPT).toContain('Preserve one root commit per completed task');
      expect(QUEEN_BEE_PROMPT).toContain('review and fix iterations into that squash commit');
      expect(QUEEN_BEE_PROMPT).toContain('Do not use `hive`, task numbers, task folder names, run IDs, or "merge task" prose');
      expect(QUEEN_BEE_PROMPT).not.toContain('Prefer `strategy: "rebase"`');
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

    it('tells planners to hand Scouts known findings instead of rediscovery', () => {
      expect(ARCHITECT_BEE_PROMPT).toContain('Provide known findings and references');
    });

    it('separates subagent concurrency from foreground wait mode', () => {
      expect(ARCHITECT_BEE_PROMPT).toContain('Dependency decides serial vs parallel');
      expect(ARCHITECT_BEE_PROMPT).toContain('Wait mode decides blocking foreground vs background');
      expect(ARCHITECT_BEE_PROMPT).toContain('Blocking does not mean serial');
      expect(ARCHITECT_BEE_PROMPT).toContain(
        'If several subagent tasks are independent, emit all of their `task()` calls in the same assistant message'
      );
    });
  });

  it('contains expanded clearance checklist', () => {
    expect(ARCHITECT_BEE_PROMPT).toContain('Testing and verification strategy resolved');
    expect(ARCHITECT_BEE_PROMPT).toContain('blocking questions outstanding');
  });

  it('contains turn termination rules', () => {
    expect(ARCHITECT_BEE_PROMPT).toContain('Turn Termination');
    expect(ARCHITECT_BEE_PROMPT).toContain('NEVER end with');
  });

  it('contains test strategy assessment', () => {
    expect(ARCHITECT_BEE_PROMPT).toContain('Contextual Testing Strategy');
  });

  it('hands pending-task refresh to the orchestrator instead of calling it as Architect', () => {
    expect(ARCHITECT_BEE_PROMPT).toContain('orchestrator owns');
    expect(ARCHITECT_BEE_PROMPT).toContain('hive_tasks_sync({ refreshPending: true })');
    expect(ARCHITECT_BEE_PROMPT).toContain('record the required refresh in the planning handoff');
    expect(ARCHITECT_BEE_PROMPT).not.toContain('run `hive_tasks_sync({ refreshPending: true })` explicitly');
  });

  it('resolves and records testing strategy without defaulting to separate test tasks', () => {
    expect(ARCHITECT_BEE_PROMPT).toContain(
      'Resolve the testing and verification strategy from repository evidence, requirements, and risk'
    );
    expect(ARCHITECT_BEE_PROMPT).toContain(
      'Ask only when repository evidence and requirements do not resolve a material choice'
    );
    expect(ARCHITECT_BEE_PROMPT).toContain('Record the selected strategy and rationale in the draft');
    expect(ARCHITECT_BEE_PROMPT).toContain('embed them in the same implementation task');
    expect(ARCHITECT_BEE_PROMPT).toContain('Require proportionate verification');
    expect(ARCHITECT_BEE_PROMPT).toContain('keep tests with the implementation task');
    expect(ARCHITECT_BEE_PROMPT).toContain('do not create separate test tasks by default');
  });

  it('creates the feature before writing draft context', () => {
    const createIndex = ARCHITECT_BEE_PROMPT.indexOf('hive_feature_create');
    const contextIndex = ARCHITECT_BEE_PROMPT.indexOf('hive_context_write');

    expect(createIndex).toBeGreaterThan(-1);
    expect(contextIndex).toBeGreaterThan(-1);
    expect(createIndex).toBeLessThan(contextIndex);
    expect(ARCHITECT_BEE_PROMPT).toContain('Create the feature before writing feature context');
    expect(ARCHITECT_BEE_PROMPT).toContain('hive_context_write({ feature: "feature-name"');
  });

  it('uses explicit feature targeting for root-oriented context guidance', () => {
    expect(QUEEN_BEE_PROMPT).toContain(
      'hive_context_write({ feature: "feature-name", name: "execution-decisions"',
    );
    expect(SWARM_BEE_PROMPT).toContain(
      'hive_context_write({ feature: "feature-name", name: "execution-decisions"',
    );
    expect(SCOUT_BEE_PROMPT).toContain('feature: "{feature-name}"');
    expect(HIVE_BUILDER_PROMPT).not.toContain('## Durable Notes');
    expect(HIVE_BUILDER_PROMPT).not.toContain('execution-decisions');
  });

  it('requires a human-facing summary in plan.md before tasks', () => {
    expect(ARCHITECT_BEE_PROMPT).toContain('Design Summary');
    expect(ARCHITECT_BEE_PROMPT).toContain('before `## Tasks`');
    expect(ARCHITECT_BEE_PROMPT).toContain('human-facing summary');
    expect(ARCHITECT_BEE_PROMPT).toContain('plan.md');
  });

  it('keeps pure final verification outside numbered implementation tasks', () => {
    for (const [name, prompt] of [
      ['Architect', ARCHITECT_BEE_PROMPT],
      ['Hive', QUEEN_BEE_PROMPT],
    ] as const) {
      expect(prompt, name).toContain('pure final verification outside `## Tasks`');
      expect(prompt, name).toContain('## Final Verification');
      expect(prompt, name).toContain('worktree-backed implementation/docs/test changes');
    }
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

    it('separates subagent concurrency from foreground wait mode', () => {
      expect(SWARM_BEE_PROMPT).toContain('Dependency decides serial vs parallel');
      expect(SWARM_BEE_PROMPT).toContain('Wait mode decides blocking foreground vs background');
      expect(SWARM_BEE_PROMPT).toContain('Blocking does not mean serial');
      expect(SWARM_BEE_PROMPT).toContain(
        'If several subagent tasks are independent, emit all of their `task()` calls in the same assistant message'
      );
      expect(SWARM_BEE_PROMPT).not.toContain('During planning, default to synchronous exploration');
    });

    it('tells to check hive_status() after task() returns', () => {
      expect(SWARM_BEE_PROMPT).toContain('hive_status()');
    });

    it('requires hive_status() before any blocked-continuation launch', () => {
      expect(SWARM_BEE_PROMPT).toContain('After `task()` returns, call `hive_status()` immediately');
      expect(SWARM_BEE_PROMPT).toContain('before any blocked-continuation launch');
    });

    it('allows blocked continuation only for exactly blocked tasks', () => {
      expect(SWARM_BEE_PROMPT).toContain('Use `continueFrom: "blocked"` only when status is exactly `blocked`');
    });

    it('requires immediate status re-check before each blocked continuation', () => {
      expect(SWARM_BEE_PROMPT).toContain('Before every blocked-continuation launch, call `hive_status()` immediately beforehand');
      expect(SWARM_BEE_PROMPT).toContain('verify the task is still exactly `blocked`');
    });

    it('forbids blocked-continuation loops on non-blocked statuses', () => {
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

    it('routes post-batch review by risk tier without fixed specialist tables', () => {
      expect(SWARM_BEE_PROMPT).toContain('Risk-Tier Review Routing');
      expect(SWARM_BEE_PROMPT).toContain('public contracts, persistence/state, branch/worktree/merge lifecycle, background scheduler semantics, auth/security, or broad prompt/tool behavior');
      expect(SWARM_BEE_PROMPT).toContain('bounded docs/tests');
      expect(SWARM_BEE_PROMPT).toContain('verification-only gates');
      expect(SWARM_BEE_PROMPT).toContain('named high-risk concern');
      expect(SWARM_BEE_PROMPT).toContain('description best fits');
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

    it('defaults to one polished squash commit per task', () => {
      expect(SWARM_BEE_PROMPT).toContain('Default to `strategy: "squash"`');
      expect(SWARM_BEE_PROMPT).toContain('subject, a blank line, and a descriptive body');
      expect(SWARM_BEE_PROMPT).toContain('Preserve one root commit per completed task');
      expect(SWARM_BEE_PROMPT).toContain('review and fix iterations into that squash commit');
      expect(SWARM_BEE_PROMPT).toContain('Do not use `hive`, task numbers, task folder names, run IDs, or "merge task" prose');
      expect(SWARM_BEE_PROMPT).not.toContain('Prefer `strategy: "rebase"`');
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

  it('routes architect subagent clarification to the parent without question()', () => {
    expect(ARCHITECT_BEE_PROMPT).toContain(
      'When launched as a subagent, return the exact clarification question in your terminal response',
    );
    expect(ARCHITECT_BEE_PROMPT).toContain('Only primary sessions call `question()`');
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
    expect(SWARM_BEE_PROMPT).toContain(
      'hive_context_write({ feature: "feature-name", name: "overview", content: ... })',
    );
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

  it('routes merge and wrap-up endings through helper by default, not direct hive_merge', () => {
    expect(SWARM_BEE_PROMPT).toContain('hive_status.helperStatus');
    expect(SWARM_BEE_PROMPT).toContain('helper merge delegation/state clarification');
    expect(SWARM_BEE_PROMPT).toContain('retry helper delegation once');
    expect(SWARM_BEE_PROMPT).toContain('direct `hive_merge` recovery escape');
    expect(SWARM_BEE_PROMPT).not.toContain('merge (hive_merge)');
  });

  it('does not regain normal direct hive_merge guidance from the shared system prompt', () => {
    const effectiveSwarmPrompt = SWARM_BEE_PROMPT + HIVE_SYSTEM_PROMPT;

    expect(HIVE_SYSTEM_PROMPT).toContain('responsible orchestrator/helper flow');
    expect(effectiveSwarmPrompt).toContain('Swarm normally delegates merge batches to `hive-helper`');
    expect(effectiveSwarmPrompt).not.toContain('Use hive_merge to integrate changes into the current branch.');
  });
});

describe('Forager (Worker/Coder) prompt', () => {
  it('targets feature learnings explicitly without implying ad-hoc context persistence', () => {
    expect(FORAGER_BEE_PROMPT).toContain(
      'hive_context_write({ feature: "<feature-name>", name: "learnings", content: "..." })',
    );
    expect(FORAGER_BEE_PROMPT).not.toContain(
      'hive_context_write({ name: "learnings", content: "..." })',
    );
    expect(FORAGER_BEE_PROMPT).toContain('For ad-hoc runs, do not call `hive_context_write` unless');
    expect(FORAGER_BEE_PROMPT).toContain('ad-hoc runs have no separate context persistence');
  });

  it('requires one meaningful task commit with a subject and body', () => {
    expect(FORAGER_BEE_PROMPT).toContain('one meaningful commit per feature task');
    expect(FORAGER_BEE_PROMPT).toContain('subject, a blank line, and a descriptive body');
    expect(FORAGER_BEE_PROMPT).toContain('message: "type(scope): concise subject\\n\\nDescribe what changed and why."');
  });

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

  it('uses hive_merge first only for merge recovery and resolves preserved conflicts locally', () => {
    expect(HIVE_HELPER_PROMPT).toContain('hive_merge');
    expect(HIVE_HELPER_PROMPT).toContain('Merge recovery / merge batch: call `hive_merge` first');
    expect(HIVE_HELPER_PROMPT).not.toContain('- use `hive_merge` first');
    expect(HIVE_HELPER_PROMPT).not.toContain('1. Call `hive_merge` first for the requested task branch.');
    expect(HIVE_HELPER_PROMPT).toContain("conflictState: 'preserved'");
    expect(HIVE_HELPER_PROMPT).toContain('resolve locally');
    expect(HIVE_HELPER_PROMPT).toContain('continue the merge batch');
  });

  it('allows state summaries and append-only manual tasks but forbids plan-backed task updates', () => {
    expect(HIVE_HELPER_PROMPT).toContain('State clarification: call `hive_status` first');
    expect(HIVE_HELPER_PROMPT).toContain('Safe manual-follow-up assistance: inspect state/boundary as needed');
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

  it('requires explicit self-descriptive hive_merge messages', () => {
    expect(HIVE_HELPER_PROMPT).toContain('Preserve one root commit per completed task');
    expect(HIVE_HELPER_PROMPT).toContain('Default to `strategy: "squash"`');
    expect(HIVE_HELPER_PROMPT).toContain('review and fix iterations into that squash commit');
    expect(HIVE_HELPER_PROMPT).toContain('subject, a blank line, and a descriptive body');
    expect(HIVE_HELPER_PROMPT).toContain('Do not use `hive`, task numbers, task folder names, run IDs, or "merge task" prose');
    expect(HIVE_HELPER_PROMPT).not.toContain('Prefer `strategy: "rebase"`');
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
  const OPERATOR_GUIDE_PATH = path.resolve(import.meta.dir, '..', '..', '..', '..', 'docs', 'OPERATOR-GUIDE.md');
  const operatorGuideContent = readFileSync(OPERATOR_GUIDE_PATH, 'utf-8');
  const HIVE_TOOLS_PATH = path.resolve(import.meta.dir, '..', '..', 'docs', 'HIVE-TOOLS.md');
  const hiveToolsContent = readFileSync(HIVE_TOOLS_PATH, 'utf-8');
  const VSCODE_README_PATH = path.resolve(import.meta.dir, '..', '..', '..', 'vscode-hive', 'README.md');
  const vscodeReadmeContent = readFileSync(VSCODE_README_PATH, 'utf-8');
  const PHILOSOPHY_PATH = path.resolve(import.meta.dir, '..', '..', '..', '..', 'PHILOSOPHY.md');
  const philosophyContent = readFileSync(PHILOSOPHY_PATH, 'utf-8');

  describe('grilling command docs alignment', () => {
    it('documents the separate-action, destination, and unavailable-research boundaries', () => {
      for (const content of [readmeContent, operatorGuideContent]) {
        expect(content).toContain('do not automatically create a plan, implement, or start follow-on work');
        expect(content).toContain('a separate operator request');
        expect(content).toContain('A named destination authorizes writing only the confirmed alignment brief there');
        expect(content).toContain('Unavailable or failed research is disclosed as unresolved or an explicit assumption');
        expect(content).toContain('never guessed');
      }

      expect(rootReadmeContent).toContain('without assuming implementation or a next command');
      expect(rootReadmeContent).toContain('implementation-brief handoff');
    });
  });

  describe('delegation planning alignment', () => {
    it('contains the heading "### Planning-mode delegation"', () => {
      expect(readmeContent).toContain('### Planning-mode delegation');
    });

    it('explains task() delegation model', () => {
      expect(readmeContent).toContain('Delegate to a researcher');
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
      expect(readmeContent).toContain('is not a custom base agent');
      expect(readmeContent).toContain('### Custom Derived Subagents');
      expect(readmeContent).toContain('`baseAgent`: one of `scout-researcher`, `forager-worker`, `plan-reviewer`, `code-reviewer`, `simplicity-reviewer`, `approach-advisor`, or `vulnerability-reviewer`');
      expect(readmeContent).not.toContain('`simplicity-reviewer` is also not a custom base agent');
      expect(readmeContent).not.toContain('`baseAgent`: one of `forager-worker`, `code-reviewer`, or `hive-helper`');
    });

    it('mentions hive-helper and simplicity-reviewer in the top-level README so users know the agents exist', () => {
      expect(rootReadmeContent).toContain('helper recovery');
      expect(rootReadmeContent).toContain('simplicity-reviewer');
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

  describe('private review runtime docs alignment', () => {
    it('documents invocation-bound multi-kind evidence and frozen path capabilities', () => {
      expect(readmeContent).toContain('`hive-dash-review-command/v3`');
      expect(readmeContent).toContain('A PR fixes Git evidence');
      expect(readmeContent).toContain('Artifact paths come only from the command packet');
      expect(readmeContent).toContain('Review roles cannot call `hive_git_snapshot` directly');
      expect(readmeContent).toContain('Inline and artifact evidence uses `ReviewEvidenceBundleService`');
      expect(readmeContent).toContain('realpaths remain inside the claimed frozen workspace');
      expect(readmeContent).toContain('this is name-based runtime trust, not a cryptographic caller identity');
      expect(readmeContent).toContain('The scope researcher can call only `hive_repositories_status`, `hive_plan_read`, `hive_status`, `hive_review_evidence_resolve`, `hive_vulnerability_compare_report_read`, `hive_review_workspace_create`, `hive_review_workspace_cleanup`');
      expect(readmeContent).toContain('vulnerability review accepts Git evidence only');
      for (const content of [readmeContent, operatorGuideContent]) {
        expect(content).toContain('32 files');
        expect(content).toContain('16 MiB per file');
        expect(content).toContain('32 MiB total');
      }
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

describe('Hive orchestration review policy', () => {
  it('routes post-batch review by risk tier without fixed specialist tables', () => {
    expect(QUEEN_BEE_PROMPT).toContain('Risk-Tier Review Routing');
    expect(QUEEN_BEE_PROMPT).toContain('public contracts, persistence/state, branch/worktree/merge lifecycle, background scheduler semantics, auth/security, or broad prompt/tool behavior');
    expect(QUEEN_BEE_PROMPT).toContain('bounded docs/tests');
    expect(QUEEN_BEE_PROMPT).toContain('verification-only gates');
    expect(QUEEN_BEE_PROMPT).toContain('named high-risk concern');
    expect(QUEEN_BEE_PROMPT).toContain('description best fits');
  });
});

describe('Hive Builder (ad-hoc orchestrator) prompt', () => {
  it('identifies role as ad-hoc orchestrator, not default implementation worker', () => {
    expect(HIVE_BUILDER_PROMPT).toContain('Hive Builder');
    expect(HIVE_BUILDER_PROMPT).toContain('ad-hoc orchestrator');
    expect(HIVE_BUILDER_PROMPT).toContain('not the default implementation worker');
    expect(HIVE_BUILDER_PROMPT).toContain('not planner-first');
  });

  it('contains default lifecycle: classify, isolate, delegate, verify, commit, merge, cleanup', () => {
    expect(HIVE_BUILDER_PROMPT).toContain('classify direct vs delegated work');
    expect(HIVE_BUILDER_PROMPT).toContain('inspect');
    expect(HIVE_BUILDER_PROMPT).toContain('isolate');
    expect(HIVE_BUILDER_PROMPT).toContain('delegate');
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
    expect(HIVE_BUILDER_PROMPT).toContain('Subagents do not inherit');
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

  const BUILDER_GATE_CLOSED_LEAK_STRINGS = [
    'task({ background: true',
    '## Background Delegation',

    'background-first scheduler mode',
    'background-delegation',
    'look for independent background lanes',
    'Gate open',
    'Gate closed',
  ] as const;

  it('keeps gate-open scheduling language out of the base Hive Builder prompt', () => {
    for (const leaked of BUILDER_GATE_CLOSED_LEAK_STRINGS) {
      expect(HIVE_BUILDER_PROMPT).not.toContain(leaked);
    }
    expect(HIVE_BUILDER_PROMPT).toContain('env-gated appendix');
    expect(HIVE_BUILDER_PROMPT).not.toContain('## Background-First Orchestration');
    expect(HIVE_BUILDER_PROMPT).not.toContain('task_status');
  });

  it('requires complete context packets and delegation units in the base prompt', () => {
    expect(HIVE_BUILDER_PROMPT).toContain('context packet');
    expect(HIVE_BUILDER_PROMPT).toContain('prior failures');
    expect(HIVE_BUILDER_PROMPT).toContain('run IDs');
    expect(HIVE_BUILDER_PROMPT).toContain('verification requirements');
    expect(HIVE_BUILDER_PROMPT).toContain('one independently answerable question or one primary goal');
    expect(HIVE_BUILDER_PROMPT).toContain('one owner, one expected output, and one verification/return contract');
  });

  it('requires write-conflict boundaries and lane tracking in the base prompt', () => {
    expect(HIVE_BUILDER_PROMPT).toContain('one active writing/change lane per owned path/module');
    expect(HIVE_BUILDER_PROMPT).toContain('Assign file/path boundaries');
    expect(HIVE_BUILDER_PROMPT).toContain('auto-abort conflicts by default');
    expect(HIVE_BUILDER_PROMPT).toContain('Track each lane');
    expect(HIVE_BUILDER_PROMPT).toContain('unresolved lanes');
  });

  it('keeps background scheduler guidance out of Builder base prompt', () => {
    expect(HIVE_BUILDER_PROMPT).not.toContain('background-first scheduler mode');
    expect(HIVE_BUILDER_PROMPT).not.toContain('## Background-First Orchestration');
    expect(HIVE_BUILDER_PROMPT).not.toContain('skill({ name: "background-delegation" })');
  });

  it('separates subagent concurrency from foreground wait mode', () => {
    expect(HIVE_BUILDER_PROMPT).toContain('Dependency decides serial vs parallel');
    expect(HIVE_BUILDER_PROMPT).toContain('Wait mode decides blocking foreground vs background');
    expect(HIVE_BUILDER_PROMPT).toContain('Blocking does not mean serial');
    expect(HIVE_BUILDER_PROMPT).toContain(
      'If several subagent tasks are independent, emit all of their `task()` calls in the same assistant message'
    );
  });

  it('limits recursive task use to one architect planning-helper level', () => {
    expect(HIVE_BUILDER_PROMPT).toContain('except a delegated `architect-planner`');
    expect(HIVE_BUILDER_PROMPT).toContain('one level of read-only planning helpers');
    expect(HIVE_BUILDER_PROMPT).toContain('those children cannot delegate');
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

  it('does not embed runtime background wait-mode details in the base prompt', () => {
    expect(HIVE_BUILDER_PROMPT).not.toContain('## Hive Builder Gate-Open Delegation');
    expect(HIVE_BUILDER_PROMPT).not.toContain('task({ background: true');
    expect(HIVE_BUILDER_PROMPT).not.toContain('## Background-First Orchestration');
  });

  it('does not keep the old equal-choice execution lifecycle wording', () => {
    expect(HIVE_BUILDER_PROMPT).toContain('classify direct vs delegated work');
    expect(HIVE_BUILDER_PROMPT).not.toContain('implement the change directly or delegate');
    expect(HIVE_BUILDER_PROMPT).not.toContain('Inspect, isolate, implement directly or delegate');
  });
});

describe('Primary orchestration direct-work boundaries', () => {
  it('aligns Hive, Swarm, and Hive Builder on direct-work threshold and task-DAG preservation', () => {
    for (const [name, prompt] of [
      ['Hive', QUEEN_BEE_PROMPT],
      ['Swarm', SWARM_BEE_PROMPT],
      ['Hive Builder', HIVE_BUILDER_PROMPT],
    ] as const) {
      expect(prompt, name).toContain('Direct work is allowed only for coordination/setup');
      expect(prompt, name).toContain('exactly one bounded read');
      expect(prompt, name).toContain('exactly one bounded write/patch');
      expect(prompt, name).toContain('one cheap final check');
      expect(prompt, name).toContain('Anything requiring 2+ reads, 2+ patches, tests/debug loops');
      expect(prompt, name).toContain('behavior-contract changes');
    }
    for (const [name, prompt] of [
      ['Hive', QUEEN_BEE_PROMPT],
      ['Swarm', SWARM_BEE_PROMPT],
    ] as const) {
      expect(prompt.toLowerCase(), name).toContain('one implementation assignment normally maps to one numbered task');
      expect(prompt, name).toContain('append-only manual task');
    }
    expect(QUEEN_BEE_PROMPT).toContain('tightly coupled code, tests, docs, and multiple files');
  });

  it('documents worker-branch task granularity for planning prompts', () => {
    for (const [name, prompt] of [
      ['Hive', QUEEN_BEE_PROMPT],
      ['Architect', ARCHITECT_BEE_PROMPT],
    ] as const) {
      expect(prompt, name).toContain('numbered tasks are worker-branch units, not micro-steps');
      expect(prompt, name).toContain('Split by dependency, path ownership, verification boundary, or independently deliverable behavior');
      expect(prompt, name).toContain('Reads, runs, and commits are steps inside a task');
      expect(prompt, name).toContain('Typical plan has roughly 3-12 tasks');
    }
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
