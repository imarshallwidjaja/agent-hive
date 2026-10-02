import { describe, it, expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AdhocWorktreeService,
  BackgroundJobService,
  BUILT_IN_AGENT_NAMES,
  ConfigService,
  CUSTOM_AGENT_BASES,
  CUSTOM_AGENT_RESERVED_NAMES,
  DEFAULT_HIVE_CONFIG,
  getNextIndexedFeatureDirectoryName,
  RepositoryManifestService,
  WorktreeService,
} from 'hive-core';
import { HIVE_TOOL_NAMES } from '../utils/plugin-manifest.js';
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
  it('packages the design, explanation, and writing families with self-contained references and provenance', () => {
    const root = resolvePackagedSkillsDir();
    const names = ['code-design-principles', 'how', 'why', 'writing-policy', 'writing-for-humans', 'stop-slop', 'humanizer'];
    for (const name of names) {
      const skill = BUILTIN_SKILLS.find((entry) => entry.name === name);
      expect(skill, name).toBeDefined();
      expect(skill!.description, name).toMatch(/^Use when /);
      const directory = path.join(root, name);
      expect(existsSync(path.join(directory, 'UPSTREAM.md')), name).toBe(true);
      for (const relative of readdirSync(directory, { recursive: true, encoding: 'utf8' })) {
        if (!relative.endsWith('.md')) continue;
        const file = path.join(directory, relative);
        const content = readFileSync(file, 'utf8');
        for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
          const target = match[1];
          if (/^https?:|^#/.test(target)) continue;
          const resolved = path.resolve(path.dirname(file), target.split('#')[0]);
          expect(path.relative(directory, resolved).startsWith('..'), `${name}/${relative}: ${target}`).toBe(false);
          expect(existsSync(resolved), `${name}/${relative}: ${target}`).toBe(true);
        }
      }
    }
  });

  it('gives writing routing and its overlays distinct ownership without compulsory cleanup', () => {
    const get = (name: string) => BUILTIN_SKILLS.find((entry) => entry.name === name)!.template;
    expect(get('writing-policy')).toContain('Load depth skills only when the case matches');
    expect(get('writing-policy')).toContain('Parent-loaded skills do not imply child loading');
    expect(get('writing-policy')).toContain('does not authorize delegation');
    expect(get('writing-for-humans')).toContain('A rewrite adds nothing');
    expect(get('writing-for-humans')).toContain('This is not an absolute ban');
    expect(get('stop-slop')).toContain('never add, merge, or remove list items for cadence');
    expect(get('humanizer')).toContain('Do not invent personality');
    expect(get('humanizer')).toContain('sample outranks these defaults');
    for (const name of ['stop-slop', 'humanizer']) expect(get(name)).toContain('Load with `writing-for-humans`');
  });

  it('separates design depth, present behavior, and historical rationale from execution authority', () => {
    const design = BUILTIN_SKILLS.find((entry) => entry.name === 'code-design-principles')!;
    const how = BUILTIN_SKILLS.find((entry) => entry.name === 'how')!;
    const why = BUILTIN_SKILLS.find((entry) => entry.name === 'why')!;
    expect(design.description).toContain('Not for mechanical edits');
    expect(design.template).toContain('existing scope, authority, and output contract');
    expect(how.template).toContain('primary owns the explanation');
    expect(how.template).toContain('"Where should this live?"');
    expect(why.description).toContain('explicitly asks for historical design rationale');
    expect(why.template).toContain('not operator constraints');
    expect(why.template).toContain('unavailable source is not a negative search result');
    expect(why.template).toContain('does not authorize code changes or external writes');
    const lifecycle = readFileSync(path.join(resolvePackagedSkillsDir(), 'code-design-principles/references/lifecycle-and-migration.md'), 'utf8');
    expect(lifecycle).toContain('No external users depend on backward compatibility');
    expect(lifecycle).toContain('does not authorize deleting a lock');
  });

  it('discovers pr-writing for author and reviewer drafts without publication authority', () => {
    const skill = BUILTIN_SKILLS.find((entry) => entry.name === 'pr-writing');

    expect(skill).toBeDefined();
    expect(skill!.description).toMatch(/^Use when /);
    for (const trigger of ['title', 'description', 'general code review comment', 'inline review comment']) {
      expect(skill!.description).toContain(trigger);
    }
    for (const requirement of [
      'applicable template', 'current candidate', 'For an author title or description',
      'tradeoffs, migrations, and verification', 'For reviewer comments',
      'relevant consumer or reader consequence', 'tradeoff or question',
      'unresolved material concerns', 'current source anchor',
      'When the operator asks for findings or comments without requesting solutions, finish each finding at the observed condition and consequence',
      'resolved or nonissue investigation notes out of public comments unless they answer an existing discussion',
    ]) expect(skill!.template).toContain(requirement);
    expect(skill!.template).toContain('a full `/dash-review` is not a prerequisite');
    expect(skill!.template).toContain('does not authorize posting');
    expect(skill!.template).toContain('only when the operator explicitly selects one');
  });

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

  it('uses host finding bars for adversarial falsification and permits clean results', () => {
    const template = BUILTIN_SKILLS.find((entry) => entry.name === 'adversarial-review')!.template;
    expect(template).toContain('Try to falsify the baseline');
    expect(template).toContain('A failed attempt to find a defect is a legitimate clean result');
    expect(template).toContain('Severity:');
    expect(template).toContain('severity separately from certainty');
    expect(template).toContain('A plausible failure path alone is a lead');
    expect(template).toContain('REVISE`: supported material failure or applicable requirement violation');
    expect(template).toContain('approach-advisor` gives advice without an approval verdict');
    expect(template).toContain('simplicity-reviewer` keeps `SIMPLIFY/MINOR_TWEAKS/ALREADY_MINIMAL/NEEDS_DISCUSSION`');
    expect(template).not.toContain('Assume the baseline missed something material');
    expect(template).not.toContain('at least one critical/high/medium finding needs action');
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
    expect(template).toContain('Compare genuinely different shapes at material uncertain decisions');
    expect(template).toContain('not after every paragraph');
    expect(template).toContain('without asking for the same authority again');
    expect(template).not.toContain('200-300 words');
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
      'binding repository/operator requirements',
      'broader coherent existing check',
      'integrated-only deferral',
      'expected signal',
      'unique integrated acceptance',
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
    expect(template).toContain('hive_feature_complete` does not enforce these checks');
  });

  it('plans candidate-bound gates and reconciles amendment evidence before approval', () => {
    const template = BUILTIN_SKILLS.find((entry) => entry.name === 'writing-plans')!.template;
    const section = template.slice(template.indexOf('## Verification Planning'), template.indexOf('## Worker-Branch Task Granularity'));

    for (const token of [
      'local iteration', 'task acceptance', 'integration checkpoint', 'release certification',
      'passed and applies', 'invalidated', 'not run', 'failed', 'blocked',
      'retain', 'replace', 'invalidate', 'defer', 'drop',
    ]) {
      expect(section, token).toContain(`\`${token}\``);
    }
    for (const requirement of [
      'canonical test layer',
      'candidate and input identity',
      'A cheap gate with no mutable inputs needs one line: owner, command, expected signal, and "no mutable inputs"',
      'replaces the task\'s current `Verify` list and decision table',
      'A certificate is the set of candidate-bound gate records',
      'A record counts only while it is `passed and applies`',
      'an approved explicit gate stays binding until an approved amendment',
      'A blanket "preserve all earlier gates" is unreconciled',
      'what failure can it detect from this delta',
      'why is a cheaper owning gate insufficient',
      'is the same gate already due at a later boundary',
      'what role does each run serve',
      'Reproduce the failure red with the smallest valid check at the owning layer',
      'Verify the owner and affected consumers',
      'Physical-STAC correction.',
      'Justified broad rerun.',
    ]) {
      expect(section, requirement).toContain(requirement);
    }
    const recovery = [
      'Retain the first failure and its cleanup evidence',
      'Reproduce the failure red with the smallest valid check at the owning layer',
      'Verify the owner and affected consumers',
      'Decide from input impact whether the certificate is invalidated',
    ].map((step) => section.indexOf(step));
    expect(recovery.every((index) => index >= 0)).toBe(true);
    expect(recovery).toEqual([...recovery].sort((a, b) => a - b));
    expect(template).toContain('replacing each rather than appending');
    expect(template).toContain('- [Integrated acceptance gate record per Verification Planning; match any task-named integrated-only deferral]');
  });

  it('ties verification claims to observed output and the candidate and inputs tested', () => {
    const skill = BUILTIN_SKILLS.find((entry) => entry.name === 'verification');
    const template = skill!.template;

    expect(skill).toBeDefined();
    expect(skill!.description).not.toContain('fresh');
    expect(template).toContain('actual command output or tool-result evidence');
    expect(template).toContain('Worker reports are attributed evidence, not independent verification');
    expect(template).toContain('A source-backed trace can expose tool output');
    expect(template).toContain('is not a result cache');
    expect(template).toContain('Session recency neither proves nor invalidates evidence');
    expect(template).toContain('relevant dirty changes');
    expect(template).toContain('fixtures, configuration, toolchain, generated artifacts, and live or deployed state');
    expect(template).toContain('A branch result proves that branch only');
    expect(template).toContain('task-named integrated-only deferral');
    expect(template).toContain('skipped, unrun, failed, or blocked are not PASS');
    expect(template).toContain('An unexplained green retry does not resolve an intermittent failure');
    expect(template).toContain('Once applicable required evidence and reviews are sufficient, stop');
    expect(template).toContain('Any required `FAIL` makes the verdict `FAIL`');
    expect(template).toContain('an empty or incomplete set is missing proof');
    expect(template).toContain('A required `PARTIAL`, `UNVERIFIED`, or `BLOCKED` result, or any other missing required proof, prevents `PASS`');
    expect(template).toContain('use `PARTIAL` only when an environmental or tool limitation is the sole reason required proof is missing');
    expect(template).toContain('A final `FAIL` means required acceptance failed or remains unproven; it does not imply that an executed command exited unsuccessfully');
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

  it('keeps each plan feature-scoped and treats overlap as an execution placement concern', () => {
    const template = BUILTIN_SKILLS.find((entry) => entry.name === 'writing-plans')!.template;

    expect(template).toContain('one feature per plan');
    expect(template).toContain('Cross-feature overlap does not block plan approval');
    expect(template).toContain('materially unresolved');
    expect(template).toContain('Unresolved plan comments still block approval');
    expect(template).toContain('Do not invent automatic cross-feature dependencies');
    expect(template).toContain('name every consumer and assign each required consumer update to a task');
    expect(template).toContain('every `###` heading must be `### N. Title`');
    expect(template).toContain('one `replace_section` on `["Tasks"]`');
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
    expect(skill!.template).toContain('Every returned result is terminal');
    expect(skill!.template).toContain('Every returned result is terminal, so every follow-up uses a fresh child session');
    expect(skill!.template).toContain('one terminal report');
    expect(skill!.template).toContain('Pass `task_id` only when explicit operator instruction or runtime-owned interruption recovery authorizes continuation');
    expect(skill!.template).toContain('If the child may still be active or its lifecycle is uncertain');
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
    expect(template).toContain('Architect as primary or child routes multi-step trace/evidence questions and known native session/call identities to `hive-helper`');
    expect(template).toContain('Helper is read-only and terminal');
    expect(template).toContain('without loading the primary-only `background-delegation` skill');
    expect(template).toContain('Paging a trace, drift comparison, and interrupted-worker evidence packets belong to Helper');
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
    expect(skill!.template).toContain('When running as a primary under the gate, load `background-delegation`');
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
    expect(template).toContain('Required review, repository/operator checks, and lane verification each gate merge');
    expect(template).toContain('selected integrated acceptance');
    expect(template).toContain('including binding repository/operator checks and every named deferral');
    expect(template).toContain('owner, prerequisite, command, and expected signal');
    expect(template).toContain('batch live checks only when their prerequisites and mutable state are compatible');
    expect(template).toContain('If the session ends with a required obligation outstanding, report the batch incomplete');
    expect(template).toContain('An unexplained green retry does not resolve an intermittent failure');
    expect(template).not.toContain('full integrated canonical verification result is recorded and passing');
  });

  it('routes ad-hoc work and documents verification scope for operators', () => {
    const rootReadme = readRepoFile('README.md');
    const operatorGuide = readRepoFile('docs/OPERATOR-GUIDE.md');
    const pluginReadme = readRepoFile('packages/opencode-hive/README.md');

    for (const content of [readRepoFile('AGENTS.md'), rootReadme, operatorGuide, pluginReadme]) {
      expect(content).toContain('orchestrating-ad-hoc-work');
      expect(content).toMatch(/background execution/);
      expect(content).toMatch(/more than one worker attempt or turn/);
    }
    expect(rootReadme).toContain('A task-branch result does not establish integrated acceptance');
    expect(pluginReadme).toContain('every integrated-only deferral named by a task');
    expect(pluginReadme).toContain('unexplained green retry does not resolve the failure');
    expect(operatorGuide).toContain('early, feasibility, or pre-merge gates');
    expect(operatorGuide).toContain('broader coherent existing check');
    expect(operatorGuide).toContain('A branch result never proves integrated acceptance');
    expect(operatorGuide).toContain('run additional checks only for a named gap, invalidation, or new risk');
    expect(operatorGuide).toContain('the tool does not enforce verification gates');
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
    expect(dispatch).toContain("Sync and manual creation reject invalid dependencies of unfinished tasks; done and cancelled tasks' dependencies are history.");
    expect(dispatch).toContain('Only `done` satisfies a dependency, so a task that depends on a cancelled task stays blocked');
    expect(dispatch).toContain('In ad-hoc mode, return result state and its exact pin to `orchestrating-ad-hoc-work`');
    expect(dispatch).toContain('In feature-task mode, follow binding repository/operator checks and the plan\'s task and final-verification gates');
    expect(dispatch).toContain('In ad-hoc mode, return result and resource state to `orchestrating-ad-hoc-work`');
    expect(dispatch).toContain('selected integrated acceptance');
    expect(dispatch).toContain('each named integrated deferral');
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
    expect(skill!.template).toContain('Forager assignment');
    expect(skill!.template).toContain('In gate-closed sessions use blocking native `task()`');
    expect(skill!.template).toContain('Risk-Tier Review Routing');
    expect(skill!.template).toContain('Post-Batch Code Review');
    expect(skill!.template).toContain('explicit operator direction');
    expect(skill!.template).toContain('A test failure is evidence to investigate');
    expect(skill!.template).toContain('One implementation assignment normally maps to one numbered task');
    expect(skill!.template).toContain('Never reconstruct blocker details from worker prose or task traces');
    expect(skill!.template).toContain('explicit status leaving blocked');
    expect(skill!.template).toContain('explicitly admitted native general exception');
    expect(skill!.template).toContain('Helper is read-only investigation, not an execution lane');
    expect(skill!.template).toContain('Other mutation-capable or unknown task targets are denied');
    expect(skill!.template).toContain('Architect retains its bounded planning lane');
    expect(skill!.template).not.toContain('Non-Hive mutation-capable or unknown task targets are denied');
    expect(skill!.template).toContain('execution-decisions');
    expect(skill!.template).toContain('Dependencies guide sequencing');
    expect(skill!.template).toContain('Explicit null suppresses fallback');
    expect(skill!.template).toContain('primary calls merge itself');
    expect(skill!.template).toContain('For multi-step forensics (paging a trace, drift comparison, or interrupted-worker evidence packets)');
    expect(skill!.template).toContain('Hive task: <task-folder>');
    expect(skill!.template).toContain('Promote accepted Forward obligations');
    expect(skill!.template).toContain('explicit feature target');
    expect(skill!.template).toContain('Cross-feature prerequisites block affected execution tasks or lanes');
    expect(skill!.template).toContain('Do not infer or create automatic cross-feature dependencies');
    expect(skill!.template).toContain('Keep approved repository/operator checks and required early, feasibility, or pre-merge gates');
    expect(skill!.template).toContain('actual command output and the candidate plus relevant mutable inputs');
    expect(skill!.template).toContain('a branch result does not establish integrated acceptance');
    expect(skill!.template).toContain('every task-named integrated deferral');
    expect(skill!.template).toContain('After a correction, retain the failure evidence');
    expect(skill!.template).toContain('reproduce the first failure with the smallest valid check before rerunning it');
    expect(skill!.template).toContain("request that amendment through the primary prompt's amendment and approval procedure");
    expect(skill!.template).toContain('An approved explicit gate stays binding until an approved amendment retains, replaces, defers, or drops it');
    expect(skill!.template).toContain('Missing output or uncertain applicability means run the required check on the current target');
  });

  it('owns milestone closure, resumption, and stopping semantics for canonical consumers', () => {
    const executing = BUILTIN_SKILLS.find((entry) => entry.name === 'executing-plans')!.template;
    expect(executing).toContain('hive_status({ feature })');
    expect(executing).toContain('one unique task folder/title within that feature');
    expect(executing).toContain('Ask for clarification if the feature, target, or any companion is ambiguous or missing');
    expect(executing).toContain('A bare target request has no companions; never infer them from task numbers, readiness, or topic');
    expect(executing).toContain('Only if all requested roots are already `done`');
    expect(executing).toContain('an already-done target does not short-circuit unfinished companions');
    expect(executing).toContain('milestone satisfied without dispatch');
    expect(executing).toContain("union of each requested root's own stored `dependsOn` edges recursively, including each root");
    expect(executing).toContain('Deduplicate roots and shared prerequisites');
    expect(executing).toContain('Include companion prerequisites even when numbered beyond the target');
    expect(executing).toContain('resolved implicit sequential shorthand');
    expect(executing).toContain('never infer edges from numbering or follow reverse dependents');
    expect(executing).toContain('Stop traversal at `done` tasks: their outgoing edges are historical');
    expect(executing).toContain('Only `done` satisfies a dependency');
    expect(executing).toContain('Cancelled or missing prerequisites are blockers');
    expect(executing).toContain('`pending`, `in_progress`, `blocked`, `failed`, and `partial` are unfinished, not satisfied');
    expect(executing).toContain('A cancelled requested root is a blocker');
    expect(executing).toContain('Companions expand requested scope, not dependency edges');
    expect(executing).toContain('Schedule only the combined unfinished closure by actual dependencies and existing ownership/resource rules');
    expect(executing).toContain('Inspect live or uncertain workers before dispatch; do not launch overlapping replacements');
    expect(executing).toContain('Exclude unrelated tasks and descendants unless the operator explicitly expands scope');
    expect(executing).toContain('Re-read status between batches and on each new run/continue request');
    expect(executing).toContain('recompute the union for all requested roots from updated stored edges each time, including approved and synced dependency amendments');
    expect(executing).toContain('target AND every explicitly named companion verified, integrated where applicable, and marked `done`');
    expect(executing).toContain('Wait for a slower independent companion even if the target finishes first');
    expect(executing).toContain('applicable checks, required review, and cleanup completed');
    expect(executing).toContain('call `hive_feature_complete` merely because the milestone was achieved while other tasks remain');
    expect(executing).toContain('completed and remaining combined closure scope, other remaining feature tasks');
    expect(executing).toContain('concrete continuation prompt');
    expect(executing).toContain('When no unfinished feature tasks remain after achievement, emit `Run final verification for feature "<feature>" and complete it only after the required checks pass.` with the exact feature substituted');
    expect(executing).toContain('Stop at the requested milestone and hand off final verification instead of executing it in that request');
    expect(executing).toContain('Apply the primary prompt\'s existing full-feature verification/completion procedure');
    expect(executing).toContain('including every `## Final Verification` obligation and deferred check, required review, and applicable cleanup');
    expect(executing).toContain('Call `hive_feature_complete` only after the required checks pass');
    expect(executing).toContain('milestone completion does not waive whole-feature final verification');
    expect(executing).toContain('repeat only within its combined unfinished prerequisite closure until all requested roots are done');
    expect(executing).toContain('For whole-feature execution, after all tasks complete');

    const hiveTemplate = readRepoFile('packages/hive-core/templates/skills/hive.md');
    const dispatch = BUILTIN_SKILLS.find((entry) => entry.name === 'dispatching-parallel-agents')!.template;
    for (const consumer of [hiveTemplate, dispatch]) {
      expect(consumer).toContain('run/continue a feature until a target task is complete/done');
      expect(consumer).toContain('executing-plans');
      expect(consumer).toContain('apply Target Task Milestones before');
      expect(consumer).toContain('Explicit companion suffixes use the same procedure');
    }
  });

  it('routes accepted review work without promoting optional feedback to automatic fixes', () => {
    const executing = BUILTIN_SKILLS.find((entry) => entry.name === 'executing-plans')!.template;
    const adhoc = BUILTIN_SKILLS.find((entry) => entry.name === 'orchestrating-ad-hoc-work')!.template;
    expect(executing).toContain('Collect required reviews on the settled candidate and assess findings before routing work');
    expect(executing).toContain('Route accepted work through this decision tree');
    expect(executing).toContain('| Accepted local correction to the completed batch | **Same implementation lane**');
    expect(executing).toContain('fresh worker when delegated');
    expect(executing).not.toContain('| Minor / local to the completed batch | **Inline fix**');
    expect(adhoc).toContain("Apply the primary's Review Follow-Up guidance to settled lane reviews before remediation and closure");
    expect(adhoc).toContain('preserve usable unaffected review coverage');
  });

  it('defers task report ownership and interruption recovery to the primary prompt', () => {
    const executing = BUILTIN_SKILLS.find((entry) => entry.name === 'executing-plans')!.template;
    const context = BUILTIN_SKILLS.find((entry) => entry.name === 'context-engineering')!.template;
    const hiveSkill = readRepoFile('packages/hive-core/templates/skills/hive.md');
    expect(executing).toContain("read the report it published and record status and a compact summary under the primary prompt's Task Report Ownership rules");
    expect(executing).toContain("follow the primary prompt's Interrupted Worker Recovery rules; a failed run does not fail the task");
    expect(executing).not.toContain('record its summary and terminal report');
    expect(context).toContain('Task reports and `handoff.md` are task records, not managed context. Do not copy report history into context.');
    expect(hiveSkill).toContain('A failed or interrupted worker run does not fail the task');
    expect(hiveSkill).not.toContain('hive_task_update({ task, status: "failed", summary, report })');
    const recoverySteps = [
      '1. Confirm the prior worker and any in-flight subprocess or external effect have stopped',
      '2. Inspect before any cleanup',
      '3. Record what you observed',
      '4. Call `hive_status()`, select the feature only when the selected route is unset or differs, or selection evidence is missing or uncertain under Create Feature above, and launch a fresh worker in the retained worktree',
    ].map((step) => hiveSkill.indexOf(step));
    expect(recoverySteps.every((index) => index >= 0)).toBe(true);
    expect(recoverySteps).toEqual([...recoverySteps].sort((a, b) => a - b));
    expect(hiveSkill).toContain('Do not delete locks, reset, or clean the worktree');
    expect(hiveSkill).toContain('ask Helper for an interrupted-worker evidence packet');
    expect(hiveSkill).toContain('A discovered HEAD is observed, not a verified pin');
    expect(hiveSkill).toContain('If inspection is unavailable, keep known facts and unknowns in your current response; do not claim saved state. Stop before writing or retrying and escalate for supported or operator recovery');
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
    expect(completeDevelopment).toContain('the primary calls `hive_worktree_merge`');
    expect(completeDevelopment).toContain('same-call cleanup');
    expect(completeDevelopment).not.toContain('via `hive-helper`');
    expect(completeDevelopment).toContain('For worktree placement');
    expect(completeDevelopment).toContain('For non-Git or report-only placement');
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

    expect(hiveSkill).toContain('hive_worktree_create({ feature: "feature-name", task: "01-task-name" })');
    expect(hiveSkill).toContain('hive_worktree_create({ feature: "feature-name", task: "02-task-a" })');
    expect(hiveSkill).toContain('hive_feature_select({ feature: "feature-name" })');
    expect(hiveSkill).toContain('subagent_type: "forager-worker"');
    expect(hiveSkill).toContain('hive_task_update({ task: "01-task-name", status: "done", summary, report: closureReport })  # Primary closure report: explains the problem, how the solution works, material issues and their resolutions; cites the worker\'s reportPath');
    expect(hiveSkill).toContain('hive_task_update({ task, status: "blocked"');
    expect(hiveSkill).toContain('strategy: "squash", message:');
    expect(hiveSkill).toContain('Do not call `hive_worktree_merge` again while preserved conflict state is active');
    expect(hiveSkill).not.toContain('hive_worktree_start');
    expect(hiveSkill).not.toContain('taskToolCall');
  });

  it('delegates research by capability and evidence contract in the core hive skill', () => {
    const hiveSkill = readRepoFile('packages/hive-core/templates/skills/hive.md');

    expect(hiveSkill).toContain('Delegate research by operation, required source authority and freshness');
    expect(hiveSkill).toContain('The child selects among capabilities exposed in its own session');
    expect(hiveSkill).toContain('do not prescribe provider or tool IDs');
  });

  it('documents tracked worktree execution and non-Git/report-only exceptions in the core hive skill', () => {
    const hiveSkill = readRepoFile('packages/hive-core/templates/skills/hive.md');

    expect(hiveSkill).toContain('hive_worktree_create');
    expect(hiveSkill).toContain('Non-Git or report-only work may use an explicit existing target');
    expect(hiveSkill).toContain('returns sourceCommit for a legacy single-root workspace or the complete sourceCommits map when persisted repos are present');
    expect(hiveSkill).toContain('hive_worktree_merge({ task: "01-task-name", sourceCommit, expectedTarget,');
    expect(hiveSkill).toContain('hive_worktree_merge({ task: "01-task-name", sourceCommits, expectedTargets,');
    expect(hiveSkill).toContain('Pass its topology-aware source pin plus the unchanged inspected `expectedTarget`');
    expect(hiveSkill).toContain('singleton composites accept matching scalar conveniences');
    expect(hiveSkill).toContain('marking the feature task done');
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
    expect(skill!.template).toContain('In feature-task mode, pass each returned topology-aware pin unchanged');
    expect(skill!.template).toContain('a singleton composite scalar is accepted');
    expect(skill!.template).toContain('In ad-hoc mode, return result state and its exact pin to `orchestrating-ad-hoc-work`');
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
    expect(skill!.template).toContain('Explicit null suppresses fallback');
    expect(skill!.template.match(/hive_feature_select\(\{ feature: "feature-name" \}\)/g)).toHaveLength(1);
    expect(skill!.template).toContain('Batch independent Hive calls in one response/step');
    expect(skill!.template).toContain("same-call `cleanup: 'worktree+branch'`");
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
    expect(skill!.template).toContain('The owning workflow determines placement; create the matching worktree before dispatch for tracked Git writes');
    expect(skill!.template).not.toContain('hive_existing_workspace_start');
    expect(skill!.template).not.toContain('hive_execution_prepare');
    expect(skill!.template).toContain('Direct checkout work is unmanaged OpenCode work');
    expect(skill!.template).not.toContain('binding-in-progress');
    expect(skill!.template).not.toContain('wait for the native correlation event');
    expect(skill!.template).toContain('Gate-closed Forager launch (blocking wait mode)');
    expect(skill!.template).toContain('Gate-open Forager launch (background wait mode)');
    expect(skill!.template).toContain('hive_adhoc_worktree_create');
    expect(skill!.template).not.toContain('hive_adhoc_worktree_create({});');
    expect(skill!.template).toContain('Reconcile each board row exactly once');
    expect(skill!.template).toContain("subagent_type: 'forager-worker'");
    expect(skill!.template).toContain("Nested delegation outside Architect's permitted blocking terminal planning-helper layer");
    expect(skill!.template).toContain('When Architect runs as a primary');
    expect(skill!.template).toContain('When Architect is task-spawned');
    expect(skill!.template).toContain('Background board tools and primary-control operations are denied in children');
    expect(skill!.template).toContain('return board/control requests');
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
    expect(skill!.template).toContain('Every returned result is terminal');
    expect(skill!.template).toContain('Every follow-up after a returned result uses a fresh child session');
    expect(skill!.template).toContain('observe-only board handles');
    expect(skill!.template).toContain('Pass `task_id` only when an explicit operator instruction or explicit runtime-owned interruption-recovery mechanism authorizes continuation');
    expect(skill!.template).toContain('If the child may still be active or its lifecycle is uncertain');
    expect(skill!.template).toContain('Compaction re-anchoring of a currently running worker is distinct from follow-up work');
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

  it('keeps both Forager examples lane-scoped and the gate-open example reconciled after native completion', () => {
    const skill = BUILTIN_SKILLS.find((entry) => entry.name === 'background-delegation')!;
    const gateClosed = skill.template.match(/Gate-closed Forager launch \(blocking wait mode\):\n\n```ts\n([\s\S]*?)\n```/)?.[1];
    const example = skill.template.match(/Gate-open Forager launch \(background wait mode\):\n\n```ts\n([\s\S]*?)\n```/)?.[1];
    expect(gateClosed).toBeDefined();
    expect(example).toBeDefined();
    for (const launch of [gateClosed!, example!]) {
      expect(launch).toContain('hive_repositories_status()');
      expect(launch).toContain('const requestedRepoIds = lane.repoIds;');
      expect(launch).toContain('requestedRepoIds.includes(id)');
      expect(launch).toContain('new Set(requestedRepoIds).size !== requestedRepoIds.length');
      expect(launch).toContain('requestedRepoIds.some((id) => !selectedRepoIds.includes(id))');
      expect(launch).toContain('Placement blocker: lane.repoIds must exactly match repository status IDs');
      expect(launch).toContain('const repoIds = selectedRepoIds;');
      expect(launch).toContain('hive_adhoc_worktree_create({ repoIds })');
    }
    expect(example!.indexOf('hive_adhoc_worktree_create')).toBeLessThan(example!.indexOf('hive_background_reconcile'));
    expect(example).toContain('background: true');
  });

  describe('hive-config', () => {
    const skillDir = path.join(resolvePackagedSkillsDir(), 'hive-config');
    const reference = (name: string) => readFileSync(path.join(skillDir, 'references', name), 'utf8');
    const section = (content: string, heading: string) => {
      const start = content.indexOf(`\n${heading}\n`);
      expect(start, heading).toBeGreaterThan(-1);
      const end = content.indexOf('\n## ', start + heading.length + 2);
      return content.slice(start, end === -1 ? undefined : end);
    };
    const codeNames = (text: string) => [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
    const firstCellNames = (table: string) => table.split('\n')
      .filter((line) => line.startsWith('| `'))
      .flatMap((line) => codeNames(line.split('|')[1]));
    const lineStarting = (content: string, prefix: string) => {
      const line = content.split('\n').find((entry) => entry.startsWith(prefix));
      expect(line, prefix).toBeDefined();
      return line!;
    };
    const jsonBlock = (text: string) => JSON.parse(text.match(/```json\n([\s\S]*?)\n```/)![1]);

    it('is a self-contained skill whose references resolve inside the skill', () => {
      const skill = BUILTIN_SKILLS.find((entry) => entry.name === 'hive-config');
      expect(skill).toBeDefined();
      expect(skill!.description).toMatch(/^Use when /);
      for (const trigger of ['.hive layout', 'which Hive tool owns', 'forensics', 'agent_hive.json', 'custom agents', 'auto-load', 'Not for implementing']) {
        expect(skill!.description).toContain(trigger);
      }
      for (const file of ['runtime-layout.md', 'tool-ownership.md', 'session-forensics.md', 'configuration.md']) {
        expect(skill!.template).toContain(`(references/${file})`);
      }
      for (const relative of readdirSync(skillDir, { recursive: true, encoding: 'utf8' })) {
        if (!relative.endsWith('.md')) continue;
        const file = path.join(skillDir, relative);
        for (const match of readFileSync(file, 'utf8').matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
          if (/^https?:|^#/.test(match[1])) continue;
          const resolved = path.resolve(path.dirname(file), match[1].split('#')[0]);
          expect(path.relative(skillDir, resolved).startsWith('..'), `${relative}: ${match[1]}`).toBe(false);
          expect(existsSync(resolved), `${relative}: ${match[1]}`).toBe(true);
        }
      }
    });

    it('documents exactly the config keys, agent names, and reserved IDs the runtime accepts', () => {
      const schema = JSON.parse(readRepoFile('packages/opencode-hive/schema/agent_hive.schema.json'));
      const overrideSchema = JSON.parse(readRepoFile('packages/opencode-hive/schema/agent_hive.override.schema.json'));
      const configuration = reference('configuration.md');
      const definitions = schema.definitions ?? schema.$defs;

      expect(new Set(firstCellNames(section(configuration, '## Top-level keys')))).toEqual(new Set(Object.keys(schema.properties)));
      expect(new Set(firstCellNames(section(configuration, '## Built-in agents (`agents.<name>`)')))).toEqual(new Set([
        ...Object.keys(definitions.agentConfig.properties),
        ...Object.keys(definitions.routingAgentConfig.properties),
      ]));

      const customSection = section(configuration, '## Custom agents (`customAgents.<id>`)');
      const customExample = Object.values(jsonBlock(customSection).customAgents)[0] as Record<string, unknown>;
      expect(new Set(Object.keys(customExample))).toEqual(new Set(Object.keys(definitions.customAgentConfig.properties)));
      const baseLine = lineStarting(customSection, '- `baseAgent` (required)');
      expect(new Set(codeNames(baseLine.slice(0, baseLine.indexOf('. Primaries'))).slice(1))).toEqual(new Set(CUSTOM_AGENT_BASES));
      const reservedLine = lineStarting(customSection, '- IDs must not contain');
      expect(new Set(codeNames(reservedLine.slice(reservedLine.indexOf('every built-in name'))))).toEqual(
        new Set(CUSTOM_AGENT_RESERVED_NAMES.filter((name) => !(BUILT_IN_AGENT_NAMES as readonly string[]).includes(name))),
      );

      const builtInSection = section(configuration, '## Built-in agents (`agents.<name>`)');
      expect(new Set(codeNames(lineStarting(builtInSection, 'Names: ')).filter((name) => !['dash-reviewer', 'vulnerability-review-primary'].includes(name))))
        .toEqual(new Set(BUILT_IN_AGENT_NAMES));
      const defaults = lineStarting(builtInSection, 'Defaults (shipped):');
      for (const [agent, config] of Object.entries(DEFAULT_HIVE_CONFIG.agents!)) {
        for (const skill of config?.autoLoadSkills ?? []) {
          expect(defaults, `${agent} -> ${skill}`).toContain(`\`${agent}\``);
          expect(defaults, `${agent} -> ${skill}`).toContain(`\`${skill}\``);
        }
      }
      expect(DEFAULT_HIVE_CONFIG.agents!['hive-helper']!.autoLoadSkills).toEqual(['hive-config']);

      const override = jsonBlock(section(configuration, '## Project override (`.hive/agent-hive.override.json`)'));
      for (const key of Object.keys(override)) expect(Object.keys(overrideSchema.properties)).toContain(key);
    });

    it('documents the config validation and auto-load rules hive-core enforces', () => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'hive-config-validation-'));
      const previousHome = process.env.HOME;
      const previousWarn = console.warn;
      try {
        process.env.HOME = root;
        console.warn = () => {};
        const configDir = path.join(root, '.config', 'opencode');
        mkdirSync(configDir, { recursive: true });
        const load = (config: Record<string, unknown>) => {
          writeFileSync(path.join(configDir, 'agent_hive.json'), JSON.stringify({ agentMode: 'unified', ...config }));
          return new ConfigService();
        };
        const configuration = reference('configuration.md');

        expect(load({}).get().agentMode).toBe('unified');
        expect(load({ council: { groups: { review: { description: 'no members' } } } }).get().agentMode).toBe('dedicated');
        expect(configuration).toContain('must include non-empty `members`');
        expect(load({ taskTraceSummarizer: { model: 'a/b', extra: true } }).get().agentMode).toBe('dedicated');
        expect(configuration).toContain('an unknown key inside `taskTraceSummarizer`');
        expect(load({ agents: { 'forager-worker': { extra: true } } }).get().agentMode).toBe('unified');
        expect(configuration).toContain('unknown keys inside an `agents.<name>` declaration (ignored)');

        const onboarding = load({
          agents: { 'forager-worker': { autoLoadSkills: ['onboarding'] }, 'architect-planner': { autoLoadSkills: ['onboarding'] } },
        });
        expect(onboarding.getAgentConfig('forager-worker').autoLoadSkills).not.toContain('onboarding');
        expect(onboarding.getAgentConfig('architect-planner').autoLoadSkills).toContain('onboarding');
        expect(configuration).toContain('`onboarding` is silently dropped for every agent except `hive-master` and `architect-planner`');
      } finally {
        console.warn = previousWarn;
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('lists every specStaleReason hive_status can report', () => {
      const union = readRepoFile('packages/hive-core/src/services/taskService.ts')
        .match(/export type TaskSpecFreshnessReason =([^;]+);/)![1];
      const reasons = [...union.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
      expect(reasons.length).toBeGreaterThan(0);
      expect(readRepoFile('packages/opencode-hive/src/runtime.ts')).toContain("specStaleReason ?? 'freshness_unavailable'");
      const table = section(reference('runtime-layout.md'), '### Spec freshness (`specStaleReason`)');
      expect(new Set(firstCellNames(table))).toEqual(new Set([...reasons, 'freshness_unavailable']));
    });

    it('names every registered Hive tool and no unregistered one in the ownership reference', () => {
      const named = new Set(codeNames(reference('tool-ownership.md')).filter((name) => name.startsWith('hive_')));
      expect(named).toEqual(new Set(HIVE_TOOL_NAMES));
    });

    it('matches the paths and branches hive-core produces', async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'hive-config-skill-'));
      const previousHome = process.env.HOME;
      try {
        process.env.HOME = path.join(root, 'home');
        const layout = reference('runtime-layout.md');
        const configuration = reference('configuration.md');
        const hiveDir = path.join(root, '.hive');

        expect(new ConfigService().getPath()).toBe(path.join(root, 'home', '.config', 'opencode', 'agent_hive.json'));
        expect(configuration).toContain('`~/.config/opencode/agent_hive.json`');
        mkdirSync(hiveDir, { recursive: true });
        writeFileSync(path.join(hiveDir, 'agent-hive.override.json'), JSON.stringify({ agents: { 'hive-helper': { model: 'probe/override' } } }));
        expect(new ConfigService(root).getAgentConfig('hive-helper').model).toBe('probe/override');
        expect(layout).toContain('agent-hive.override.json');

        expect(new RepositoryManifestService(root).getStatus().configPath).toBe(path.join(root, '.hive', 'repositories.json'));
        new BackgroundJobService(root).registerLaunch({ taskId: 'probe', sessionId: 'probe', agentName: 'forager-worker' });
        expect(existsSync(path.join(hiveDir, 'background-jobs.json'))).toBe(true);
        expect(layout).toContain('repositories.json');
        expect(layout).toContain('background-jobs.json');

        expect(getNextIndexedFeatureDirectoryName(root, 'my-feature')).toBe('01_my-feature');
        expect(layout).toContain('<NN>_<feature-name>');
        expect(reference('../SKILL.md')).toContain('`01_my-feature`');

        expect(new WorktreeService({ baseDir: root, hiveDir }).getWorktreePath('feat', '01-task', 'c'))
          .toBe(path.join(hiveDir, '.worktrees', 'feat', '01-task--c'));
        expect(layout).toContain('`.hive/.worktrees/<feature>/<task>--<candidate>`');

        const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
        git('init', '-q');
        git('-c', 'user.email=probe@example.com', '-c', 'user.name=probe', 'commit', '-q', '--allow-empty', '-m', 'probe');
        const adhoc = await new AdhocWorktreeService({ baseDir: root, hiveDir }).create({ runId: 'probe' });
        expect(adhoc.path).toBe(path.join(hiveDir, '.worktrees', 'adhoc', 'probe'));
        expect(adhoc.branch).toBe('hive/adhoc/probe');
        expect(layout).toContain('| Ad-hoc, single root | `.hive/.worktrees/adhoc/<runId>` | `hive/adhoc/<runId>` |');
      } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        rmSync(root, { recursive: true, force: true });
      }
    });
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
    expect(template).toContain('Hive task brief');
    expect(template).toContain('the brief contains no document bodies');
    expect(template).toContain('When shared contracts, repository-wide conventions, or cross-feature decisions matter');
    expect(template).toContain('also inspect the project catalog alongside relevant feature context and read selected matching documents');
    expect(template).toContain('`task` association as a relevance hint alongside `description` and `read_when`');
    expect(template).toContain('not as an exclusive filter or proof of priority, freshness, or authority');
    expect(template).toContain('Tool availability and assignment scope govern access');
    expect(template).toContain('isolated review lanes do not fetch live context metadata or bodies');
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
    expect(template).toContain('Newer notes cannot override standing constraints or an approved task contract');
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

  it('discovers both complexity skills with distinct scopes and one operator-request placeholder', () => {
    const review = BUILTIN_SKILLS.find((entry) => entry.name === 'complexity-review');
    const audit = BUILTIN_SKILLS.find((entry) => entry.name === 'complexity-audit');
    const conversationFallback = 'use ordinary conversation and name the requested skill instead';

    expect(review).toBeDefined();
    expect(audit).toBeDefined();
    expect(review!.template).toContain('diff or bounded named scope');
    expect(review!.template).toContain('current staged, unstaged, and relevant nonignored untracked changes');
    expect(audit!.template).toContain('named roots or codebases');
    expect(audit!.template).toContain('current worktree');

    for (const skill of [review!, audit!]) {
      const operatorRequest = skill.template.slice(skill.template.indexOf('## Operator request'));

      expect(skill.template).toContain('Do not apply fixes');
      expect(operatorRequest.startsWith('## Operator request')).toBe(true);
      expect(skill.template.match(/\$ARGUMENTS/g)).toEqual(['$ARGUMENTS']);
      expect(skill.template.trimEnd().endsWith('$ARGUMENTS')).toBe(true);
      expect(operatorRequest).toMatch(/empty or the literal placeholder/i);
      expect(operatorRequest).toMatch(/request, conversation, or defaults/i);
      expect(skill.template).not.toContain('same agent');
      expect(skill.template).not.toContain('fan out');
      expect(skill.template).not.toContain(conversationFallback);
    }

    for (const content of [
      readRepoFile('README.md'),
      readRepoFile('packages/opencode-hive/README.md'),
      readRepoFile('docs/OPERATOR-GUIDE.md'),
    ]) {
      expect(content).toContain('/complexity-review <scope/philosophy prose>');
      expect(content).toContain('/complexity-audit <scope/philosophy prose>');
    }

    expect(readRepoFile('docs/OPERATOR-GUIDE.md')).toContain(conversationFallback);
    expect(readRepoFile('README.md')).not.toContain(conversationFallback);
    expect(readRepoFile('packages/opencode-hive/README.md')).not.toContain(conversationFallback);
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
