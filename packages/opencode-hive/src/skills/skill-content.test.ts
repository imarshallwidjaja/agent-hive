import { describe, it, expect } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import matter from 'gray-matter';
import { parseNativeSkillMarkdown, resolvePackagedSkillsDir } from './native-materializer.js';

type PackagedSkill = {
  name: string;
  description: string;
  template: string;
};

function readPackagedSkills(): PackagedSkill[] {
  const skillsDir = resolvePackagedSkillsDir();
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(skillsDir, entry.name, 'SKILL.md'))
    .filter((filePath) => existsSync(filePath))
    .map((filePath) => {
      const parsed = parseNativeSkillMarkdown(filePath, readFileSync(filePath, 'utf8'));
      if (!parsed) {
        throw new Error(`Invalid packaged skill source: ${filePath}`);
      }
      return {
        name: parsed.name,
        description: parsed.description,
        template: parsed.content.trim(),
      };
    });
}

const BUILTIN_SKILLS = readPackagedSkills();

function readRepoFile(relativePath: string): string {
  return readFileSync(path.resolve(import.meta.dir, '../../../../', relativePath), 'utf8');
}

function expectInSessionDesignDocumentationPolicy(content: string) {
  expect(content).not.toContain('docs/plans/YYYY-MM-DD-<topic>-design.md');
  expect(content).not.toContain('Commit the design document to git');
  expect(content).toContain('in-session');
  expect(content).toMatch(/explicitly.*tracked artifact|tracked artifact.*explicitly/i);
}

describe('skill content', () => {
  it('bundles grilling as a general-purpose dependency-aware alignment engine', () => {
    const skill = BUILTIN_SKILLS.find((entry) => entry.name === 'grilling');

    expect(skill).toBeDefined();
    expect(skill!.description).toMatch(/^Use when /);
    expect(skill!.template).toContain('dependency-aware frontier');
    expect(skill!.template).toContain('exactly one material operator question per turn');
    expect(skill!.template).toContain('operator decisions, operator preferences, assumptions');
    expect(skill!.template).not.toContain('operator decisions and preferences');
    expect(skill!.template).toContain('discoverable facts');
    expect(skill!.template).toContain('validated');
    expect(skill!.template).toContain('pending');
    expect(skill!.template).toContain('failed');
    expect(skill!.template).toContain('assumed');
    expect(skill!.template).toContain('wrap up');
    expect(skill!.template).toContain('three-way alignment confirmation');
    expect(skill!.template).toContain('No fixed question cap');
    expect(skill!.template).toContain('conversation-scoped');
    expect(skill!.template).toContain('If research is unavailable or fails');
    expect(skill!.template).toContain('keep the fact unresolved');
    expect(skill!.template).toContain('carry it as an explicit assumption');
    expect(skill!.template).toContain('Never guess');
    expect(skill!.template).toContain('settled operator items');
    expect(skill!.template).toContain('unresolved material items');
    expect(skill!.template).toContain('counts for facts marked');
    expect(skill!.template).toContain('- operator decisions\n- operator preferences');
    expect(skill!.template).toContain('Confirmed alignment ends the interaction');
    expect(skill!.template).toContain('requires a separate operator request');
    expect(skill!.template).toContain('A named destination authorizes writing only the confirmed alignment brief there');
    expect(skill!.template).toContain('No minimum, maximum, fixed research timing, or forced delegation applies');
    expect(skill!.template).not.toMatch(/After 2-3|mandatory fan-out|minimum lanes|maximum lanes/i);
  });

  it('bundles adversarial-review with explicit read-only multi-pass constraints', () => {
    const skill = BUILTIN_SKILLS.find((entry) => entry.name === 'adversarial-review');

    expect(skill).toBeDefined();
    expect(skill!.template).toContain('neverinfamous/memory-journal-mcp');
    expect(skill!.template).toContain('dementev-dev/adversarial-review');
    expect(skill!.template).toContain('poteto/noodle');
    expect(skill!.description).toContain('explicitly asked');
    expect(skill!.description).toContain('adversarial');
    expect(skill!.template).toContain('Stay read-only. Do not edit files');
    expect(skill!.template).toContain('State scope and intent before reviewing');
    expect(skill!.template).toContain('Separate baseline from attack');
    expect(skill!.template).toContain('If any review step mutates the artifact under review, stop and report the mutation');
    expect(skill!.template).toContain('Report missing, empty, stale, or invalid review inputs');
    expect(skill!.template).toContain('Host output format wins');
  });

  it('bundles adversarial-review mode detection and lens coverage', () => {
    const skill = BUILTIN_SKILLS.find((entry) => entry.name === 'adversarial-review');

    expect(skill).toBeDefined();
    for (const mode of ['plan', 'code', 'code-vs-plan', 'approach', 'simplicity', 'file']) {
      expect(skill!.template).toContain(mode);
    }
    for (const lens of ['Skeptic', 'Architect', 'Minimalist', 'Boundary Breaker', 'Stress Tester']) {
      expect(skill!.template).toContain(lens);
    }
  });

  it('bundles adversarial-review external validation as optional and failure-reporting', () => {
    const skill = BUILTIN_SKILLS.find((entry) => entry.name === 'adversarial-review');

    expect(skill).toBeDefined();
    expect(skill!.template).toContain('External or cross-model validation is useful but not required');
    expect(skill!.template).toContain('Confirm the output exists and is non-empty before using it');
    expect(skill!.template).toContain('Report missing, failed, timed out, or empty output as a validation failure');
    expect(skill!.template).toContain('Do not let external tools mutate the artifact under review');
  });

  it('bundles the ast-grep skill with the upstream tool surface', () => {
    const skill = BUILTIN_SKILLS.find((entry) => entry.name === 'ast-grep');

    expect(skill).toBeDefined();
    expect(skill!.template).toContain('ast_grep_dump_syntax_tree');
    expect(skill!.template).toContain('ast_grep_test_match_code_rule');
    expect(skill!.template).toContain('ast_grep_find_code');
    expect(skill!.template).toContain('ast_grep_find_code_by_rule');
    expect(skill!.template).not.toContain('ast_grep_search');
    expect(skill!.template).not.toContain('ast_grep_replace');
  });

  it('keeps brainstorming design in-session without mandatory tracked design documents', () => {
    const skill = BUILTIN_SKILLS.find((entry) => entry.name === 'brainstorming');

    expect(skill).toBeDefined();
    expectInSessionDesignDocumentationPolicy(skill!.template);
  });

  it('lets concrete corrective feedback bypass brainstorming dialogue without bypassing engineering gates', () => {
    const skill = BUILTIN_SKILLS.find((entry) => entry.name === 'brainstorming');
    const template = skill!.template;

    expect(skill).toBeDefined();
    expect(skill!.description).toBe(
      'Use before creative work such as creating features, building components, adding functionality, or modifying behavior.'
    );
    for (const qualifier of [
      'wrong behavior',
      'desired behavior',
      'affected artifact',
      'correction direction',
    ]) {
      expect(template).toContain(qualifier);
    }
    expect(template).toContain('Bare bug reports and vague feature requests do not qualify');
    expect(template).toContain(
      'If the operator explicitly asks to explore alternatives, discuss the change, or design it, keep the work exploratory even when the feedback is concrete.'
    );
    expect(template).toContain('Skip only the brainstorming dialogue and readiness prompt');
    expect(template).toContain('planning, isolation, testing, and verification');
    expect(template).toContain('Ask exactly one targeted question only when');
    for (const ambiguity of [
      'correctness',
      'safety',
      'data scope',
      'persistence',
      'UX',
      'public contract',
    ]) {
      expect(template).toContain(ambiguity);
    }
    expect(template).toContain(
      'If the question is unanswered, or material ambiguity remains after the answer, stop rather than guess or enter the ordinary brainstorming process'
    );
    expect(template).toContain(
      '**Be flexible** - During ordinary brainstorming, go back and clarify when something does not make sense'
    );
    expect(template).toContain(
      '**Challenge assumptions** - During ordinary brainstorming, surface fragile assumptions, ask what changes if they fail, and offer lean fallback options'
    );
    expect(template).toMatch(
      /^- \*\*One question at a time\*\* - Don't overwhelm with multiple questions during ordinary brainstorming$/m
    );
    expect(template).toMatch(
      /^- \*\*Explore alternatives\*\* - Propose 2-3 approaches during ordinary brainstorming or when the operator explicitly requests alternatives$/m
    );
    expect(template).toMatch(
      /^- \*\*Incremental validation\*\* - Present ordinary brainstorming designs in sections and validate each$/m
    );
    expect(template).toMatch(
      /^- After ordinary brainstorming, ask: "Ready to set up for implementation\?"$/m
    );
    expect(template).not.toMatch(
      /^- \*\*Explore alternatives\*\* - Always propose 2-3 approaches before settling$/m
    );
    expect(template).not.toMatch(/^- Ask: "Ready to set up for implementation\?"$/m);
    expect(template).not.toMatch(
      /^- \*\*Incremental validation\*\* - Present design in sections, validate each$/m
    );
    expect(template).not.toMatch(
      /^- \*\*Be flexible\*\* - Go back and clarify when something doesn't make sense$/m
    );
    expect(template).not.toMatch(
      /^- \*\*Challenge assumptions\*\* - Surface fragile assumptions, ask what changes if they fail, offer lean fallback options$/m
    );
  });

  it('documents overview-first execution truth in writing-plans', () => {
    const skill = BUILTIN_SKILLS.find((entry) => entry.name === 'writing-plans');

    expect(skill).toBeDefined();
    expect(skill!.template).toContain('context/overview.md');
    expect(skill!.template).toContain('human-facing review surface');
    expect(skill!.template).toContain('plan.md` remains execution truth');
    expect(skill!.template).toContain('Design Summary');
    expect(skill!.template).not.toContain('Treat `plan.md` as the human-facing review surface and execution truth');
  });

  it('makes writing plans evidence-led and testing-strategy-aware without implementation ceremony', () => {
    const skill = BUILTIN_SKILLS.find((entry) => entry.name === 'writing-plans');
    const template = skill!.template;

    expect(skill).toBeDefined();
    for (const requirement of [
      'repository evidence',
      'requested behavior',
      'call-site contracts',
      'ownership boundaries',
      'acceptance criteria',
      'verification',
      'preparatory refactoring',
      'selected testing strategy',
      'coordination boundaries, not module boundaries',
    ]) {
      expect(template.toLowerCase(), requirement).toContain(requirement.toLowerCase());
    }
    expect(template).toContain('Code snippets only when exact syntax removes material ambiguity');
    expect(template).not.toContain('Complete code in plan');
    expect(template).not.toContain('Write the failing test');
    expect(template).not.toContain('frequent commits');
    expect(template).toContain('When tests are selected');
    expect(template).toContain('owning layer');
    expect(template).toContain('canonical suite');
    expect(template).toContain('must not plan a later test-cleanup pass');
    expect(template).toContain('Apply Process Judgment before adding scope or blockers.');
  });

  it('chooses coherent task boundaries before dependencies without parallel quotas', () => {
    const template = BUILTIN_SKILLS.find((entry) => entry.name === 'writing-plans')!.template;
    const granularity = template.slice(template.indexOf('## Worker-Branch Task Granularity'), template.indexOf('## Plan Structure'));

    expect(granularity).toContain('Choose task boundaries before assigning dependencies');
    expect(granularity).toContain('each outcome, required predecessor outputs or capability decisions, owned paths, and verification');
    expect(granularity).toContain('Keep tightly coupled implementation, tests, docs, and generated artifacts together');
    expect(granularity).toContain('do not split by file or target a task count or parallel quota');
    expect(granularity).toContain('Split only when the handoff is concrete and the parallel work justifies the coordination cost');
    expect(granularity).toContain('do not invent speculative contracts');
    expect(granularity).toContain('exact shared paths it owns, and integration tests');
    expect(granularity).toContain('generic dumping ground');
    expect(granularity).toContain('required outputs, capability decisions, or deliberate shared-write ordering, never from task numbering');
    expect(granularity).toContain('When useful for review, briefly explain');
    expect(granularity).toContain('No separate rationale template is required');
    expect(granularity).toContain('final integrated correctness and applicable security review gates');
    expect(granularity).toContain('Before:');
    expect(granularity).toContain('After, if the repository already defines the exporter interface');
    expect(granularity.match(/\*\*Depends on\*\*: none/g)).toHaveLength(2);
    expect(granularity).toContain('`src/app/export-lifecycle.test.ts`; **Depends on**: 1, 2');
    expect(granularity).toContain('If the interface still requires a capability decision');
  });

  it('keeps planning implementation-read-only and hands task refresh to the orchestrator', () => {
    const skill = BUILTIN_SKILLS.find((entry) => entry.name === 'writing-plans');
    const template = skill!.template;

    expect(skill).toBeDefined();
    expect(template).toContain('implementation files remain read-only');
    expect(template).toContain('Hive planning state may be written');
    expect(template).toContain('record the required refresh in the planning handoff');
    expect(template).toContain('orchestrator performs `hive_tasks_sync({ refreshPending: true })`');
    expect(template).not.toContain('run `hive_tasks_sync({ refreshPending: true })` after review or approval');
  });

  it('scopes strict TDD mechanics to an explicitly selected testing strategy', () => {
    const skill = BUILTIN_SKILLS.find((entry) => entry.name === 'test-driven-development');
    const template = skill!.template;
    const scope = template.slice(template.indexOf('## Scope'), template.indexOf('## Red-Green-Refactor'));

    expect(skill).toBeDefined();
    expect(skill!.description).toContain('TDD has been selected');
    expect(template).toContain('operator, plan, or repository policy');
    expect(template).toContain('examples are the useful design technique');
    expect(scope).toContain('TDD is one testing strategy');
    expect(scope).toContain('active plan and repository policy');
    expect(scope).not.toContain('characterization tests');
    expect(scope).not.toContain('tests alongside or after implementation');
    expect(scope).not.toContain('existing public-contract coverage');
    expect(scope).not.toContain('proportionate non-test verification');
    expect(template).toContain('characterization tests');
    expect(template).toContain('tests alongside or after implementation');
    expect(template).toContain('existing public-contract coverage');
    expect(template).toContain('proportionate non-test verification');
    expect(template).toContain('Verify RED');
    expect(template).toContain('Verify GREEN');
    expect(template).toContain('Name the invariant and owning layer first');
    expect(template).toContain('(1) add to an existing test in an existing file');
    expect(template).toContain('(2) add a new test to an existing canonical file');
    expect(template).toContain('(3) create a new file inside the existing canonical suite');
    expect(template).toContain('(4) create a standalone regression file only if the canonical suite cannot express the case cleanly');
    expect(template).toContain('delete or simplify weaker duplicates');
    expect(template).toContain('Do not leave extra files for a later cleanup pass');
    expect(template).not.toContain('Thinking "skip TDD just this once"? Stop. That\'s rationalization.');
    expect(template).not.toContain('Every new function/method has a test');
    expect(template).not.toContain('Tests-after are biased by your implementation');
  });

  it('keeps systematic debugging root-cause-first with contextual durable verification', () => {
    const skill = BUILTIN_SKILLS.find((entry) => entry.name === 'systematic-debugging');
    const template = skill!.template;

    expect(skill).toBeDefined();
    expect(template).toContain('Reproduction or equivalent root-cause evidence is required before a fix');
    expect(template).toContain('Select the durable testing and verification strategy from the defect, repository evidence, and mission');
    expect(template).toContain('Use strict TDD only when that strategy is selected');
    expect(template).toContain('characterization tests');
    expect(template).toContain('tests alongside or after implementation');
    expect(template).toContain('existing contract coverage');
    expect(template).toContain('proportionate no-new-test verification');
    expect(template).toContain('tightly bounded behavior-preserving preparatory refactoring');
    expect(template).toContain('first unintended side effect');
    expect(template).toContain('Hidden write checks');
    expect(template).toContain('Do not stop at the first contract, parsing, type, null, or schema error');
    expect(template).not.toContain('MUST have before fixing');
    expect(template).not.toContain('No bundled refactoring');
    expect(template).not.toContain('Violating the letter of this process');
    expect(template).not.toContain('root-cause-tracing.md');
    expect(template).not.toContain('defense-in-depth.md');
    expect(template).not.toContain('condition-based-waiting.md');
    expect(template).not.toContain('root-cause-finder');
    expect(template).not.toContain('available in this directory');
  });

  it('documents task() fan-out paths for parallel-exploration', () => {
    const skill = BUILTIN_SKILLS.find((entry) => entry.name === 'parallel-exploration');

    expect(skill).toBeDefined();
    expect(skill!.template).toContain('task({');
    expect(skill!.template).toContain(
      'Launch every currently known, necessary, non-duplicative independent question before waiting for any results.'
    );
    expect(skill!.template).toContain('fit in one context window');
    expect(skill!.template).toContain('return to Hive');
    expect(skill!.template).toContain('Dependency decides serial vs parallel');
    expect(skill!.template).toContain('Wait mode decides blocking foreground vs background');
    expect(skill!.template).toContain('Blocking does not mean serial');
    expect(skill!.template).toContain('If the only reason for serializing is `task()` is blocking, that is incorrect');
    expect(skill!.template).toContain('one primary goal');
    expect(skill!.template).toContain('Native `task_id` resume is allowed');
    expect(skill!.template).toContain('one terminal handoff');
    expect(skill!.template).not.toContain('starts one fresh subagent session');
  });

  it('launches every admitted Scout question in one wave and makes later waves evidence-driven', () => {
    const skill = BUILTIN_SKILLS.find((entry) => entry.name === 'parallel-exploration');

    expect(skill).toBeDefined();
    expect(skill!.template).toContain(
      'Launch every currently known, necessary, non-duplicative independent question in the same assistant message'
    );
    expect(skill!.template).toContain('one independently answerable, non-overlapping, context-bounded question per fresh Scout session');
    expect(skill!.template).toContain('Later waves must be driven by evidence, dependencies, or named gaps from the completed wave');
  });

  it('keeps Scout fan-out retrieval-only and parent synthesis evidence-aware', () => {
    const skill = BUILTIN_SKILLS.find((entry) => entry.name === 'parallel-exploration');
    const template = skill!.template;

    expect(skill).toBeDefined();
    expect(template).toContain('Select Scouts by the retrieval output needed');
    expect(template).toContain('not by whether the overall request is read-only');
    expect(template).toContain('Scout does not own causal diagnosis, applicability or tradeoff decisions, or solution selection');
    expect(template).toContain('source observations from hypotheses');
    expect(template).toContain('runtime evidence from a possible code path');
    expect(template).toContain('Reasoning over returned excerpts is coordination');
    expect(template).toContain('A direct source spot-check remains a bounded read');
    expect(template).toContain('There is no numeric direct-read quota and no mandatory delegation');
    expect(template).toContain('Do not use recursive Scout verification as a substitute for reasoning');
    expect(template).toContain('No numeric quota or artificial fan-out applies');
  });

  it('bounds Scout slices before researcher selection and selects custom Scouts by descriptor match', () => {
    const skill = BUILTIN_SKILLS.find((entry) => entry.name === 'parallel-exploration');
    const template = skill!.template;

    expect(skill).toBeDefined();

    for (const signal of [
      'breadth',
      'ambiguity',
      'multi-domain',
      'multi-repository',
      'whole-incident RCA',
      'unknown targets',
    ]) {
      expect(template.toLowerCase(), signal).toContain(signal.toLowerCase());
    }
    expect(template).toContain('decomposition signals');
    expect(template).toContain('The reasoning owner derives bounded evidence-retrieval slices, not smaller causal questions');
    expect(template).toContain('Whole-incident RCA remains with the reasoning owner or a best-fit diagnostic worker/advisor');
    expect(template).toContain('Use `scout-researcher` by default for each bounded exploratory evidence slice');
    expect(template).toContain(
      'Select a configured scout-derived custom subagent only when its own description is a closer domain or workflow match for that already-bounded question'
    );
    expect(template).toContain(
      'fall back to built-in `scout-researcher` when no configured description is a closer fit'
    );
    expect(template).not.toContain('scout-researcher-capable');
    expect(template).toContain(
      'Custom Scouts do not relax the one-window boundary and never replace decomposition or fan-out'
    );

    const patternSection = template.match(/## The Pattern\n([\s\S]*?)(?=\n## )/)?.[1] ?? '';
    expect(patternSection.length).toBeGreaterThan(0);
    const headings = [...patternSection.matchAll(/^### .+$/gm)].map((match) => match[0]);
    const decomposeHeadingIdx = headings.findIndex((heading) => /decompos/i.test(heading));
    const selectHeadingIdx = headings.findIndex(
      (heading) => /researcher/i.test(heading) && /select|choose/i.test(heading)
    );
    const waitDispatchHeadingIdx = headings.findIndex((heading) =>
      /wait mode|dispatch/i.test(heading)
    );
    expect(decomposeHeadingIdx).toBeGreaterThanOrEqual(0);
    expect(selectHeadingIdx).toBeGreaterThanOrEqual(0);
    expect(waitDispatchHeadingIdx).toBeGreaterThanOrEqual(0);
    expect(decomposeHeadingIdx).toBeLessThan(selectHeadingIdx);
    expect(selectHeadingIdx).toBeLessThan(waitDispatchHeadingIdx);
  });

  it('positions parallel-exploration as lightweight read-only delegation under the background scheduler', () => {
    const skill = BUILTIN_SKILLS.find((entry) => entry.name === 'parallel-exploration');

    expect(skill).toBeDefined();
    expect(skill!.template).toContain('exploratory/read-only lightweight delegation');
    expect(skill!.template).toContain('For kind-based scheduling under the gate, load `background-delegation`');
    expect(skill!.template).toContain('Context Packet');
    expect(skill!.template).toContain('known facts');
    expect(skill!.template).toContain('constraints and non-goals');
    expect(skill!.template).toContain('stop and return behavior');
    expect(skill!.template).toContain('expected output');
  });

  it('registers planless ad-hoc orchestration for both primary modes', () => {
    const skill = BUILTIN_SKILLS.find((entry) => entry.name === 'orchestrating-ad-hoc-work');

    expect(skill).toBeDefined();
    expect(skill!.description).toMatch(/^Use when /);
    expect(skill!.description).toMatch(/Hive Builder.*unified Hive primary/);
    expect(skill!.description).toContain('background execution');
    expect(skill!.description).toContain('expected multiple worker attempts or turns');
    expect(skill!.template).toContain('An **ad-hoc primary** is Hive Builder or a unified Hive primary');
    expect(skill!.template).toMatch(/multiple independently verifiable outcomes.*dependency waves.*shared write\/runtime resources/s);
    expect(skill!.template).toContain('may use background execution');
    expect(skill!.template).toContain('may require more than one worker attempt or turn');
    expect(skill!.template).toContain('Decomposition may retain one coherent lane');
    expect(skill!.template).not.toMatch(/hive_(?:feature|plan|tasks|worktree)_/);
    expect(skill!.template).not.toContain('plan.md');
    expect(skill!.template).not.toContain('tasks.json');
  });

  it('defines outcome-first ownership and safe worktree placement', () => {
    const template = BUILTIN_SKILLS.find((entry) => entry.name === 'orchestrating-ad-hoc-work')!.template;
    const outcomeIndex = template.indexOf('Identify coherent, independently verifiable outcomes');
    const handoffIndex = template.indexOf('Name each concrete predecessor output');
    const ownershipIndex = template.indexOf('Assign one owner');
    const dependencyIndex = template.indexOf('Add dependency edges');

    expect(outcomeIndex).toBeLessThan(handoffIndex);
    expect(handoffIndex).toBeLessThan(ownershipIndex);
    expect(ownershipIndex).toBeLessThan(dependencyIndex);
    for (const resource of ['generated outputs', 'external mutable resources', 'fixed-path test fixtures', 'ports', 'databases', 'containers']) {
      expect(template).toContain(resource);
    }
    expect(template).toContain('Distinct worktrees do not isolate these resources');
    expect(template).toContain('Parallel writers require distinct ad-hoc `runId`s and worktrees');
    expect(template).toContain('Writes and fix passes within one run remain sequential');
    expect(template).toContain('emit all independent launches in the same assistant message');
    expect(template).toContain('Blocking is a wait mode, not serial scheduling');
  });

  it('does not require a mandatory evidence ledger', () => {
    const template = BUILTIN_SKILLS.find((entry) => entry.name === 'orchestrating-ad-hoc-work')!.template;

    expect(template).toContain('Do not create a mandatory evidence ledger');
    expect(template).toContain('temporary workspace metadata only');
    expect(template).not.toContain('`adhoc-lanes-<purpose>-<UTC timestamp>`');
  });

  it('uses session state rather than hash-guarded ledger append and archive', () => {
    const template = BUILTIN_SKILLS.find((entry) => entry.name === 'orchestrating-ad-hoc-work')!.template;

    expect(template).toContain('Session state or `todowrite` is enough to track that');
    expect(template).not.toContain('hive_context_archive({');
  });

  it('records configured review gates and integrated verification before closure', () => {
    const template = BUILTIN_SKILLS.find((entry) => entry.name === 'orchestrating-ad-hoc-work')!.template;

    expect(template).toContain("Lane changes receive the reviews required by the active primary's configured review policy");
    expect(template).toContain('this skill adds no separate reviewer-approval gate');
    expect(template).toContain('Required review and lane verification each gate merge');
    expect(template).toContain('full integrated canonical verification result is recorded and passing');
  });

  it('keeps the expanded ad-hoc trigger reachable from operator and agent documentation', () => {
    for (const content of [
      readRepoFile('AGENTS.md'),
      readRepoFile('README.md'),
      readRepoFile('docs/OPERATOR-GUIDE.md'),
      readRepoFile('packages/opencode-hive/README.md'),
    ]) {
      expect(content).toContain('orchestrating-ad-hoc-work');
      expect(content).toMatch(/background execution/);
      expect(content).toMatch(/more than one worker attempt or turn/);
    }
  });

  it('keeps escalation advisory without bypassing material questions', () => {
    const template = BUILTIN_SKILLS.find((entry) => entry.name === 'orchestrating-ad-hoc-work')!.template;

    expect(template).toContain('Escalation is advisory');
    expect(template).toContain('continue ad-hoc only when material scope, contracts, and risks are otherwise resolved');
    expect(template).toContain('ask that concrete blocking question and do not create workers');
    expect(template).toContain('Routine decomposition needs no approval question');
  });

  it('keeps shared delegation skills mode-scoped without redefining ad-hoc lanes', () => {
    const dispatch = BUILTIN_SKILLS.find((entry) => entry.name === 'dispatching-parallel-agents')!.template;
    const exploration = BUILTIN_SKILLS.find((entry) => entry.name === 'parallel-exploration')!.template;
    const background = BUILTIN_SKILLS.find((entry) => entry.name === 'background-delegation')!.template;

    expect(dispatch).toContain('In Hive Builder or unified Hive ad-hoc mode, load `orchestrating-ad-hoc-work`');
    expect(dispatch).toContain('In feature-task mode, use `hive_status()`');
    expect(dispatch).toContain('In ad-hoc mode, return result state to `orchestrating-ad-hoc-work`');
    expect(dispatch).toContain('In feature-task mode, follow the feature workflow\'s review, merge, and final-verification gates');
    expect(dispatch).toContain('In ad-hoc mode, return result and resource state to `orchestrating-ad-hoc-work`');
    expect(exploration).toContain('Hive Builder or unified Hive ad-hoc mode loads `orchestrating-ad-hoc-work`');
    expect(background).toContain('`orchestrating-ad-hoc-work` supplies the already-defined lanes');
    expect(background).toContain('owns background observation, reconciliation, cancellation, and wait-mode protocol');
    expect(background).toContain('return verification state to `orchestrating-ad-hoc-work`; no feature plan or task artifact is required');
    expect(background).toContain('consume the lane boundaries and ready wave from `orchestrating-ad-hoc-work`; do not redefine them here');
  });

  it('removes numeric fan-out policy from Scout and background delegation skills', () => {
    const numericFanOutPolicy =
      /three Scouts|up to\s+\d+\s+lanes?|\b\d+\s+tasks?\b(?=[^\n]{0,80}(?:fan-out|parallel|dispatch))|\b2-4\b|\b5\+/i;

    for (const name of ['parallel-exploration', 'background-delegation']) {
      const skill = BUILTIN_SKILLS.find((entry) => entry.name === name);

      expect(skill).toBeDefined();
      expect(skill!.template, name).not.toMatch(numericFanOutPolicy);
    }
  });

  it('keeps executing-plans sequential guidance subordinate to background-delegation when gate-open', () => {
    const skill = BUILTIN_SKILLS.find((entry) => entry.name === 'executing-plans');

    expect(skill).toBeDefined();
    expect(skill!.template).toContain('If `## Background-First Orchestration` is present');
    expect(skill!.template).toContain('use `background-delegation` as the scheduler authority');
    expect(skill!.template).toContain('gate-closed fallback guidance');
    expect(skill!.template).toContain('Execution and Forager lanes are managed/heavy background lanes');
    expect(skill!.template).toContain('unresolved-lane checks before dependent decisions');
    expect(skill!.template).toContain('hive_worktree_create');
    expect(skill!.template).toContain('native Forager');
    expect(skill!.template).toContain('In gate-closed sessions use a blocking native `task()` call');
    expect(skill!.template).toContain('Risk-Tier Review Routing');
    expect(skill!.template).toContain('Post-Batch Code Review');
    expect(skill!.template).toContain('recommended review path');
    expect(skill!.template).toContain('One implementation assignment normally maps to one numbered task');
    expect(skill!.template).toContain('Never reconstruct blocker details from worker prose or task traces');
    expect(skill!.template).toContain('explicit status leaving blocked');
    expect(skill!.template).toContain('explicitly admitted native general/helper exceptions');
    expect(skill!.template).toContain('Other mutation-capable or unknown task targets are denied');
    expect(skill!.template).toContain('Architect retains its bounded planning lane');
    expect(skill!.template).not.toContain('Non-Hive mutation-capable or unknown task targets are denied');
    expect(skill!.template).toContain('execution-decisions');
    expect(skill!.template).toContain('Dependencies guide sequencing');
  });

  it('finishes executing-plans through verification and Hive merge instead of a generic finish menu', () => {
    const skill = BUILTIN_SKILLS.find((entry) => entry.name === 'executing-plans');
    const template = skill!.template;
    const completeDevelopment = template.slice(
      template.indexOf('### Step 6: Complete Development'),
      template.indexOf('## When to Stop and Ask for Help'),
    );

    expect(skill).toBeDefined();
    expect(completeDevelopment).toContain('skill({ name: "verification" })');
    expect(completeDevelopment).toContain('hive_worktree_merge');
    expect(completeDevelopment).toContain('hive-helper');
    expect(completeDevelopment).toContain('For worktree placement');
    expect(completeDevelopment).toContain('For in-place placement');
    expect(completeDevelopment).toContain('skip Hive merge and cleanup');
    expect(completeDevelopment).toContain('Do not present a generic merge/PR/keep/discard menu');
    expect(completeDevelopment).toContain('do not use raw `git merge` / `git worktree remove` as the Hive finish path');
    expect(completeDevelopment).not.toContain('present options');
    expect(completeDevelopment).not.toContain('execute choice');
    expect(template).not.toContain('verify tests, present options, execute choice');
    expect(template).not.toContain('finishing-a-development-branch');
  });

  it('uses native Forager examples in the core hive skill', () => {
    const hiveSkill = readRepoFile('packages/hive-core/templates/skills/hive.md');

    expect(hiveSkill).toContain('hive_worktree_create({ task: "01-task-name" })');
    expect(hiveSkill).toContain('hive_worktree_create({ task: "02-task-a" })');
    expect(hiveSkill).toContain('subagent_type: "forager-worker"');
    expect(hiveSkill).toContain('hive_task_update({ task: "01-task-name", status: "done", summary, report })');
    expect(hiveSkill).toContain('hive_task_update({ task, status: "blocked"');
    expect(hiveSkill).toContain('strategy: "squash", message:');
    expect(hiveSkill).toContain('Do not call `hive_worktree_merge` again while preserved conflict state is active');
    expect(hiveSkill).not.toContain('hive_worktree_start');
    expect(hiveSkill).not.toContain('taskToolCall');
  });

  it('documents both execution placements in the core hive skill', () => {
    const hiveSkill = readRepoFile('packages/hive-core/templates/skills/hive.md');

    expect(hiveSkill).toContain('hive_worktree_create');
    expect(hiveSkill).toContain('no Hive filesystem exclusion, Git isolation, rollback, commit, merge, or cleanup');
    expect(hiveSkill).toContain('hive_task_update');
    expect(hiveSkill).toContain('do not reconstruct them from worker prose');
    expect(hiveSkill).toContain('hive_task_update({ task, status: "pending" })');
    expect(hiveSkill).not.toContain('hive_execution_prepare');
    expect(hiveSkill).not.toContain('Executes tasks in worktrees');
  });

  it('includes task() parallel guidance for dispatching-parallel-agents', () => {
    const skill = BUILTIN_SKILLS.find((entry) => entry.name === 'dispatching-parallel-agents');

    expect(skill).toBeDefined();
    expect(skill!.template).toContain('task({');
    expect(skill!.template).toContain('Independent Forager worktrees may be created and dispatched under one parent');
    expect(skill!.template).toContain('Gate-open only: use background: true');
    expect(skill!.template).toContain('hive_worktree_create');
    expect(skill!.template).not.toContain('hive_existing_workspace_start');
    expect(skill!.template).toContain('In feature-task mode, follow the feature workflow\'s verification and `hive_worktree_merge` lifecycle');
    expect(skill!.template).toContain('In ad-hoc mode, return result state to `orchestrating-ad-hoc-work`');
    expect(skill!.template).toContain('hive_adhoc_worktree_merge');
    expect(skill!.template).toContain('Treat installs, builds, formatters, generators, and tests as mutations');
    expect(skill!.template).toContain('Blocking alternative, including every gate-closed session');
    expect(skill!.template).toContain('Ordinary Scout, advisor, and reviewer launches remain eligible for same-message parallel dispatch');
    expect(skill!.template).toContain('one primary goal');
    expect(skill!.template).toContain('disjoint path ownership or sequence overlapping writers');
    expect(skill!.template).toContain('parallel-exploration');
    expect(skill!.template).not.toMatch(/Treat unresolved lanes as blockers/i);
    expect(skill!.template).toContain('execution-decisions');
    expect(skill!.template).toContain('Dependencies guide sequencing');
    expect(skill!.template).not.toContain('Only dispatch tasks that are runnable');
    expect(skill!.template).not.toContain('Proceed only after operator approval');
  });

  it('includes every native-required field in managed Forager examples', () => {
    let exampleCount = 0;

    for (const skill of BUILTIN_SKILLS) {
      for (const match of skill.template.matchAll(/(?:await\s+)?task\(\{([\s\S]*?)\}\)/g)) {
        const fields = match[1];
        if (!fields.includes('forager-worker')) continue;
        exampleCount += 1;
        expect(fields, skill.name).toMatch(/\bsubagent_type\s*:/);
        expect(fields, skill.name).toMatch(/\bdescription\s*:/);
        expect(fields, skill.name).toMatch(/\bprompt\s*:/);
      }
    }

    expect(exampleCount).toBeGreaterThan(0);
  });

  it('cuts removed launch fields and states general/helper ownership on dispatch skills', () => {
    const removed = [
      'hive_capability_reason',
      'hive_launch_id',
      'launchId',
      'taskToolCall',
      'backgroundTaskCall',
      'workerInstructions',
      'hive_worktree_start',
      'hive_adhoc_worktree_start',
      'continueFrom: "blocked"',
      'pendingLaunches',
      'attemptSlot',
      'hive_execution_prepare',
      'hive_execution_finish',
    ];

    for (const name of ['background-delegation', 'dispatching-parallel-agents', 'executing-plans']) {
      const skill = BUILTIN_SKILLS.find((entry) => entry.name === name);

      expect(skill).toBeDefined();
      expect(skill!.template, name).toContain('ordinary `task()` call');
      expect(skill!.template, name).toContain('Native helpers keep only their bounded operational permissions');
      expect(skill!.template, name).not.toContain('reserve the active root');
      for (const symbol of removed) expect(skill!.template, `${name}: ${symbol}`).not.toContain(symbol);
    }
  });

  it('keeps every registered skill off removed launch fields', () => {
    const forbidden = [
      'hive_worktree_start',
      'hive_adhoc_worktree_start',
      'taskToolCall',
      'backgroundTaskCall',
      'hive_launch_id',
      'workerInstructions',
      'hive_capability_reason',
      'continueFrom: "blocked"',
      'pendingLaunches',
      'launchId',
      'attemptSlot',
      'hive_execution_prepare',
      'hive_execution_finish',
    ];

    for (const skill of BUILTIN_SKILLS) {
      for (const symbol of forbidden) {
        expect(skill.template, `${skill.name}: ${symbol}`).not.toContain(symbol);
      }
    }
  });

  it('does not keep stale synchronous-exploration wording in delegation skills', () => {
    for (const name of ['parallel-exploration', 'background-delegation', 'dispatching-parallel-agents']) {
      const skill = BUILTIN_SKILLS.find((entry) => entry.name === name);

      expect(skill).toBeDefined();
      expect(skill!.template, name).not.toContain('default to synchronous exploration');
      expect(skill!.template, name).not.toContain('synchronous exploration');
    }
  });

  it('bundles background-delegation with baseline delegation and env-gated wait-mode guidance', () => {
    const skill = BUILTIN_SKILLS.find((entry) => entry.name === 'background-delegation');

    expect(skill).toBeDefined();
    expect(skill!.description).toContain('Agent Hive');
    expect(skill!.template).toContain('OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS');
    expect(skill!.template).toContain('OPENCODE_EXPERIMENTAL');
    expect(skill!.template).toContain('task({ background: true');
    expect(skill!.template).toContain('native background completion notification');
    expect(skill!.template).toContain('hive_background_status');
    expect(skill!.template).toContain('hive_background_reconcile');
    expect(skill!.template).toContain('hive_background_reconcile_batch');
    expect(skill!.template).toContain('hive_background_cancel');
    expect(skill!.template).not.toContain('task_status');
    expect(skill!.template).toContain('Delegation-first orchestration is the baseline');
    expect(skill!.template).toContain('Background mode only changes wait mode and board protocol');
    expect(skill!.template).toContain('background-delegation governs scheduling and wait mode');
    expect(skill!.template).toContain('Direct vs Delegated Work');
    expect(skill!.template).toContain('Delegation Kind Reference');
    expect(skill!.template).toContain('Context Packet');
    expect(skill!.template).toContain('Put the complete Forager context packet directly in the unchanged native `task.prompt`');
    expect(skill!.template).toContain('Ordinary Scout, advisor, and reviewer packets also go in `task.prompt`');
    expect(skill!.template).toContain('descriptor is a closer match');
    expect(skill!.template).toContain('Orchestrator owns final confidence');
    expect(skill!.template).toContain('terminal-unreconciled');
    expect(skill!.template).toContain('Reconcile and ignore are bookkeeping only');
    expect(skill!.template).toContain('Claiming cancel acknowledgement proves the worker stopped');
    expect(skill!.template).toContain('Treat installs, builds, formatters, generators, and tests as mutations');
    expect(skill!.template).toContain('`hive_status` is not that surface');
    expect(skill!.template).toContain('Allowed foreground/blocking escape reasons: dependency, risk, simplicity, user interaction, ownership conflict, or lifecycle/board concerns.');
    expect(skill!.template).toContain('Gate-closed sessions use normal blocking `task()` wait mode');
    expect(skill!.template).toContain('Background is a wait mode, not the definition of parallelism');
    expect(skill!.template).toContain('Independent ordinary Scout, advisor, and reviewer tasks can run in parallel');
    expect(skill!.template).toContain('Every Forager lane, including report-only diagnosis');
    expect(skill!.template).not.toContain('hive_existing_workspace_start');
    expect(skill!.template).not.toContain('hive_execution_prepare');
    expect(skill!.template).toContain('Direct checkout work is unmanaged OpenCode work');
    expect(skill!.template).not.toContain('binding-in-progress');
    expect(skill!.template).not.toContain('wait for the native correlation event');
    expect(skill!.template).toContain('Gate-closed Forager launch (blocking wait mode)');
    expect(skill!.template).toContain('Gate-open Forager launch (background wait mode)');
    expect(skill!.template).toContain('hive_adhoc_worktree_create');
    expect(skill!.template).toContain('Reconcile each board row exactly once');
    expect(skill!.template).toContain("subagent_type: 'forager-worker'");
    expect(skill!.template).toContain('Nested delegation from any subagent session');
    expect(skill!.template).toContain('Treat prompt acknowledgment as notification only');
    expect(skill!.template).toContain('waitingForNativeCompletion');
    expect(skill!.template).toContain('completionNotificationsPending > 0');
    expect(skill!.template).toContain('reconcileItemsRequired == 0');
    expect(skill!.template).toContain('schedulerGuidance.reason');
    expect(skill!.template).toContain('wait_for_native_completion_notification');
    expect(skill!.template).toContain('recommendedNextAction');
    expect(skill!.template).toContain('orchestrationBurden');
    expect(skill!.template).toContain('pure final verification outside `## Tasks`');
    expect(skill!.template).toContain('## Final Verification');
    expect(skill!.template).toContain('one small, local, immediately verified integration fix');
    expect(skill!.template).toContain('There is no exact-one-read or exact-one-write quota');
    expect(skill!.template).toContain('one independently answerable question or one primary goal');
    expect(skill!.template).toContain('one owner, one expected output, and one verification/return contract');
    expect(skill!.template).toContain('Native `task_id` resume is allowed');
    expect(skill!.template).toContain('observe-only board handles');
    expect(skill!.template).toContain('Compaction may re-anchor a currently running worker; it is not re-delegation');
    expect(skill!.template).toContain('Lane count never selects wait mode');
    expect(skill!.template).toContain(
      'Waiting, pending, terminal-unreconciled, stale, or ownership-overlapping lanes need a board action'
    );
    expect(skill!.template).not.toContain('Treat unresolved lanes as blockers.');
    expect(skill!.template).toContain('tightly coupled code, tests, docs, and multiple files');
    expect(skill!.template).toContain('consume the lane boundaries and ready wave from `orchestrating-ad-hoc-work`; do not redefine them here');
    expect(skill!.template).toContain('second patch/test loop');
    expect(skill!.template).toContain('behavior-contract change');
    expect(skill!.template).toContain('manual task or plan amendment');
    expect(skill!.template).toContain('do not edit `.hive/background-jobs.json` directly');
    expect(skill!.template).toContain('archived by the tool and hidden from normal status');
    expect(skill!.template).toContain('Forgotten terminal jobs');
    expect(skill!.template).toContain('Wait-only polling');
    expect(skill!.template).toContain('Manual board mutation');
    expect(skill!.template).not.toContain('poll when available');
    expect(skill!.template).not.toContain('@explorer');
    expect(skill!.template).not.toContain('subtask');
    expect(skill!.template).not.toContain('tmux');
    expect(skill!.template).not.toContain('zellij');
    expect(skill!.template).not.toContain('hive_background_task');
    expect(skill!.template).not.toContain('hive_background_output');
  });

  it('keeps the gate-open background example self-contained and reconcile after native completion', () => {
    const skill = BUILTIN_SKILLS.find((entry) => entry.name === 'background-delegation')!;
    const example = skill.template.match(/Gate-open Forager launch \(background wait mode\):\n\n```ts\n([\s\S]*?)\n```/)?.[1];
    expect(example).toBeDefined();
    expect(example!.indexOf('hive_adhoc_worktree_create')).toBeLessThan(example!.indexOf('hive_background_reconcile'));
    expect(example).toContain('background: true');
  });

  it('bundled skill content does not contain removed Hive skill tool references', () => {
    const removedHiveSkillTool = ['hive', 'skill'].join('_');

    for (const entry of BUILTIN_SKILLS) {
      expect(entry.template).not.toContain(removedHiveSkillTool);
    }
  });

  it('teaches AGENTS.md as progressive placement rather than a repository map', () => {
    const skill = BUILTIN_SKILLS.find((entry) => entry.name === 'agents-md-mastery');

    expect(skill).toBeDefined();
    expect(skill!.description).toMatch(/^Use when /);

    const template = skill!.template;
    expect(template).toContain(
      'If I delete this sentence, could a competent agent reasonably make a different decision?'
    );
    expect(template).toContain('narrowest directory where it remains true');
    expect(template).toContain('Do not map the repository in AGENTS.md');
    expect(template).toContain('Name the current choice');
    expect(template).toContain('Do not record rejected alternatives');
    expect(template).toContain('Do not invent build commands');
    expect(template).toContain('writing-for-agents');
    expect(template).not.toContain('packages/hive-core');
    expect(template).not.toContain('Keep total under 500 lines');
    expect(template).not.toContain('Gotchas section exists and is populated');
    expect(template).not.toContain('Build/test commands are first');
    expect(template).not.toContain('Missing build/test commands');
    expect(template).not.toContain('Auth lives in `/lib/auth`');
  });

  it('bundles writing-for-agents as universal reference for agent-consumed documents', () => {
    const skill = BUILTIN_SKILLS.find((entry) => entry.name === 'writing-for-agents');

    expect(skill).toBeDefined();
    expect(skill!.description).toContain('skills, subagent prompts, instructions, and pointer architecture');

    const template = skill!.template;
    expect(template).toContain('Reference for writing any document an agent consumes');
    expect(template).toContain('Context pointers');
    expect(template).toContain('The two loads');
    expect(template).toContain('Information hierarchy');
    expect(template).toContain('Steps and completion criteria');
    expect(template).toContain('Leading words');
    expect(template).toContain('SKILL-MECHANICS.md');
    expect(template).toContain('Pruning');
  });

  it('bundles context-engineering as on-demand untrusted-knowledge retrieval guidance', () => {
    const skill = BUILTIN_SKILLS.find((entry) => entry.name === 'context-engineering');

    expect(skill).toBeDefined();
    expect(skill!.description).toMatch(/^Use when /);
    expect(skill!.description).toContain('Agent Hive');
    expect(skill!.description).toContain('catalog');
    expect(skill!.description).toContain('recovering');

    const template = skill!.template;
    expect(template).toContain('Load this skill on demand');
    expect(template).toContain('Do not globally load its full body');
    expect(template).toContain('untrusted knowledge');
    expect(template).toContain('not AGENTS.md');
    expect(template).toContain('description');
    expect(template).toContain('read_when');
    expect(template).toContain('locale-independent ASCII A-Z');
    expect(template).toContain('complete: true');
    expect(template).toContain('Do not mass-read every note');
    expect(template).toContain('The first match is not proof of sufficient evidence');
    expect(template).toContain('hive_context_read({ view: "catalog"');
    expect(template).toContain('hive_context_read({ name: "auth-decisions"');
    expect(template).toContain('expectedContentHash');
    expect(template).toContain('expectedContentHashes');
    expect(template).toContain('scanChars');
    expect(template).toContain('context_inventory_too_large');
    expect(template).toContain('context_cursor_stale');
    expect(template).toContain('start a new named read without a cursor');
    expect(template).toContain('Never delete an index to restore classification');
    expect(template).toContain('accountability');
    expect(template).toContain('There is no auto-renewal, metadata-only renewal command, auto-promotion, auto-consolidation, or archive on feature completion');
    expect(template).toContain('does not update a running assignment');
    expect(template).toContain('No agent may silently skip required configured review targets');
    expect(template).not.toContain('load all context');
  });

  it('teaches context-engineering catalog and hash integrity without role runtime gates', () => {
    const skill = BUILTIN_SKILLS.find((entry) => entry.name === 'context-engineering');

    expect(skill).toBeDefined();
    const template = skill!.template;
    expect(template).toContain('Foragers and reviewers write feature and project context through that hash check');
    expect(template).toContain('Scout is read-only');
    expect(template).toContain('Archive is primary-only');
    expect(template).toContain('there is no extra role runtime authorization');
    expect(template).toContain('Error notices are not empty/current catalogs');
    expect(template).toContain('`.hive/sessions.json` is canonical global session truth');
    expect(template).toContain('Never replay historical prompt text as a new assignment');
    expect(template).toContain('Plugin restart does not continue old live workers');
    expect(template).toContain('do not follow a stored former root as catalog truth');
    expect(template).not.toContain('Workers must not replace existing context');
    expect(template).not.toContain('primary-management only');
    expect(template).not.toContain('Attempt identity is immutable');
    expect(template).not.toContain('quarantined');
    expect(template).not.toContain('not_started');
    expect(template).not.toContain('The old recipient remains denied');
  });

  it('scopes only Hive-tool workflow skill descriptions to Agent Hive', () => {
    const hiveToolPattern = /\bhive_[a-zA-Z0-9_]+\b/;

    for (const entry of BUILTIN_SKILLS) {
      if (hiveToolPattern.test(entry.template)) {
        expect(entry.description).toContain('Agent Hive');
        continue;
      }

      expect(entry.description).not.toContain('Agent Hive workflow skill');
    }
  });

  it('ships writing-for-agents with its companion files and license', () => {
    const skillsDir = resolvePackagedSkillsDir();
    const writingSkillDir = path.join(skillsDir, 'writing-for-agents');

    expect(existsSync(path.join(writingSkillDir, 'SKILL.md'))).toBe(true);
    expect(existsSync(path.join(writingSkillDir, 'SKILL-MECHANICS.md'))).toBe(true);
    expect(existsSync(path.join(writingSkillDir, 'LICENSE'))).toBe(true);
    expect(existsSync(path.join(writingSkillDir, 'UPSTREAM.md'))).toBe(true);
  });

  it('discovers both complexity skills with distinct scopes and read-only contracts', () => {
    const cases = [
      {
        name: 'complexity-review',
        scope: 'explicit diff or bounded named scope',
        fallback: 'current staged, unstaged, and relevant nonignored untracked changes',
        boundary: 'never widen it into an audit',
        noFindings: 'report the inspected scope and meaningful limitations before ending with exactly',
      },
      {
        name: 'complexity-audit',
        scope: 'explicit roots or set of codebases',
        fallback: 'use the current worktree',
        boundary: 'Do not substitute the canonical checkout or the skill installation directory',
        noFindings: 'report the inspected roots and meaningful limitations before ending with exactly',
      },
    ];

    for (const { name, scope, fallback, boundary, noFindings } of cases) {
      const parsed = matter(readRepoFile(`packages/opencode-hive/skills/${name}/SKILL.md`));
      const skill = {
        name: parsed.data.name,
        description: parsed.data.description,
        template: parsed.content.trim(),
      };

      expect(skill.description).toMatch(/^Use when the operator explicitly asks/);
      expect(skill.template).toContain('one read-only complexity pass');
      expect(skill.template).toContain('same agent');
      expect(skill.template).toContain('Do not call `task`, delegate, fan out, or switch agents');
      expect(skill.template).toContain('Do not edit files');
      expect(skill.template).toContain('write state');
      expect(skill.template).toContain(scope);
      expect(skill.template).toContain(fallback);
      expect(skill.template).toContain(boundary);
      expect(skill.template).toContain(noFindings);
      expect(skill.template).toContain('first-party source, tests, configuration, and manifests');
      expect(skill.template).toContain('generated files');
      expect(skill.template).toContain('meaningful contracts, boundary validation, and tests');
      expect(skill.template).toContain('A single caller is not enough');
      expect(skill.template).toContain('safe equivalence rationale');
      expect(skill.template).toContain('Do not guess line, dependency, or savings totals');
      expect(skill.template).toContain('Ship or readiness claims');
      expect(skill.template).toContain('No evidence-backed complexity findings in the inspected scope.');
    }

    for (const content of [
      readRepoFile('README.md'),
      readRepoFile('packages/opencode-hive/README.md'),
      readRepoFile('docs/OPERATOR-GUIDE.md'),
    ]) {
      expect(content).toContain('complexity-review');
      expect(content).toContain('complexity-audit');
      expect(content).not.toContain('$ARGUMENTS');
    }
  });

  it('keeps packaged skill sources valid and uniquely named', () => {
    expect(BUILTIN_SKILLS.length).toBeGreaterThan(0);
    expect(new Set(BUILTIN_SKILLS.map((skill) => skill.name)).size).toBe(BUILTIN_SKILLS.length);
    for (const skill of BUILTIN_SKILLS) {
      expect(skill.name.trim().length).toBeGreaterThan(0);
      expect(skill.description.trim().length).toBeGreaterThan(0);
    }
  });
});
