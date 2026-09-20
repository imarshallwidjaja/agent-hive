import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import * as path from 'path';
import { assertRequiredContextMetadata, parseContextMetadata } from 'hive-core';
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
import { HIVE_SYSTEM_PROMPT } from '../hooks/system-hook';
import { ENGINEERING_JUDGMENT_PROMPT } from './engineering-judgment';
import { NATIVE_TASK_CONTINUATION_POLICY_PROMPT, PROCESS_JUDGMENT_PROMPT, REPOSITORY_WORKTREE_POLICY_PROMPT } from './process-judgment';

const STANDING_CONSTRAINTS_HEADING = '## Standing Constraints (operator, session-wide)';

function countOccurrences(content: string, needle: string): number {
  return content.split(needle).length - 1;
}

function sectionBetween(prompt: string, startHeading: string, endHeading: string): string {
  const start = prompt.indexOf(`${startHeading}\n`);
  const end = prompt.indexOf(endHeading, start + startHeading.length);
  return start >= 0 && end >= 0 ? prompt.slice(start, end) : '';
}

function tableRow(section: string, label: string): string {
  return section.split('\n').find((line) => line.startsWith(`| ${label} |`)) ?? '';
}

describe('Engineering judgment prompt reach', () => {
  const includedPrompts = [
    ['Hive', QUEEN_BEE_PROMPT],
    ['Architect', ARCHITECT_BEE_PROMPT],
    ['Swarm', SWARM_BEE_PROMPT],
    ['Hive Builder', HIVE_BUILDER_PROMPT],
    ['Forager', FORAGER_BEE_PROMPT],
    ['Plan Reviewer', PLAN_REVIEWER_PROMPT],
    ['Code Reviewer', CODE_REVIEWER_PROMPT],
    ['Simplicity Reviewer', SIMPLICITY_REVIEWER_PROMPT],
    ['Approach Advisor', APPROACH_ADVISOR_PROMPT],
    ['Dash Reviewer', DASH_REVIEWER_PROMPT],
  ] as const;

  const omittedPrompts = [
    ['Scout', SCOUT_BEE_PROMPT],
    ['Hive Helper', HIVE_HELPER_PROMPT],
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

  it('starts from present need and preserves meaningful safety and ownership boundaries', () => {
    for (const requirement of [
      'present need before adding machinery',
      'call sites and sibling routes',
      'owning boundary',
      'stdlib/native or an already-installed dependency',
      'cognitive load',
      'meaningful one-caller boundaries',
      'make valid use clear and misuse difficult',
      'abstractions, fallbacks, options, validation, and comments',
      'security, accessibility, data integrity',
      'public contracts',
      'required or mission-selected verification',
      'cross-package/monorepo changes',
      'affected packages, generated artifacts, public contracts, and verification ownership',
      'guessed savings',
    ]) {
      expect(ENGINEERING_JUDGMENT_PROMPT.toLowerCase(), requirement).toContain(requirement.toLowerCase());
    }
  });

  it('places each test invariant in one canonical suite in the same change', () => {
    expect(ENGINEERING_JUDGMENT_PROMPT).toContain('canonical suite');
    expect(ENGINEERING_JUDGMENT_PROMPT).toContain('not in a later cleanup pass');
  });

  it('anchors role-specific application at existing decision points', () => {
    expect(ARCHITECT_BEE_PROMPT).toContain('Use Engineering Judgment to make requested behavior, call-site contracts, ownership boundaries');
    expect(QUEEN_BEE_PROMPT).toContain('Require the Architect handoff');
    expect(QUEEN_BEE_PROMPT).toContain('material planning, orchestration, and review-routing decisions');
    expect(FORAGER_BEE_PROMPT).toContain('Apply Engineering Judgment during PLAN and VERIFY');
    expect(PLAN_REVIEWER_PROMPT).toContain('Apply Engineering Judgment only as an execution-readiness lens');
    expect(CODE_REVIEWER_PROMPT).toContain('Apply Engineering Judgment to the changed scope');
    expect(SIMPLICITY_REVIEWER_PROMPT).toContain('total cognitive burden and ownership clarity');
    expect(SWARM_BEE_PROMPT).toContain('Apply Engineering Judgment to decomposition, worker handoffs, and integration');
    expect(SWARM_BEE_PROMPT).toContain('does not grant authority to implement');
    expect(HIVE_BUILDER_PROMPT).toContain('Apply Engineering Judgment to lane decomposition, specialist handoffs, and integration');
    expect(HIVE_BUILDER_PROMPT).toContain('does not grant authority to implement');
    expect(APPROACH_ADVISOR_PROMPT).toContain('Apply Engineering Judgment to implementation route selection');
    expect(APPROACH_ADVISOR_PROMPT).toContain('explicit justification for new libraries, services, or infrastructure');
    expect(DASH_REVIEWER_PROMPT).toContain('Apply Engineering Judgment to reviewer selection and finding synthesis');
    expect(FORAGER_BEE_PROMPT).toContain(
      'Place each new test invariant in the canonical owning suite in this change and fold weaker duplicates before commit',
    );
    expect(ARCHITECT_BEE_PROMPT).toContain(
      'When tests are selected, name the invariant, owning layer, and canonical suite',
    );
    expect(ARCHITECT_BEE_PROMPT).toContain('do not add a later test-cleanup task');
    expect(QUEEN_BEE_PROMPT).toContain(
      'When tests are selected, require invariant, owning-layer, and canonical-suite placement',
    );
    expect(CODE_REVIEWER_PROMPT).toContain(
      'Flag extra or weaker tests that repeat the same invariant outside the canonical owner',
    );
    expect(SIMPLICITY_REVIEWER_PROMPT).toContain(
      'Fold or delete weaker tests that repeat an invariant already owned by the canonical suite',
    );
  });
});

describe('Process judgment prompt reach', () => {
  const primaryPrompts = [
    ['Hive', QUEEN_BEE_PROMPT],
    ['Architect', ARCHITECT_BEE_PROMPT],
    ['Swarm', SWARM_BEE_PROMPT],
    ['Hive Builder', HIVE_BUILDER_PROMPT],
  ] as const;

  const reviewerPrompts = [
    ['Plan Reviewer', PLAN_REVIEWER_PROMPT],
    ['Code Reviewer', CODE_REVIEWER_PROMPT],
    ['Simplicity Reviewer', SIMPLICITY_REVIEWER_PROMPT],
    ['Approach Advisor', APPROACH_ADVISOR_PROMPT],
    ['Dash Reviewer', DASH_REVIEWER_PROMPT],
    ['Vulnerability Review Primary', VULNERABILITY_REVIEW_PRIMARY_PROMPT],
    ['Vulnerability Reviewer', VULNERABILITY_REVIEWER_PROMPT],
  ] as const;

  it('includes the canonical fragment exactly once in planning and orchestration roles', () => {
    for (const [name, prompt] of primaryPrompts) {
      expect(countOccurrences(prompt, PROCESS_JUDGMENT_PROMPT), name).toBe(1);
    }
  });

  it('keeps the fragment out of specialist reviewer contracts', () => {
    for (const [name, prompt] of reviewerPrompts) {
      expect(prompt, name).not.toContain(PROCESS_JUDGMENT_PROMPT);
    }
  });

  it('defines concise input classification and process reassessment', () => {
    expect(PROCESS_JUDGMENT_PROMPT.split('\n').length).toBeLessThanOrEqual(12);
    expect(PROCESS_JUDGMENT_PROMPT).toContain('operator requirements');
    expect(PROCESS_JUDGMENT_PROMPT).toContain('applicable project constraints');
    expect(PROCESS_JUDGMENT_PROMPT).toContain('specialist advice or findings');
    expect(PROCESS_JUDGMENT_PROMPT).toContain('agent-chosen procedure');
    expect(PROCESS_JUDGMENT_PROMPT).toContain('deterministic safety gates');
    expect(PROCESS_JUDGMENT_PROMPT).toContain('role contracts');
    expect(PROCESS_JUDGMENT_PROMPT).toContain('phase routing');
    expect(PROCESS_JUDGMENT_PROMPT).toContain('direct-work and delegation boundaries');
    expect(PROCESS_JUDGMENT_PROMPT).toContain("specialist's output contract");
    expect(PROCESS_JUDGMENT_PROMPT).toContain('churn or delay without reducing a named risk');
    expect(PROCESS_JUDGMENT_PROMPT).toContain('never waive those boundaries');
    expect(PROCESS_JUDGMENT_PROMPT).not.toContain('complexity-review');
    expect(PROCESS_JUDGMENT_PROMPT).not.toContain('complexity-audit');
    expect(DASH_REVIEWER_PROMPT).not.toContain('complexity-review');
    expect(DASH_REVIEWER_PROMPT).not.toContain('complexity-audit');
  });

  it('anchors role-specific planning and review decisions', () => {
    expect(ARCHITECT_BEE_PROMPT).toContain('Advice, comparison, explanation, and retrieval requests remain conversation-scoped');
    expect(ARCHITECT_BEE_PROMPT).toContain('For implementation requests, "Do X" means "create plan for X"');
    expect(ARCHITECT_BEE_PROMPT).not.toContain('PLANNER, NOT IMPLEMENTER. "Do X" means');
    expect(ARCHITECT_BEE_PROMPT).toContain('| Trivial implementation | Single file, <10 lines | Quick assessment | Create a concise plan; never implement |');
    expect(ARCHITECT_BEE_PROMPT).toContain('| Retrieval | Source facts, code/context tracing, external data | Retrieve bounded evidence | Return findings without creating planning state |');
    expect(ARCHITECT_BEE_PROMPT).toContain('Complete the requested advice, comparison, explanation, or retrieval');
    expect(ARCHITECT_BEE_PROMPT).toContain('During planning, NEVER end with:');
    expect(ARCHITECT_BEE_PROMPT).not.toContain('Create draft on first exchange');
    expect(ARCHITECT_BEE_PROMPT).not.toContain('Self-Clearance Check (After Every Exchange)');
    const phaseStart = QUEEN_BEE_PROMPT.indexOf('## Phase Detection (First Action)');
    const intentStart = QUEEN_BEE_PROMPT.indexOf('### Intent Classification');
    const boundaryStart = QUEEN_BEE_PROMPT.indexOf('### Direct vs Delegated Work');
    const intentSection = sectionBetween(
      QUEEN_BEE_PROMPT,
      '### Intent Classification',
      '### Canonical Delegation Threshold',
    );
    const boundarySection = sectionBetween(QUEEN_BEE_PROMPT, '### Direct vs Delegated Work', '### Delegation');

    expect(phaseStart).toBeGreaterThanOrEqual(0);
    expect(phaseStart).toBeLessThan(intentStart);
    expect(intentStart).toBeLessThan(boundaryStart);
    expect(QUEEN_BEE_PROMPT.slice(phaseStart, intentStart)).toContain(
      'A featureless implementation request such as "build X" or "implement X" enters Planning and creates the feature and plan before execution.',
    );
    expect(QUEEN_BEE_PROMPT.slice(phaseStart, intentStart)).toContain(
      'Direct work never bypasses plan-first routing',
    );
    expect(tableRow(intentSection, 'Trivial')).toMatch(
      /After phase routing.*direct work or delegation.*featureless implementation enters Planning first/
    );
    expect(tableRow(intentSection, 'Simple')).toMatch(
      /After phase routing.*direct work or delegation.*featureless implementation enters Planning first/
    );
    expect(tableRow(intentSection, '"Quick change"')).toMatch(/After phase routing/);
    expect(boundarySection).toMatch(
      /After phase routing.*Feature implementation can use direct work only after an approved plan has selected the work; it never selects or bypasses feature planning\./,
    );
    expect(QUEEN_BEE_PROMPT).toContain('| No feature + plan or implementation requested | Planning | Create feature and plan; use Planning section |');
    expect(QUEEN_BEE_PROMPT).toContain('| User requests execution of an approved plan | Orchestration | Use Orchestration section |');
    for (const [name, prompt] of [
      ['Hive', QUEEN_BEE_PROMPT],
      ['Swarm', SWARM_BEE_PROMPT],
    ] as const) {
      expect(prompt, name).toContain('Apply Process Judgment before choosing a route.');
    }
  });

  it('keeps Hive turn termination in one scoped section', () => {
    expect(QUEEN_BEE_PROMPT.match(/^#{2,3} .*Termination$/gm)).toEqual(['### Turn Termination']);
    const terminationSection = sectionBetween(QUEEN_BEE_PROMPT, '### Turn Termination', '**User Input:**');

    expect(terminationSection).toContain(
      'Conversation-scoped advice, comparison, explanation, and retrieval may end with the completed answer or findings.',
    );
    expect(terminationSection).toContain(
      'Planning and orchestration turns must end with a concrete next action',
    );
    expect(terminationSection).toContain('explicit wait for background work');
    expect(terminationSection).toContain('`question()` call');
    expect(QUEEN_BEE_PROMPT).not.toContain('### Anti-Patterns');
    expect(QUEEN_BEE_PROMPT).not.toContain('Valid endings:');
    expect(QUEEN_BEE_PROMPT).not.toContain('NEVER end with:');
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

describe('Operator standing constraints prompt guidance', () => {
  const constraintAwareReviewers = [
    ['Plan Reviewer', PLAN_REVIEWER_PROMPT],
    ['Code Reviewer', CODE_REVIEWER_PROMPT],
    ['Simplicity Reviewer', SIMPLICITY_REVIEWER_PROMPT],
  ] as const;

  it('names the injected heading in reviewer and worker prompts', () => {
    expect(FORAGER_BEE_PROMPT).toContain('## Standing Constraints');
    expect(FORAGER_BEE_PROMPT).not.toContain(STANDING_CONSTRAINTS_HEADING);
    for (const [name, prompt] of constraintAwareReviewers) {
      expect(prompt, name).toContain(STANDING_CONSTRAINTS_HEADING);
    }
  });

  it('keeps the constraint register out of reviewer and worker tool guidance', () => {
    for (const [name, prompt] of [
      ['Forager', FORAGER_BEE_PROMPT],
      ['Scout', SCOUT_BEE_PROMPT],
      ...constraintAwareReviewers,
    ] as const) {
      expect(prompt, name).not.toContain('hive_constraints_');
    }
  });

  it('lets Foragers write both context scopes through hash integrity and keeps Scout read-only', () => {
    expect(FORAGER_BEE_PROMPT).toContain('Foragers write feature and project context through hash integrity');
    expect(FORAGER_BEE_PROMPT).toContain('Scout is read-only');
    expect(FORAGER_BEE_PROMPT).not.toContain('Propose project-context updates');
    expect(QUEEN_BEE_PROMPT).toContain('Foragers and reviewers write feature and project context through hash integrity');
    expect(QUEEN_BEE_PROMPT).not.toContain('Workers propose project updates');
    expect(SWARM_BEE_PROMPT).not.toContain('Workers propose project updates');
    expect(SCOUT_BEE_PROMPT).toContain('Read with `hive_context_read` only');
  });

  it('guides orchestrators through add, read-before-edit, and explicit clear semantics', () => {
    for (const [name, prompt] of [
      ['Hive', QUEEN_BEE_PROMPT],
      ['Architect', ARCHITECT_BEE_PROMPT],
      ['Swarm', SWARM_BEE_PROMPT],
      ['Hive Builder', HIVE_BUILDER_PROMPT],
    ] as const) {
      expect(prompt, name).toContain('hive_constraints_add');
      expect(prompt, name).toContain('hive_constraints_read');
      expect(prompt, name).toContain('hive_constraints_edit');
      expect(prompt, name).toContain('hive_constraints_clear');
      expect(prompt, name).toContain('every user message, example, or task-local request');
      expect(prompt, name).toContain('only when the operator explicitly requests a whole-register clear');
      expect(prompt, name).toContain('Only primaries can add, edit, or clear');
      expect(prompt, name).toContain('Workers receive the injected register and may read it');
    }
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

describe('Multi-plan feature routing guidance', () => {
  it('uses one selected-before-detected route for omitted tools and child dispatch', () => {
    for (const [name, prompt] of [
      ['Hive', QUEEN_BEE_PROMPT],
      ['Swarm', SWARM_BEE_PROMPT],
    ] as const) {
      expect(prompt, name).toContain('Selected session route governs omitted feature-scoped calls before detected context');
      expect(prompt, name).toContain('Explicit feature arguments target only that tool call');
      expect(prompt, name).toContain('immediately before native `task()` dispatch');
      expect(prompt, name).toContain('one feature per worker assignment');
      expect(prompt, name).toContain('hive_worktree_create({ feature: "feature-name", task: "01-task-name" })');
    }
  });

  it('gates cross-feature prerequisites at execution rather than plan approval', () => {
    for (const [name, prompt] of [
      ['Hive', QUEEN_BEE_PROMPT],
      ['Swarm', SWARM_BEE_PROMPT],
    ] as const) {
      expect(prompt, name).toContain('Cross-feature prerequisites block affected execution tasks or lanes, not plan approval');
      expect(prompt, name).toContain('Unresolved plan comments still block approval');
      expect(prompt, name).toContain('Do not infer or create automatic cross-feature dependencies');
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
    ['Architect', ARCHITECT_BEE_PROMPT],
    ['Swarm', SWARM_BEE_PROMPT],
    ['Hive Builder', HIVE_BUILDER_PROMPT],
    ['Dash Reviewer', DASH_REVIEWER_PROMPT],
    ['Vulnerability Review Primary', VULNERABILITY_REVIEW_PRIMARY_PROMPT],
  ] as const;

  it('applies terminal handoffs and fresh follow-up sessions to every primary prompt', () => {
    for (const [name, prompt] of primaryPrompts) {
      expect(prompt, name).toContain('one primary goal');
      expect(prompt, name).toContain('one terminal handoff');
      expect(prompt, name).toContain('tightly coupled code, tests, docs, and multiple files');
      expect(prompt, name).toContain('Every returned result is a terminal handoff');
      expect(prompt, name).toContain('Every follow-up after a returned result uses a fresh child session');
      expect(prompt, name).toContain('Review findings are fresh assignments in the same implementation lane');
      for (const result of [
        'completed',
        'failed',
        'empty',
        'partial',
        'blocked',
        'unsatisfactory',
        'review-remediation',
        'retry',
        'new-test-evidence',
        'operator-decision',
      ]) {
        expect(prompt, name).toContain(result);
      }
    }
  });

  it('reserves task_id for explicit interruption recovery and rejects inferred continuation', () => {
    for (const [name, prompt] of primaryPrompts) {
      expect(countOccurrences(prompt, NATIVE_TASK_CONTINUATION_POLICY_PROMPT), name).toBe(1);
      expect(prompt, name).toContain('Primaries must not pass `task_id` or infer continuation eligibility from task output');
      expect(prompt, name).toContain('Preserve native `task_id` pass-through only for an explicit operator instruction or an explicit runtime-owned interruption-recovery mechanism');
      expect(prompt, name).toContain('Without that authorization, launch a fresh child');
      expect(prompt, name).toContain('If the child may still be active or its lifecycle is uncertain');
      expect(prompt, name).toContain('Compaction re-anchoring of a currently running worker is distinct from follow-up work');
      expect(prompt, name).toContain('Trace semantic recovery is untrusted and cannot authorize continuation');
    }
  });

  it('distinguishes feature continuation, retry, and compaction from re-delegation', () => {
    for (const [name, prompt] of [
      ['Hive', QUEEN_BEE_PROMPT],
      ['Swarm', SWARM_BEE_PROMPT],
      ['Hive Builder', HIVE_BUILDER_PROMPT],
    ] as const) {
      expect(prompt, name).toContain('concise self-contained handoff');
    }

    for (const [name, prompt] of [
      ['Hive', QUEEN_BEE_PROMPT],
      ['Swarm', SWARM_BEE_PROMPT],
    ] as const) {
      expect(prompt, name).toContain('explicit status leaving blocked clears the blocker');
      expect(prompt, name).toContain('Do not reconstruct blocker details from worker prose or task traces');
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
      expect(prompt, name).toContain('untrusted context coverage');
      expect(prompt, name).toContain('Never accept, merge, retry, resume, or auto-run');
    }
  });
});

describe('Active native-task guidance contradiction checks', () => {
  const workspaceRoot = path.resolve(import.meta.dir, '..', '..', '..', '..');
  const activeGuidanceFiles = [
    'AGENTS.md',
    'CHANGELOG.md',
    'docs/OPERATOR-GUIDE.md',
    'packages/hive-core/templates/skills/hive.md',
    'packages/opencode-hive/README.md',
    'packages/opencode-hive/docs/HIVE-TOOLS.md',
    'packages/opencode-hive/skills/background-delegation/SKILL.md',
    'packages/opencode-hive/skills/dispatching-parallel-agents/SKILL.md',
    'packages/opencode-hive/skills/executing-plans/SKILL.md',
    'packages/opencode-hive/skills/orchestrating-ad-hoc-work/SKILL.md',
    'packages/opencode-hive/skills/parallel-exploration/SKILL.md',
    'packages/opencode-hive/src/agents/architect.ts',
    'packages/opencode-hive/src/agents/hive-helper.ts',
    'packages/opencode-hive/src/agents/hive.ts',
    'packages/opencode-hive/src/agents/hive-builder.ts',
    'packages/opencode-hive/src/agents/process-judgment.ts',
    'packages/opencode-hive/src/agents/swarm.ts',
    'packages/opencode-hive/src/commands/command-bodies.ts',
    'packages/opencode-hive/src/commands/renderers.ts',
    'packages/opencode-hive/src/task-trace.ts',
    'docs/DESIGN.md',
  ] as const;
  const forbiddenPhrases = [
    'After any usable terminal handoff',
    'after any usable terminal handoff',
    'no usable terminal handoff',
    'the child is confirmed stopped',
    'Retry or resume native workers directly',
    'delegated, resumed, or',
    'A resumed child may create multiple launch observations',
  ] as const;

  it('has no stale broad-resume guidance on active surfaces', () => {
    for (const relativePath of activeGuidanceFiles) {
      const content = readFileSync(path.join(workspaceRoot, relativePath), 'utf-8');
      for (const phrase of forbiddenPhrases) {
        expect(content, `${relativePath}: ${phrase}`).not.toContain(phrase);
      }
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
    expect(QUEEN_BEE_PROMPT).toContain('Direct vs Delegated Work');
    expect(SWARM_BEE_PROMPT).toContain('Direct vs Delegated Work');
  });
});

describe('Scout operating contract', () => {
  it('owns retrieval and evidence summaries without taking over causal or design reasoning', () => {
    expect(SCOUT_BEE_PROMPT).toContain('Scout owns internal and external code, context, and data retrieval');
    expect(SCOUT_BEE_PROMPT).toContain('concise factual summaries and deduplication');
    expect(SCOUT_BEE_PROMPT).toContain('direct call and reference tracing');
    expect(SCOUT_BEE_PROMPT).toContain('conflicting source evidence');
    expect(SCOUT_BEE_PROMPT).toContain('attributed source recommendations');
    expect(SCOUT_BEE_PROMPT).toContain('Do not diagnose the cause of an observed failure');
    expect(SCOUT_BEE_PROMPT).toContain('Do not decide source applicability, tradeoffs, or a solution');
    expect(SCOUT_BEE_PROMPT).toContain('retrieve bounded relevant evidence and state what reasoning remains for the caller');
    expect(SCOUT_BEE_PROMPT).not.toContain('Actual Need:');
    expect(SCOUT_BEE_PROMPT).not.toContain('| COMPREHENSIVE | Multi-source synthesis');
  });

  it('returns compact evidence packets with provenance, limits, contradictions, and retrieval gaps', () => {
    for (const requirement of [
      'source paths or URLs with excerpts for decisive facts',
      'searched scope, limitations, and unknowns',
      'contradictions when relevant',
      'next retrieval gaps, not fix recommendations',
    ]) {
      expect(SCOUT_BEE_PROMPT).toContain(requirement);
    }
    expect(SCOUT_BEE_PROMPT).toContain('Do not emit empty sections or raw dumps');
  });

  it('enforces a read-only contract', () => {
    expect(SCOUT_BEE_PROMPT).toContain('### Read-Only Contract');
    expect(SCOUT_BEE_PROMPT).toContain('Scout must never modify project state');
  });

  it('prohibits file writes, temp files, and state-changing commands', () => {
    expect(SCOUT_BEE_PROMPT).toContain('No file edits, creation, or deletion');
    expect(SCOUT_BEE_PROMPT).toContain('No temporary files');
    expect(SCOUT_BEE_PROMPT).toContain('No state-changing shell commands');
  });

  it('defines an evidence-oriented search order without a local-first ladder', () => {
    expect(SCOUT_BEE_PROMPT).toContain('### Evidence-Oriented Search Order');
    expect(SCOUT_BEE_PROMPT).toContain('Start from the evidence the question requires');
    expect(SCOUT_BEE_PROMPT).toContain('first-party, version-relevant documentation');
    expect(SCOUT_BEE_PROMPT).toContain('return the named evidence gap');
  });

  it('includes speed and efficiency rules', () => {
    expect(SCOUT_BEE_PROMPT).toContain('### Speed and Efficiency');
    expect(SCOUT_BEE_PROMPT).toContain('independent evidence');
    expect(SCOUT_BEE_PROMPT).toContain('answer immediately');
  });

  it('includes synthesis rules prohibiting speculation about unread files', () => {
    expect(SCOUT_BEE_PROMPT).toContain('## Synthesis Rules');
    expect(SCOUT_BEE_PROMPT).toContain('do not speculate about its contents');
    expect(SCOUT_BEE_PROMPT).toContain('concise factual summary');
  });

  it('forbids Scout from delegating or orchestrating other agents', () => {
    expect(SCOUT_BEE_PROMPT).toContain('Do not delegate or orchestrate other agents');
  });

  it('answers only the assigned primary question and returns partial findings before expanding scope', () => {
    expect(SCOUT_BEE_PROMPT).toContain('Answer the assigned primary question');
    expect(SCOUT_BEE_PROMPT).toContain('Follow subordinate evidence needed to answer it');
    expect(SCOUT_BEE_PROMPT).toContain('Do not investigate adjacent questions');
    expect(SCOUT_BEE_PROMPT).toContain('next retrieval gaps');
    expect(SCOUT_BEE_PROMPT).toMatch(/return partial findings if further progress requires scope expansion/i);
  });
});

describe('Forager verification and tool-scope clarity', () => {
  it('keeps diagnosis-only assignments report-only', () => {
    expect(FORAGER_BEE_PROMPT).toContain('Diagnosis-only');
    expect(FORAGER_BEE_PROMPT).toContain('evidence, hypotheses tested and untested');
    expect(FORAGER_BEE_PROMPT).toContain('supported conclusion or unresolved status');
    expect(FORAGER_BEE_PROMPT).toContain('does not authorize fixes, edits, commits, or destructive reproduction');
    expect(FORAGER_BEE_PROMPT).toContain('ad-hoc or other standalone assignment');
    expect(FORAGER_BEE_PROMPT).toContain('managed feature task');
    expect(FORAGER_BEE_PROMPT).toContain('only when the mission authorizes implementation');
    expect(FORAGER_BEE_PROMPT).toContain('Never revert unrelated or user changes');
    expect(FORAGER_BEE_PROMPT).toContain('Return the blocker, evidence, options, and recommendation');
    expect(FORAGER_BEE_PROMPT).toContain('Do not call `hive_task_update` to leave blocked');
    expect(FORAGER_BEE_PROMPT).toContain('Keep report-only diagnostic discoveries in the terminal handoff');
    expect(FORAGER_BEE_PROMPT).toContain('unless the mission explicitly authorizes metadata persistence');
    expect(FORAGER_BEE_PROMPT).toContain('Worker prose is report input');
  });

  it('defers tool scope to worker prompt', () => {
    expect(FORAGER_BEE_PROMPT).toContain('tool access is scoped to your role');
    expect(FORAGER_BEE_PROMPT).toContain('worker prompt');
  });

  it('records observed output in verification step', () => {
    expect(FORAGER_BEE_PROMPT).toContain('Record observed output');
    expect(FORAGER_BEE_PROMPT).toContain('do not substitute explanation for execution');
  });

  it('uses exposed research capabilities and reports missing ones', () => {
    expect(FORAGER_BEE_PROMPT).toContain('Use existing research capabilities');
    expect(FORAGER_BEE_PROMPT).toContain('Select them through the shared capability contract');
    expect(FORAGER_BEE_PROMPT).toContain('report the evidence gap and continue only independent work');
    expect(FORAGER_BEE_PROMPT).toContain('structural or language-aware inspection');
  });
});

describe('Primary retrieval and reasoning ownership', () => {
  const primaryPrompts = [
    ['Hive', QUEEN_BEE_PROMPT],
    ['Architect', ARCHITECT_BEE_PROMPT],
    ['Swarm', SWARM_BEE_PROMPT],
    ['Hive Builder', HIVE_BUILDER_PROMPT],
  ] as const;

  it('routes by requested output and keeps diagnosis and decisions with the parent', () => {
    for (const [name, prompt] of primaryPrompts) {
      expect(prompt, name).toContain('Route by the requested output');
      expect(prompt, name).toContain('not by whether the work is read-only or whether file paths are known');
      expect(prompt, name).toContain('Scout retrieves source evidence');
      expect(prompt, name).toContain('causal diagnosis');
      expect(prompt, name).toContain('applicability and tradeoff decisions');
      expect(prompt, name).toContain('solution selection');
      expect(prompt, name).toContain('source observations from hypotheses');
      expect(prompt, name).toContain('runtime behavior or only a possible path');
      expect(prompt, name).toContain('plausible alternatives');
      expect(prompt, name).toContain('final confidence');
      expect(prompt, name).toContain('report-only mission');
    }

    for (const [name, prompt] of [
      ['Hive', QUEEN_BEE_PROMPT],
      ['Swarm', SWARM_BEE_PROMPT],
      ['Hive Builder', HIVE_BUILDER_PROMPT],
    ] as const) {
      expect(prompt, name).toContain('best-fit available Forager or advisor');
      expect(prompt, name).toContain('unless implementation is separately authorized');
    }

    expect(ARCHITECT_BEE_PROMPT).toContain('best-fit permitted read-only advisor');
    expect(ARCHITECT_BEE_PROMPT).toContain('Do not launch a Forager or other execution worker');
    expect(ARCHITECT_BEE_PROMPT).toContain('hand execution diagnosis that requires state changes back to the primary orchestrator');
  });

  it('uses Scouts for real evidence gaps without quotas or recursive verification', () => {
    for (const [name, prompt] of primaryPrompts) {
      expect(prompt, name).toContain('real evidence gap');
      expect(prompt, name).toContain('independent useful retrieval slices together');
      expect(prompt, name).toContain('Do not impose numeric quotas or artificial fan-out');
      expect(prompt, name).toContain('Reasoning over returned excerpts is coordination');
      expect(prompt, name).toContain('A direct source spot-check remains a bounded read');
      expect(prompt, name).toContain('delegate additional retrieval only for a named evidence gap');
      expect(prompt, name).toContain('Do not recursively delegate Scout verification');
    }
  });

  it('keeps advisory decisions with Hive while preserving material operator clarification', () => {
    expect(QUEEN_BEE_PROMPT).toContain('reason and advise as parent');
    expect(QUEEN_BEE_PROMPT).toContain('ask the operator only when material ambiguity remains');
  });
});

describe('Role-specific capability guidance', () => {
  it('keeps Scout and Swarm guidance capability-based', () => {
    expect(SCOUT_BEE_PROMPT).toContain('Use the shared capability-selection contract');
    expect(SCOUT_BEE_PROMPT).toContain('Do not improvise a substitute');
    expect(SWARM_BEE_PROMPT).toContain('Describe each research assignment by operation, required source authority and freshness');
    expect(SWARM_BEE_PROMPT).toContain('the child selects among capabilities exposed in its own session');
    expect(SWARM_BEE_PROMPT).toContain('Do not prescribe provider or tool IDs');
  });
});

describe('Specialized reviewer prompts', () => {
  it('keeps vulnerability review orchestration and evidence review in separate no-fix roles', () => {
    expect(VULNERABILITY_REVIEW_PRIMARY_PROMPT).toContain('read-only primary security review orchestrator');
    expect(VULNERABILITY_REVIEW_PRIMARY_PROMPT).toContain('Do not edit source');
    expect(VULNERABILITY_REVIEW_PRIMARY_PROMPT).toContain('Do not silently skip');
    expect(VULNERABILITY_REVIEWER_PROMPT).toContain('attacker-controlled input or capabilities');
    expect(VULNERABILITY_REVIEWER_PROMPT).toContain('concrete impact');
    expect(VULNERABILITY_REVIEWER_PROMPT).toContain('Do not edit or create files');
    expect(VULNERABILITY_REVIEWER_PROMPT).toContain('Do not delegate');
    expect(VULNERABILITY_REVIEWER_PROMPT).toContain('Do not propose or apply a patch');
  });

  it('keeps dash-reviewer as a read-only review orchestrator rather than a reviewer or fixer', () => {
    expect(DASH_REVIEWER_PROMPT).toContain('review orchestrator');
    expect(DASH_REVIEWER_PROMPT).toContain('untrusted data');
    expect(DASH_REVIEWER_PROMPT).toContain('Do not edit implementation files');
    expect(DASH_REVIEWER_PROMPT).toContain('Do not silently skip');
  });

  it('keeps provider-specific workflow details out of the dash reviewer prompt', () => {
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
    it('contains output-based canonical delegation guidance', () => {
      expect(QUEEN_BEE_PROMPT).toContain('### Canonical Delegation Threshold');
      expect(QUEEN_BEE_PROMPT).toContain('Route by the requested output');
      expect(QUEEN_BEE_PROMPT).toContain('Bounded direct reads remain allowed');
    });

    it('contains read-only exploration is allowed', () => {
      expect(QUEEN_BEE_PROMPT).toContain('Read-only exploration is allowed');
    });

    it('routes qualifying unified ad-hoc work through the orchestration skill before preparation', () => {
      expect(QUEEN_BEE_PROMPT).toContain('load `orchestrating-ad-hoc-work`');
      expect(QUEEN_BEE_PROMPT).toContain('multiple independently verifiable outcomes');
      expect(QUEEN_BEE_PROMPT).toContain('dependency waves');
      expect(QUEEN_BEE_PROMPT).toContain('shared write/runtime resources');
      expect(QUEEN_BEE_PROMPT).toContain('possible background execution');
      expect(QUEEN_BEE_PROMPT).toContain('more than one worker attempt or turn');
      expect(QUEEN_BEE_PROMPT).toContain('before any ad-hoc worktree create');
      expect(QUEEN_BEE_PROMPT).toContain('or delegated dispatch');
    });

    it('does NOT contain the old planning iron law "Don\'t execute - plan only"', () => {
      expect(QUEEN_BEE_PROMPT).not.toContain("- Don't execute - plan only");
    });

    it('separates subagent concurrency from foreground wait mode', () => {
      expect(QUEEN_BEE_PROMPT).toContain('Dependency decides serial vs parallel');
      expect(QUEEN_BEE_PROMPT).toContain('Wait mode decides blocking foreground vs background');
      expect(QUEEN_BEE_PROMPT).toContain('Blocking does not mean serial');
      expect(QUEEN_BEE_PROMPT).toContain(
        'If several exempt non-Forager tasks are independent, emit their ordinary Scout, advisor, or reviewer `task()` calls in the same assistant message'
      );
    });

    it('includes internal codebase evidence in Retrieval intent', () => {
      expect(QUEEN_BEE_PROMPT).toContain('Source facts, code/context tracing, external data');
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

    it('records blocked status then clears the blocker on an explicit leaving status', () => {
      expect(QUEEN_BEE_PROMPT).toContain('hive_task_update');
      expect(QUEEN_BEE_PROMPT).toContain('explicit status leaving blocked clears the blocker');
      expect(QUEEN_BEE_PROMPT).toContain('question()');
      expect(QUEEN_BEE_PROMPT).not.toContain('continueFrom: "blocked"');
      expect(QUEEN_BEE_PROMPT).not.toContain('continueFromBlocked');
    });

    it('directs executor primaries to repository-backed worktree placement', () => {
      for (const [name, prompt] of [
        ['Hive', QUEEN_BEE_PROMPT],
        ['Swarm', SWARM_BEE_PROMPT],
        ['Hive Builder', HIVE_BUILDER_PROMPT],
      ] as const) {
        expect(countOccurrences(prompt, REPOSITORY_WORKTREE_POLICY_PROMPT), name).toBe(1);
      }

      expect(REPOSITORY_WORKTREE_POLICY_PROMPT).toContain('Pass only the returned repository IDs owned by the current lane');
      expect(REPOSITORY_WORKTREE_POLICY_PROMPT).toContain('use all returned IDs only for genuinely cross-repository work');
      expect(REPOSITORY_WORKTREE_POLICY_PROMPT).toContain('A legacy single-root worker returns the exact `sourceCommit` SHA');
      expect(REPOSITORY_WORKTREE_POLICY_PROMPT).toContain('a composite worker returns the complete `sourceCommits` map keyed by repository ID');
      expect(REPOSITORY_WORKTREE_POLICY_PROMPT).toContain('Use the map when persisted `repos` are present');
      expect(REPOSITORY_WORKTREE_POLICY_PROMPT).toContain('a singleton composite also accepts a matching scalar convenience at merge');
      expect(REPOSITORY_WORKTREE_POLICY_PROMPT).toContain('Pass the returned pin unchanged to the matching merge tool');
      expect(REPOSITORY_WORKTREE_POLICY_PROMPT).toContain('The primary owns the intended destination path');
      expect(REPOSITORY_WORKTREE_POLICY_PROMPT).toContain('Every merge supplies the exact inspected `expectedTarget`');
      expect(REPOSITORY_WORKTREE_POLICY_PROMPT).toContain('Reconciliation uses a fresh worker session in the same clean, registered worktree');
      expect(REPOSITORY_WORKTREE_POLICY_PROMPT).toContain("either set `status: 'blocked'` with a structured blocker");
      expect(REPOSITORY_WORKTREE_POLICY_PROMPT).toContain("keep `status: 'in_progress'` with pending-integration detail in `summary` or `report` and no blocker");
      expect(REPOSITORY_WORKTREE_POLICY_PROMPT).toContain('explicit operator request to continue specific existing uncommitted changes');
      expect(REPOSITORY_WORKTREE_POLICY_PROMPT).toContain('A dirty checkout alone does not justify direct checkout');
    });

    it('treats terminal tool responses as non-retriable for same parameters', () => {
      expect(QUEEN_BEE_PROMPT).toContain('If any Hive tool response has `terminal: true`');
      expect(QUEEN_BEE_PROMPT).toContain('do not retry the same parameters');
      expect(QUEEN_BEE_PROMPT).toContain('finality applies to the tool call parameters');
      expect(QUEEN_BEE_PROMPT).toContain('tool call parameters');
      expect(QUEEN_BEE_PROMPT).toContain('final natural-language handoff response');
    });

    it('redirects non-blocked unresolved tasks to normal dispatch', () => {
      expect(QUEEN_BEE_PROMPT).toContain('hive_task_update');
      expect(QUEEN_BEE_PROMPT).toContain('hive_worktree_create');
      expect(QUEEN_BEE_PROMPT).not.toContain('hive_execution_prepare');
    });

    it('routes plan review through Architect', () => {
      expect(QUEEN_BEE_PROMPT).toContain('delegate the review request to Architect');
      expect(QUEEN_BEE_PROMPT).toContain('best-fit permitted plan-reviewer');
    });

    it('routes strategic planning advice through Architect', () => {
      expect(QUEEN_BEE_PROMPT).toContain('include the question in the Architect assignment');
      expect(QUEEN_BEE_PROMPT).toContain('Architect may consult the best-fit permitted approach-advisor');
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
      expect(QUEEN_BEE_PROMPT).not.toContain('Valid endings');
      expect(QUEEN_BEE_PROMPT).toContain('Planning and orchestration turns must end with a concrete next action');
    });

    it('keeps hard blocks separate from turn termination', () => {
      expect(QUEEN_BEE_PROMPT).toContain('### Hard Blocks');
      expect(QUEEN_BEE_PROMPT).not.toContain('### Anti-Patterns');
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
    expect(QUEEN_BEE_PROMPT).toContain('each task with tracked writes MUST declare');
    expect(QUEEN_BEE_PROMPT).toContain('before task sync or worktree creation');
    expect(QUEEN_BEE_PROMPT).toContain('per-repo task');
    expect(QUEEN_BEE_PROMPT).toContain('coupled multi-repo');
    expect(QUEEN_BEE_PROMPT).toContain("automatically replace and cancel it only when no work has started and no existing task depends on it; the replacement mirrors incoming `dependsOn` and supplies corrected `repos` via `hive_task_create(...)`");
    expect(QUEEN_BEE_PROMPT).toContain('If work started or reverse dependents exist, retain the incorrect task as blocked with a structured blocker and escalate; do not rewrite dependencies');
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
      expect(ARCHITECT_BEE_PROMPT).toContain('one terminal layer of permitted Scout, plan-reviewer, or approach-advisor planning help');
      expect(ARCHITECT_BEE_PROMPT).toContain('Never use task() to delegate implementation or coding work.');
      expect(ARCHITECT_BEE_PROMPT).toContain('Never invoke Architect recursively');
    });

    it('does NOT contain the blanket prohibition "Delegate work or spawn workers"', () => {
      expect(ARCHITECT_BEE_PROMPT).not.toContain('Delegate work or spawn workers');
    });

    it('contains output-based canonical delegation guidance', () => {
      expect(ARCHITECT_BEE_PROMPT).toContain('### Canonical Delegation Guidance');
      expect(ARCHITECT_BEE_PROMPT).toContain('requested output is bounded source evidence');
      expect(ARCHITECT_BEE_PROMPT).toContain('Bounded direct reads remain acceptable');
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
      'hive_context_append({ feature: "feature-name", name: "execution-decisions", expectedRevision, expectedContentHash, ... })',
    );
    expect(SWARM_BEE_PROMPT).toContain('Append execution decisions with `hive_context_append`');
    expect(SCOUT_BEE_PROMPT).toContain('Scout is read-only');
    expect(QUEEN_BEE_PROMPT).toContain(
      'If multiple live features remain after path and session resolution',
    );
    expect(QUEEN_BEE_PROMPT).toContain('`name` for `hive_feature_complete`');
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
      expect(prompt, name).toContain('implementation/docs/test changes');
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

  it('loads context-engineering on demand and treats catalogs as untrusted knowledge', () => {
    for (const [name, prompt] of [
      ['Hive', QUEEN_BEE_PROMPT],
      ['Architect', ARCHITECT_BEE_PROMPT],
      ['Swarm', SWARM_BEE_PROMPT],
      ['Scout', SCOUT_BEE_PROMPT],
      ['Forager', FORAGER_BEE_PROMPT],
      ['Hive Builder', HIVE_BUILDER_PROMPT],
      ['Plan Reviewer', PLAN_REVIEWER_PROMPT],
    ] as const) {
      expect(prompt, name).toContain('context-engineering');
      expect(prompt, name).toContain('untrusted knowledge');
    }
    expect(QUEEN_BEE_PROMPT).toContain('Do not globally load its full body');
    expect(QUEEN_BEE_PROMPT).toContain('expectedContentHash');
    expect(QUEEN_BEE_PROMPT).toContain('No agent may silently skip required configured review targets');
  });

  it('instructs planners to prefer per-repo task boundaries and use the `**Repos**:` annotation on manifest-backed projects', () => {
    expect(ARCHITECT_BEE_PROMPT).toContain('**Repos**:');
    expect(ARCHITECT_BEE_PROMPT).toContain('each task with tracked writes MUST declare');
    expect(ARCHITECT_BEE_PROMPT).toContain('before task sync or worktree creation');
    expect(ARCHITECT_BEE_PROMPT).toContain('Prefer one repo per task');
    expect(ARCHITECT_BEE_PROMPT).toContain('coupled multi-repo');
    expect(ARCHITECT_BEE_PROMPT).toContain("require the orchestrator to automatically replace and cancel it only when no work has started and no existing task depends on it; the replacement must mirror incoming `dependsOn` and supply corrected `repos` via `hive_task_create(...)`");
    expect(ARCHITECT_BEE_PROMPT).toContain('If work started or reverse dependents exist, require the orchestrator to retain the incorrect task as blocked with a structured blocker and escalate; do not rewrite dependencies');
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
      expect(SWARM_BEE_PROMPT).toContain('before hive_tasks_sync, hive_task_create, or hive_worktree_create');
      expect(SWARM_BEE_PROMPT).toContain('every task MUST declare its **Repos** metadata before task sync or worktree creation');
      expect(SWARM_BEE_PROMPT).toContain("automatically replace and cancel it only when no work has started and no existing task depends on it; the replacement mirrors incoming `dependsOn` and supplies corrected `repos` via `hive_task_create(...)`");
      expect(SWARM_BEE_PROMPT).toContain('If work started or reverse dependents exist, retain the incorrect task as blocked with a structured blocker and escalate; do not rewrite dependencies');
    });

    it('conditions context consolidation and stale-state checks on observable pressure and task state', () => {
      expect(SWARM_BEE_PROMPT).toContain('at or above 70%');
      expect(SWARM_BEE_PROMPT).toContain('consolidation hints');
      expect(SWARM_BEE_PROMPT).toContain('before dispatching the next dependent task');
      expect(SWARM_BEE_PROMPT).toContain('evidence/archive inventories and raw logs as evidence');
      expect(SWARM_BEE_PROMPT).toContain('paused or blocked');
      expect(SWARM_BEE_PROMPT).toContain('verifier is still running');
      expect(SWARM_BEE_PROMPT).toContain('verify the claim against `hive_status` and task integration records');
      expect(SWARM_BEE_PROMPT).toContain('update or archive stale operational context');
    });

    it('uses returned launch coordinates verbatim and tags task-specific durable writes', () => {
      expect(SWARM_BEE_PROMPT).toContain('placement path, branch, and commit values returned by `hive_worktree_create` or `hive_worktree_inspect` verbatim');
      expect(SWARM_BEE_PROMPT).toContain('never concatenate fields in prose');
      expect(SWARM_BEE_PROMPT).toContain('set its `task` metadata');
    });

    it('separates subagent concurrency from foreground wait mode', () => {
      expect(SWARM_BEE_PROMPT).toContain('Dependency decides serial vs parallel');
      expect(SWARM_BEE_PROMPT).toContain('Wait mode decides blocking foreground vs background');
      expect(SWARM_BEE_PROMPT).toContain('Blocking does not mean serial');
      expect(SWARM_BEE_PROMPT).toContain(
        'If several exempt non-Forager tasks are independent, emit their ordinary Scout, advisor, or reviewer `task()` calls in the same assistant message'
      );
      expect(SWARM_BEE_PROMPT).not.toContain('During planning, default to synchronous exploration');
    });

    it('tells to check hive_status() after task() returns', () => {
      expect(SWARM_BEE_PROMPT).toContain('hive_status()');
    });

    it('requires hive_status() before any blocked-continuation launch', () => {
      expect(SWARM_BEE_PROMPT).toContain('hive_task_update');
      expect(SWARM_BEE_PROMPT).toContain('question()');
    });

    it('uses persisted blocker state as blocker authority', () => {
      for (const [name, prompt] of [['Hive', QUEEN_BEE_PROMPT], ['Swarm', SWARM_BEE_PROMPT]] as const) {
        expect(prompt, name).toContain('Do not reconstruct blocker details from worker prose or task traces');
        expect(prompt, name).toContain('explicit status leaving blocked');
      }
    });

    it('requires stop evidence before failed or partial recovery', () => {
      for (const [name, prompt] of [['Hive', QUEEN_BEE_PROMPT], ['Swarm', SWARM_BEE_PROMPT]] as const) {
        expect(prompt, name).toContain('hive_task_trace');
        expect(prompt, name).toContain('concise self-contained handoff');
      }
    });

    it('allows blocked continuation only for exactly blocked tasks', () => {
      expect(SWARM_BEE_PROMPT).toContain('explicit status leaving blocked');
      expect(SWARM_BEE_PROMPT).not.toContain('continueFrom: "blocked"');
    });

    it('requires immediate status re-check before each blocked continuation', () => {
      expect(SWARM_BEE_PROMPT).toContain('hive_task_update');
      expect(SWARM_BEE_PROMPT).toContain('question()');
    });

    it('keeps standalone diagnostic and ad-hoc blockers out of managed continuation', () => {
      expect(SWARM_BEE_PROMPT).toContain('first determine whether the result belongs to an actual managed feature and task');
      expect(SWARM_BEE_PROMPT).toContain('A standalone diagnostic or ad-hoc blocker is a terminal report');
    });

    it('forbids blocked-continuation loops on non-blocked statuses', () => {
      expect(SWARM_BEE_PROMPT).not.toContain('continueFrom: "blocked"');
      expect(SWARM_BEE_PROMPT).toContain('explicit status leaving blocked');
    });

    it('clarifies terminal finality scope while allowing final natural-language handoff', () => {
      expect(SWARM_BEE_PROMPT).toContain('If any Hive tool response has `terminal: true`');
      expect(SWARM_BEE_PROMPT).toContain('do not retry the same parameters');
      expect(SWARM_BEE_PROMPT).toContain('tool call parameters');
      expect(SWARM_BEE_PROMPT).toContain('final natural-language handoff response');
    });

    it('redirects non-blocked unresolved tasks to normal dispatch', () => {
      expect(SWARM_BEE_PROMPT).toContain('hive_task_update');
      expect(SWARM_BEE_PROMPT).toContain('hive_worktree_create');
      expect(SWARM_BEE_PROMPT).not.toContain('hive_execution_prepare');
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

    it('routes strategic planning advice through Architect', () => {
      expect(SWARM_BEE_PROMPT).toContain('include it in the Architect assignment');
      expect(SWARM_BEE_PROMPT).toContain('Architect may consult the best-fit permitted approach-advisor');
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
      expect(SWARM_BEE_PROMPT).toContain('returned topology-aware pins unchanged');
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
    expect(SWARM_BEE_PROMPT).not.toContain('complexity-review');
    expect(SWARM_BEE_PROMPT).not.toContain('complexity-audit');
  });

  it('contains verification checklist', () => {
    expect(SWARM_BEE_PROMPT).toContain('After Delegation - VERIFY');
    expect(SWARM_BEE_PROMPT).toContain('Delegate diff-level review, correctness assessment, and deep verification actions');
    expect(SWARM_BEE_PROMPT).toContain('Cheap final integration checks remain allowed');
  });

  it('teaches orchestrators to maintain overview at execution milestones', () => {
    expect(SWARM_BEE_PROMPT).toContain(
      'Read it first with a named `hive_context_read`, continue until `complete: true`, then replace the whole document with `hive_context_write({ feature: "feature-name", name: "overview", content: <complete document>, expectedRevision, expectedContentHash })`',
    );
    expect(SWARM_BEE_PROMPT).toContain('execution start');
    expect(SWARM_BEE_PROMPT).toContain('scope shift');
    expect(SWARM_BEE_PROMPT).toContain('completion');
    expect(SWARM_BEE_PROMPT).toContain('primary human-facing document');
    expect(SWARM_BEE_PROMPT).toContain('plan.md');
  });

  it('treats task association as selection metadata rather than automatic prioritization', () => {
    expect(SWARM_BEE_PROMPT).toContain('set its `task` metadata to that task folder as selection metadata');
    expect(SWARM_BEE_PROMPT).toContain('Durable context is listed in deterministic name order');
    expect(SWARM_BEE_PROMPT).toContain('does not add automatic freshness or task prioritization');
    expect(SWARM_BEE_PROMPT).not.toContain('so downstream injection can prioritize it');
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
    expect(SWARM_BEE_PROMPT).toContain('inspect its task and worktree state');
    expect(SWARM_BEE_PROMPT).toContain('helper merge delegation/state clarification');
    expect(SWARM_BEE_PROMPT).toContain('retry helper delegation once');
    expect(SWARM_BEE_PROMPT).toContain('direct `hive_worktree_merge` recovery escape');
    expect(SWARM_BEE_PROMPT).not.toContain('merge (hive_merge)');
  });

  it('does not regain normal direct hive_merge guidance from the shared system prompt', () => {
    const effectiveSwarmPrompt = SWARM_BEE_PROMPT + HIVE_SYSTEM_PROMPT;

    expect(HIVE_SYSTEM_PROMPT).not.toContain('hive_merge');
    expect(effectiveSwarmPrompt).toContain('Swarm decides when to merge');
    expect(effectiveSwarmPrompt).not.toContain('Use hive_merge to integrate changes into the current branch.');
  });
});

describe('Forager (Worker/Coder) prompt', () => {
  it('targets feature learnings explicitly without implying ad-hoc context persistence', () => {
    expect(FORAGER_BEE_PROMPT).toContain('reading the target first with `hive_context_read`, then using `hive_context_append`');
    expect(FORAGER_BEE_PROMPT).toContain('hash-guarded `hive_context_write` replacement');
    expect(FORAGER_BEE_PROMPT).not.toContain(
      'hive_context_write({ name: "learnings", content: "..." })',
    );
    expect(FORAGER_BEE_PROMPT).not.toContain('For existing-workspace assignments, managed context and Hive lifecycle tools are denied.');
    expect(FORAGER_BEE_PROMPT).toContain('Foragers write feature and project context through hash integrity');
    expect(FORAGER_BEE_PROMPT).toContain('When implementation is authorized and a feature/task worker prompt identifies a Hive feature');
  });

  it('gives commit authority only to worktree implementation assignments', () => {
    expect(FORAGER_BEE_PROMPT).toContain('Hive git helpers do not auto-commit source');
    expect(FORAGER_BEE_PROMPT).toContain('A worktree implementation assignment explicitly authorizes committing the assigned changes');
    expect(FORAGER_BEE_PROMPT).toContain('For a legacy single-root workspace, return the exact `sourceCommit` SHA');
    expect(FORAGER_BEE_PROMPT).toContain('For a composite workspace, return the complete `sourceCommits` map keyed by persisted repository ID');
    expect(FORAGER_BEE_PROMPT).toContain('Merge also accepts a matching scalar `sourceCommit` for exactly one persisted repository');
    expect(FORAGER_BEE_PROMPT).toContain('In-place and diagnosis-only missions do not authorize commits');
    expect(FORAGER_BEE_PROMPT).not.toContain('proposed Conventional Commit subject and body');
  });

  it('contains resolve before blocking', () => {
    expect(FORAGER_BEE_PROMPT).toContain('Resolve Before Blocking');
    expect(FORAGER_BEE_PROMPT).toContain('tried 3');
  });

  it('contains completion checklist', () => {
    expect(FORAGER_BEE_PROMPT).toContain('Completion Checklist');
  });

  it('requires one terminal handoff without worker finalization', () => {
    expect(FORAGER_BEE_PROMPT).toContain('return one terminal response');
    expect(FORAGER_BEE_PROMPT).toContain('the primary records task status');
    expect(FORAGER_BEE_PROMPT).not.toContain(['hive', 'worktree', 'commit'].join('_'));
  });

  it('requires a final concise handoff response for primary finalization', () => {
    expect(FORAGER_BEE_PROMPT).toContain('one terminal response');
    expect(FORAGER_BEE_PROMPT).toContain('concise summary');
    expect(FORAGER_BEE_PROMPT).toContain('exact verification evidence');
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
    expect(FORAGER_BEE_PROMPT).toContain('When the injected Hive execution scope includes a `## Declared Repositories` table');
    expect(FORAGER_BEE_PROMPT).toContain('those exact repository paths define the writable boundary');
    expect(FORAGER_BEE_PROMPT).not.toContain('the worker prompt includes a `## Declared Repositories` table');
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

  it('uses hive_worktree_merge first only for merge recovery and resolves preserved conflicts locally', () => {
    expect(HIVE_HELPER_PROMPT).toContain('hive_worktree_merge');
    expect(HIVE_HELPER_PROMPT).toContain('Merge recovery / merge batch: pass the caller\'s returned topology-aware source pin and inspected target expectation unchanged to `hive_worktree_merge`');
    expect(HIVE_HELPER_PROMPT).toContain('On `TARGET_MISMATCH`, stop for primary reconciliation');
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

  it('requires explicit self-descriptive hive_worktree_merge messages', () => {
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
    expect(SCOUT_BEE_PROMPT).toContain('Scout is read-only');
  });

  it('gives a durable-create example with frontmatter the runtime accepts', () => {
    expect(SCOUT_BEE_PROMPT).toContain('Do not call `hive_context_write`');
    expect(SCOUT_BEE_PROMPT).toContain('hive_context_read');
  });

  it('treats reserved context names as special-purpose files', () => {
    expect(SCOUT_BEE_PROMPT).toContain('reserved names like `overview`, `draft`, and `execution-decisions`');
    expect(SCOUT_BEE_PROMPT).toContain('only as read targets');
  });

  it('covers the sharpened operating contract with structural anchors', () => {
    expect(SCOUT_BEE_PROMPT).toContain('### Read-Only Contract');
    expect(SCOUT_BEE_PROMPT).toContain('### Evidence-Oriented Search Order');
    expect(SCOUT_BEE_PROMPT).toContain('### Speed and Efficiency');
  });

  it('protects anti-speculation and cited-synthesis guidance', () => {
    expect(SCOUT_BEE_PROMPT).toContain('## Synthesis Rules');
    expect(SCOUT_BEE_PROMPT).toContain('concise factual summary');
    expect(SCOUT_BEE_PROMPT).toContain('unverified');
  });

  it('mentions year awareness', () => {
    expect(SCOUT_BEE_PROMPT).toContain('current year');
  });

  it('limits discovery to one context window', () => {
    expect(SCOUT_BEE_PROMPT).toContain('fit in one context window');
  });

  it('returns bounded findings and retrieval gaps to the caller', () => {
    expect(SCOUT_BEE_PROMPT).toContain('return to the caller with bounded findings and named retrieval gaps');
    expect(SCOUT_BEE_PROMPT).not.toContain('return to Hive with recommended next steps');
  });
});

describe('Plan reviewer prompt', () => {
  it('contains agent-executable verification guidance', () => {
    expect(PLAN_REVIEWER_PROMPT).toContain('agent-executable');
  });

  it('keeps verification routed to the canonical skill', () => {
    expect(PLAN_REVIEWER_PROMPT).toContain('verification` skill');
  });

  it('blocks unresolved material public contracts before approval', () => {
    for (const [name, prompt] of [
      ['Architect', ARCHITECT_BEE_PROMPT],
      ['Plan Reviewer', PLAN_REVIEWER_PROMPT],
    ] as const) {
      expect(prompt, name).toContain('material external or public contract');
      expect(prompt, name).toContain('authentication');
      expect(prompt, name).toContain('CSRF');
      expect(prompt, name).toContain('deployment wiring');
      expect(prompt, name).toContain('blocking open question before approval');
      expect(prompt, name).toContain('implementation');
      expect(prompt, name).toContain('choose that policy');
    }
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
  const DATA_MODEL_PATH = path.resolve(import.meta.dir, '..', '..', 'docs', 'DATA-MODEL.md');
  const dataModelContent = readFileSync(DATA_MODEL_PATH, 'utf-8');
  const VSCODE_README_PATH = path.resolve(import.meta.dir, '..', '..', '..', 'vscode-hive', 'README.md');
  const vscodeReadmeContent = readFileSync(VSCODE_README_PATH, 'utf-8');
  const PHILOSOPHY_PATH = path.resolve(import.meta.dir, '..', '..', '..', '..', 'PHILOSOPHY.md');
  const philosophyContent = readFileSync(PHILOSOPHY_PATH, 'utf-8');
  const AGENTS_PATH = path.resolve(import.meta.dir, '..', '..', '..', '..', 'AGENTS.md');
  const agentsContent = readFileSync(AGENTS_PATH, 'utf-8');

  it('keeps removed assignment-artifact authority out of active prompts and docs', () => {
    for (const content of [
      HIVE_BUILDER_PROMPT,
      SWARM_BEE_PROMPT,
      rootReadmeContent,
      philosophyContent,
      agentsContent,
    ]) {
      expect(content).not.toContain('prepared assignment');
      expect(content).not.toContain('worker-prompt.md');
    }
  });

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
      expect(readmeContent).toContain('Delegate bounded retrieval to a Scout');
      expect(readmeContent).toContain('Read-only exploration');
    });

    it('clarifies that "don\'t execute" means "don\'t implement"', () => {
      expect(readmeContent).toContain("don't implement");
    });

    it('contains output-based delegation guidance', () => {
      expect(readmeContent).toContain('requested output');
      expect(readmeContent).toContain('real evidence gap');
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
      expect(hiveToolsContent).toContain('originating native parent and call');
      expect(hiveToolsContent).toContain('Cancel acknowledgement does not prove the worker stopped');
      expect(hiveToolsContent).not.toContain('acknowledgeOrphanedAttempt');
      expect(hiveToolsContent).not.toContain('task_status');
    });

    it('documents current env-gate false behavior and env-gate true scheduler behavior', () => {
      expect(readmeContent).toContain('With the env gate unset');
      expect(readmeContent).toContain('With the env gate set');
      expect(readmeContent).not.toContain('prompt appendix text only');
      expect(hiveToolsContent).not.toContain('only controls primary-agent prompt appendix text');
    });

    it('documents finalized reports, absolute in-place paths, and the active tool inventory', () => {
      expect(operatorGuideContent).toContain('hive_task_update');
      expect(operatorGuideContent).not.toContain('reports/<revision>.md');
      expect(dataModelContent).toContain('Task status and reports are the execution record');
      expect(hiveToolsContent).toContain('## Worktree families (8 tools)');
      expect(hiveToolsContent).toContain('hive_worktree_create');
      expect(hiveToolsContent).toContain('hive_adhoc_worktree_create');
      expect(hiveToolsContent).not.toContain('### Merge (1 tool)');
      expect(hiveToolsContent).not.toContain('acknowledgeOrphanedAttempt');
    });

    it('documents receipt-bound blocked continuation and placement-specific retry', () => {
      expect(operatorGuideContent).toContain('explicit status leaving blocked');
      expect(hiveToolsContent).toContain('An explicit status leaving blocked clears the blocker');
      expect(dataModelContent).toContain('`blocker` (`TaskBlocker`, optional');
      expect(dataModelContent).toContain('An explicit status leaving blocked clears the blocker');
    });

    it('documents fail-closed migrated background mode classification', () => {
      expect(dataModelContent).toContain('originating native parent and call');
      expect(dataModelContent).toContain('Stale and unknown observations stay visible');
      expect(agentsContent).toContain('originating native parent and call');
      expect(agentsContent).toContain('Stale and unknown observations stay visible');
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

    it('routes ad-hoc review fixes to the active mode primary', () => {
      expect(operatorGuideContent).toContain('give any fix instruction to the active ad-hoc primary');
      expect(operatorGuideContent).toContain('`hive-builder` in dedicated mode or `hive-master` in unified mode');
      expect(operatorGuideContent).not.toContain('give any fix instruction to `hive-builder`');
      expect(operatorGuideContent).not.toContain('ask the feature orchestrator or `hive-builder` later');
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

    it('documents the expanded hive_worktree_merge contract', () => {
      expect(hiveToolsContent).toContain('preserveConflicts');
      expect(hiveToolsContent).toContain('cleanup');
      expect(hiveToolsContent).toContain('hive_worktree_merge');
      expect(hiveToolsContent).toContain('message');
      expect(hiveToolsContent).toContain('optional `repoIds`, optional absolute `sourceDirectory`');
      expect(hiveToolsContent).toContain('Use `sourceCommit` for a legacy single-root workspace');
      expect(hiveToolsContent).toContain('When persisted `repos` are present, use `sourceCommits` as a complete map');
      expect(hiveToolsContent).toContain('A singleton composite also accepts a matching scalar `sourceCommit` convenience');
      expect(hiveToolsContent).toContain('On creation, `repoIds` selects the repositories owned by the lane');
      expect(hiveToolsContent).toContain('later ad-hoc lifecycle calls use `runId` to locate the persisted placement');
      expect(hiveToolsContent).toContain('cannot be combined with `repoIds`');
    });
  });

  describe('private review runtime docs alignment', () => {
    it('documents thin ordinary review orchestrators over natural evidence', () => {
      expect(operatorGuideContent).toContain('ordinary orchestrators over natural folders, inline text, or the current checkout');
      expect(operatorGuideContent).toContain('hive_git_snapshot({ directory })');
      expect(operatorGuideContent).toContain('ad-hoc worktree');
      expect(hiveToolsContent).toContain('ordinary orchestrators over natural folders');
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

  it('contains the classify/decompose and ready-lane placement lifecycle', () => {
    expect(HIVE_BUILDER_PROMPT).toContain('Classify/decompose');
    expect(HIVE_BUILDER_PROMPT).toContain('Place ready lanes');
    expect(HIVE_BUILDER_PROMPT).toContain('classify or decompose the work');
    expect(HIVE_BUILDER_PROMPT).toContain('place only ready lanes');
    expect(HIVE_BUILDER_PROMPT).toContain('inspect');
    expect(HIVE_BUILDER_PROMPT).toContain('delegate');
    expect(HIVE_BUILDER_PROMPT).toContain('verify');
    expect(HIVE_BUILDER_PROMPT).toContain('commit');
    expect(HIVE_BUILDER_PROMPT).toContain('merge');
    expect(HIVE_BUILDER_PROMPT).toContain('cleanup');
  });

  it('conditionally loads ad-hoc orchestration before preparing execution worktrees', () => {
    const triggerIndex = HIVE_BUILDER_PROMPT.indexOf('load `orchestrating-ad-hoc-work`');
    const preparationIndex = HIVE_BUILDER_PROMPT.indexOf('hive_adhoc_worktree_create');

    expect(triggerIndex).toBeGreaterThanOrEqual(0);
    expect(triggerIndex).toBeLessThan(preparationIndex);
    expect(HIVE_BUILDER_PROMPT).toContain('multiple independently verifiable outcomes');
    expect(HIVE_BUILDER_PROMPT).toContain('dependency waves');
    expect(HIVE_BUILDER_PROMPT).toContain('shared write/runtime resources');
    expect(HIVE_BUILDER_PROMPT).toContain('may use background execution');
    expect(HIVE_BUILDER_PROMPT).toContain('more than one worker attempt or turn');
    expect(HIVE_BUILDER_PROMPT).toContain('load `orchestrating-ad-hoc-work`');
    expect(HIVE_BUILDER_PROMPT).toContain('before any ad-hoc worktree create');
    expect(HIVE_BUILDER_PROMPT).toContain('or delegated dispatch');
    expect(HIVE_BUILDER_PROMPT).toContain('one coherent lane is correct');
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

  it('continues after rejected escalation only when material questions are resolved', () => {
    expect(HIVE_BUILDER_PROMPT).toContain('question()');
    expect(HIVE_BUILDER_PROMPT).toContain('advisory');
    expect(HIVE_BUILDER_PROMPT).toContain('continue ad-hoc only when material scope, contracts, and risks are otherwise resolved');
    expect(HIVE_BUILDER_PROMPT).toContain('ask that concrete blocking question and do not create workers');
  });

  it('contains synthesis-before-delegation wording', () => {
    expect(HIVE_BUILDER_PROMPT).toContain('Subagents do not inherit');
    expect(HIVE_BUILDER_PROMPT).toContain('evidence');
    expect(HIVE_BUILDER_PROMPT).toContain('expected result');
    expect(HIVE_BUILDER_PROMPT).toContain('done criteria');
    expect(HIVE_BUILDER_PROMPT).toContain('complete Forager context packet directly in the native `task.prompt`');
    expect(HIVE_BUILDER_PROMPT).toContain('Ordinary Scout, advisor, and reviewer packets also go in `task.prompt`');
  });

  it('uses the execution preparation surface with explicit ad-hoc completion tools', () => {
    expect(HIVE_BUILDER_PROMPT).not.toContain('hive_existing_workspace_start');
    expect(HIVE_BUILDER_PROMPT).toContain('hive_adhoc_worktree_create');
    expect(HIVE_BUILDER_PROMPT).not.toContain('hive_execution_prepare');
    expect(HIVE_BUILDER_PROMPT).not.toContain('hive_execution_finish');
    expect(HIVE_BUILDER_PROMPT).toContain('hive_adhoc_worktree_merge');
    expect(HIVE_BUILDER_PROMPT).toContain('hive_adhoc_worktree_cleanup');
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
      'If several exempt non-Forager tasks are independent, emit their ordinary Scout, advisor, or reviewer `task()` calls in the same assistant message'
    );
  });

  it('documents native Forager dispatch without removed launch authority', () => {
    const removed = [
      'launchId',
      ['hive', 'launch', 'id'].join('_'),
      ['hive', 'capability', 'reason'].join('_'),
      ['task', 'Tool', 'Call'].join(''),
      ['background', 'Task', 'Call'].join(''),
      ['worker', 'Instructions'].join(''),
      ['hive', 'worktree', 'start'].join('_'),
      ['hive', 'adhoc', 'worktree', 'start'].join('_'),
      'continueFrom: "blocked"',
      'pendingLaunches',
      'attemptSlot',
    ];
    for (const [name, prompt] of [
      ['Hive', QUEEN_BEE_PROMPT],
      ['Swarm', SWARM_BEE_PROMPT],
      ['Hive Builder', HIVE_BUILDER_PROMPT],
    ] as const) {
      expect(prompt, name).not.toContain('hive_existing_workspace_start');
      expect(prompt, name).not.toContain('hive_execution_prepare');
      expect(prompt, name).not.toContain('hive_execution_finish');
      for (const symbol of removed) expect(prompt, `${name}: ${symbol}`).not.toContain(symbol);
    }
    expect(QUEEN_BEE_PROMPT).toContain('hive_worktree_create');
    expect(HIVE_BUILDER_PROMPT).toContain('hive_adhoc_worktree_create');
  });

  it('describes general and helper ownership without root reservation or capability fields', () => {
    for (const [name, prompt] of [
      ['Hive', QUEEN_BEE_PROMPT],
      ['Swarm', SWARM_BEE_PROMPT],
      ['Hive Builder', HIVE_BUILDER_PROMPT],
    ] as const) {
      expect(prompt, name).toContain('ordinary `task()` call');
      expect(prompt, name).toContain('ordinary tools only');
      expect(prompt, name).toContain('Native helpers keep only their bounded operational permissions');
      expect(prompt, name).not.toContain(['hive', 'capability', 'reason'].join('_'));
      expect(prompt, name).not.toContain('reserve the active root');
    }
  });

  it('routes plan escalation to Architect while keeping other subagents terminal', () => {
    expect(HIVE_BUILDER_PROMPT).toContain('delegate it to `architect-planner`');
    expect(HIVE_BUILDER_PROMPT).toContain('Architect is the only subagent that may call one terminal layer of read-only planning helpers');
  });

  it('does NOT contain task-DAG defaults', () => {
    expect(HIVE_BUILDER_PROMPT).not.toContain('hive_tasks_sync({ refreshPending: true })');
    expect(HIVE_BUILDER_PROMPT).not.toContain('Depends on:');
    expect(HIVE_BUILDER_PROMPT).not.toContain(`${['hive', 'worktree', 'start'].join('_')}(task)`);
    expect(HIVE_BUILDER_PROMPT).not.toContain('plan.md');
    expect(HIVE_BUILDER_PROMPT).not.toContain('tasks.json');
    expect(HIVE_BUILDER_PROMPT).not.toContain('operator approval');
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
      expect(prompt, name).toContain('There is no exact-one-read or exact-one-write quota');
      expect(prompt, name).toContain('no blanket delegation quota');
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

  it('routes planning and material boundary revisions to canonical writing-plans guidance', () => {
    for (const [name, prompt] of [
      ['Hive', QUEEN_BEE_PROMPT],
      ['Architect', ARCHITECT_BEE_PROMPT],
    ] as const) {
      expect(prompt, name).toContain('numbered tasks are worker-branch units, not micro-steps');
      expect(prompt, name).toContain('materially revising task boundaries or dependencies');
      expect(prompt, name).toContain('load the native skill "writing-plans"');
      expect(prompt, name).toContain('Choose coherent outcome and ownership boundaries before assigning dependencies');
      expect(prompt, name).toContain("writing-plans skill's Worker-Branch Task Granularity guidance");
      expect(prompt, name).not.toContain('3-12 tasks');
    }
  });

  it('bounds coordination review to representative tasks and keeps observations nonblocking', () => {
    expect(PLAN_REVIEWER_PROMPT).not.toContain('Check only for execution blockers');
    expect(PLAN_REVIEWER_PROMPT).toContain('For those same representative tasks, check coordination');
    expect(PLAN_REVIEWER_PROMPT).toContain('required predecessor outputs or decisions, path ownership, and a verifiable handoff');
    expect(PLAN_REVIEWER_PROMPT).toContain('Missing dependencies or unsafe shared-write overlap are blockers');
    expect(PLAN_REVIEWER_PROMPT).toContain('do not redesign the architecture or reject a plan for a low parallel task count');
    expect(PLAN_REVIEWER_PROMPT).toContain('Optional coordination observations are nonblocking and do not change the verdict');
    expect(PLAN_REVIEWER_PROMPT).toContain('[Optional, when a concrete nonblocking improvement is apparent]\n**Coordination Observations**:');
  });
});
