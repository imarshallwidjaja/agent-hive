import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
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
import { OPENCODE_V1_PROFILE, createHostProfile, type HostProfile } from '../runtime/host-profile.js';
import { renderHiveSystemPrompt } from '../hooks/system-hook.js';
import { renderHostMarkdown } from './host-renderer.js';

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

function readSkillReference(skill: string, file: string): string {
  return readFileSync(path.join(resolvePackagedSkillsDir(), skill, 'references', file), 'utf8');
}

function readSkillTemplate(skill: string): string {
  return BUILTIN_SKILLS.find((entry) => entry.name === skill)!.template;
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
    const names = ['code-design-principles', 'how', 'why', 'unslop', 'stop-design-slop', 'writing-for-humans', 'stop-slop', 'humanizer'];
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
    expect(get('unslop')).toContain('Load only the rows the case matches');
    expect(get('unslop')).toContain('Parent-loaded skills do not imply child loading');
    expect(get('unslop')).toContain('does not authorize delegation');
    expect(get('writing-for-humans')).toContain('A rewrite adds nothing');
    expect(get('writing-for-humans')).toContain('This is not an absolute ban');
    expect(get('writing-for-humans')).toContain('Stating what a thing covers preserves its scope');
    expect(get('writing-for-humans')).toContain('A safety prohibition stays at each step where it applies');
    expect(get('writing-for-humans')).toContain('every remaining exclusion meeting the boundaries test');
    expect(get('stop-slop')).toContain('never add, merge, or remove list items for cadence');
    expect(get('stop-slop')).toContain('boundaries test in `writing-for-humans`');
    expect(get('stop-slop')).not.toContain('denials are live constraints');
    expect(get('unslop')).toContain("operator's stated reader outcome");
    expect(get('humanizer')).toContain('Do not invent personality');
    expect(get('humanizer')).toContain('sample outranks these defaults');
    expect(get('humanizer')).toContain('returns the numbered questions');
    expect(get('humanizer')).toContain('a proposal must not become a promise');
    expect(get('humanizer')).toContain('never goes inside a file');
    expect(get('humanizer')).toContain('Write it fresh when the draft is AI-composed');
    expect(get('humanizer')).toContain("When the text is the writer's own prose, keep their sentences");
    expect(get('stop-slop')).toContain('at most one crafted, quotable line per piece');
    expect(get('stop-slop')).toContain('Uniformly short and choppy');
    expect(get('writing-for-humans')).toContain('Never reroute a removed dash into a semicolon');
    expect(get('unslop')).toContain("composing from a writer's notes");
    for (const name of ['stop-slop', 'humanizer']) expect(get(name)).toContain('Load with `writing-for-humans`');
  });

  it('gives unslop a positive baseline and a route that names its skills without widening a role', () => {
    const get = (name: string) => BUILTIN_SKILLS.find((entry) => entry.name === name)!.template;
    const unslop = get('unslop');
    for (const phrase of [
      '**Concrete nouns.**', '**One reading.**', '**Enough words.**', "**The source's judgment.**",
      'keeps its force, exceptions included', 'A short reply stays short and needs nothing further loaded',
      'Routing is a load obligation', 'none applies to every turn',
      "It changes no role's authority, finding bar, verdict, or required output format",
      'A read-only reviewer names the defect and the direction of the repair',
      'Availability alone selects no voice',
    ]) expect(unslop, phrase).toContain(phrase);
    for (const name of ['writing-for-humans', 'stop-slop', 'humanizer', 'writing-for-agents', 'pr-writing', 'stop-design-slop']) {
      expect(unslop, name).toContain(`\`${name}\``);
      expect(BUILTIN_SKILLS.some((entry) => entry.name === name), name).toBe(true);
    }
  });

  it('keeps humanizer focused on a draft audit apart from the full rewrite and limits the shorter option', () => {
    const humanizer = readSkillTemplate('humanizer');
    const description = BUILTIN_SKILLS.find((entry) => entry.name === 'humanizer')!.description;
    expect(description).toContain('your own draft shows a cluster of these tells before you deliver it');
    expect(humanizer).toContain('**Draft audit.**');
    expect(humanizer).toContain('There is no interview, no fresh rewrite, no shorter option, and no change notes unless asked');
    expect(humanizer).toContain('A full rewrite (the rewrite, interview, and notes modes below) also loads `stop-slop`');
    expect(humanizer).toContain('A draft audit loads it only when staging or cadence tells appear');
    expect(humanizer).toContain('Ordinary technical answers, reports, docs, plans, and status updates get no shorter option unless the writer asks for one');
    expect(readSkillTemplate('stop-slop')).toContain('A full `humanizer` rewrite loads this skill');
  });

  it('ports one visual foundation with scoped references, an accessibility check, and no scoring gate', () => {
    const directory = path.join(resolvePackagedSkillsDir(), 'stop-design-slop');
    const skill = readSkillTemplate('stop-design-slop');
    for (const phrase of [
      '**Operate:**', '**Read:**', '**Persuade:**', '**The brief wins.**', '**Density follows the task.**',
      'Distinctiveness never trades them away', 'show nothing rather than a plausible number, chart, customer logo, or activity feed',
      'Without code execution, report the contrast as unchecked', 'This skill does not change what a role may do',
      'not pass or fail gates',
    ]) expect(skill, phrase).toContain(phrase);
    for (const reference of ['composition', 'diagnostics', 'refinement', 'source-index']) {
      expect(existsSync(path.join(directory, 'references', `${reference}.md`)), reference).toBe(true);
      expect(skill, reference).toContain(`(references/${reference}.md)`);
    }
    const refinement = readSkillReference('stop-design-slop', 'refinement.md');
    expect(refinement).toContain('**Refinement preserves.**');
    expect(refinement).toContain('**Redesign replaces.**');
    expect(refinement).toContain('Ask before replacing factual copy or adding a claim');
    expect(refinement).toContain('Diagnose and recommend');
    const diagnostics = readSkillReference('stop-design-slop', 'diagnostics.md');
    expect(diagnostics).toContain('none is a gate, and no total score is kept');
    expect(diagnostics).toContain('Distinctiveness never outweighs a usability or accessibility defect');
    for (const text of [skill, diagnostics, refinement, readSkillReference('stop-design-slop', 'composition.md')]) {
      expect(text).not.toMatch(/18\/24|release gate|score each|answer all of these/i);
    }
    expect(BUILTIN_SKILLS.some((entry) => /visual-humanizer/.test(entry.name))).toBe(false);
    for (const unshipped of ['assets', 'examples', 'scripts/audit_ui.py', 'references/research-basis.md']) {
      expect(existsSync(path.join(directory, unshipped)), unshipped).toBe(false);
    }
    const provenance = readFileSync(path.join(directory, 'UPSTREAM.md'), 'utf8');
    expect(provenance).toContain('no license is claimed for the whole local copy');
    expect(provenance).not.toContain('no Apache notice is bundled');
    expect(provenance).toContain('adapted from the operator-maintained `impeccable` skill');
    expect(provenance).toContain('No script, command table, setup procedure, document system, absolute ban, or aesthetic default was taken from it');
    expect(readFileSync(path.join(directory, 'LICENSE.antislop'), 'utf8')).toContain('Copyright (c) 2026 Miqdad Badjuber');
    // The ported mode text includes an upstream sentence verbatim, so the Apache 2.0 license and copyright travel with it.
    expect(skill).toContain('Brand lives in precise details.');
    const apache = readFileSync(path.join(directory, 'LICENSE.impeccable'), 'utf8');
    expect(apache).toContain('Apache License\n                           Version 2.0, January 2004');
    expect(apache).toContain('Copyright 2025 Paul Bakaus');
    for (const text of [skill, refinement]) expect(text).toContain('`impeccable` (Apache 2.0)');
    expect(readSkillReference('stop-design-slop', 'source-index.md')).not.toContain('without copying its text');
  });

  it('computes contrast with the packaged stop-design-slop script', () => {
    const script = path.join(resolvePackagedSkillsDir(), 'stop-design-slop', 'scripts', 'contrast_check.py');
    const run = (...args: string[]) => spawnSync('python3', [script, ...args], { encoding: 'utf8' });
    const selftest = run('--selftest');
    expect(selftest.error).toBeUndefined();
    expect(selftest.status, selftest.stderr).toBe(0);
    const failing = run('#FFFFFF', '#777777');
    expect(failing.stdout).toContain('ratio: 4.48:1');
    expect(failing.stdout).toContain('normal text (4.5:1): FAIL');
    expect(failing.status).toBe(1);
    expect(run('000', 'fff').status).toBe(0);
    expect(run('zzz', 'fff').status).toBe(2);
  });

  it('ships no writing-policy skill and no active packaged pointer to it', () => {
    const root = resolvePackagedSkillsDir();
    expect(existsSync(path.join(root, 'writing-policy'))).toBe(false);
    expect(BUILTIN_SKILLS.some((entry) => entry.name === 'writing-policy')).toBe(false);
    for (const relative of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
      if (!relative.endsWith('.md') || /(^|\/)(UPSTREAM|LICENSE[^/]*)\.md$/.test(relative)) continue;
      expect(readFileSync(path.join(root, relative), 'utf8'), relative).not.toContain('writing-policy');
    }
  });

  it('sweeps prose mechanically with the packaged humanizer check script', () => {
    const script = path.join(resolvePackagedSkillsDir(), 'humanizer', 'check.py');
    const sweep = (text: string) => {
      const result = spawnSync('python3', [script, '-'], { input: text, encoding: 'utf8' });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };

    const punctuation = sweep('The release \u2014 finally \u2014 shipped; users noticed.');
    expect(punctuation).toContain('em/en dashes: 2');
    expect(punctuation).toContain('semicolons: 1');

    const vocabulary = sweep('We delve into a vibrant tapestry that will seamlessly empower your team.');
    expect(vocabulary).toContain('AI words');
    expect(vocabulary).toContain('delve');
    expect(vocabulary).toContain('marketing words');

    const plain = 'We cut no-shows from 18% to 7% in six months by switching to two-way texts. '
      + 'Patients reschedule by replying, which saved the front desk about 11 hours a week. '
      + 'Sopot only got to 12%, and nobody knows why yet.';
    expect(sweep(plain)).toBe(`words: ${plain.split(/\s+/).length}`);

    const code = sweep('Run the retry loop.\n\n```ts\nconst a = 1; const b = 2;\n```\n\nThen call `reset(); flush();` once.');
    expect(code).not.toContain('semicolons');

    const longerCloser = sweep('```js\nconst a = 1;\n````\nAfter the fence; prose counts.');
    expect(longerCloser).toContain('semicolons: 1');

    const tilde = sweep('~~~\nx; y;\n```\nz;\n~~~~\nAfter the fence; prose counts.');
    expect(tilde).toContain('semicolons: 1');

    const unterminated = sweep('Before the fence; prose counts.\n```\na; b; c;');
    expect(unterminated).toContain('semicolons: 1');

    const doubleBacktick = sweep('Call ``a ` b;`` first; then flush.');
    expect(doubleBacktick).toContain('semicolons: 1');
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
    expect(skill!.template).toContain('exactly one material operator question at a time');
    expect(skill!.template).not.toContain('per turn');
    // One invocation keeps going between questions: the exposed question tool returns answers to the same run.
    for (const requirement of [
      'One invocation is one continuing loop',
      'When the `question` tool is exposed, ask every operator question through it',
      'carry on with the next research step, check, or question in the same turn',
      // Unavailable tool: one unavoidable yield, then the same loop resumes; nothing is pretended.
      'When the `question` tool is not exposed, ask one plain chat question',
      'resume the same loop where it stopped',
      'Never claim a tool call, answer, or check result that did not happen',
      // Progress and status are steps inside the loop, not a reason to end the turn.
      'A progress update, a status summary, or an offer to continue is a step inside the loop',
      // After-answer falsification, ordering, and the preference/fact distinction.
      'Falsify before settling',
      'including those inside operator answers',
      'with a proportional check that could disprove it',
      'Stay read-only unless the invocation already authorizes more',
      'Resolve a discoverable fact before asking a question that depends on it',
      'Accepting an operator preference settles the preference, not the facts it assumes',
      // Pause/stop, confirmation transport, and corrections returning through validation.
      'If the operator pauses or stops, stop asking',
      'leave alignment unconfirmed',
      'asked through the same question transport as the loop',
      'check any factual claims they introduce',
      'restate the corrected brief and ask for confirmation again',
      'return to the loop with the single most material unresolved question',
    ]) expect(skill!.template, requirement).toContain(requirement);
    // The turn-ending rules are not a closed list: a legitimate native completion wait must stay available.
    expect(skill!.template).not.toContain('End the turn only');
    // Static text-consistency scenarios for the paths a live run can take; they are not model-behavior evidence.
    const scenarios: Record<string, string[]> = {
      'background research pending after the last independent question': [
        'running independent checks while useful evidence runs',
        'Wait only when no independent material work remains and every remaining material decision depends on pending evidence',
        'a required native completion may suspend the invocation',
        'instead of polling or launching a duplicate lane',
      ],
      'native completion notification arrives': ['resume the same loop when it arrives'],
      'exposed question call is rejected or returns no answer': [
        'Only an operator answer settles a question',
        '(rejected, cancelled, dismissed, or errored), keep that item unresolved and alignment unconfirmed',
        'disclose it and yield with the open question in chat',
        'do not supply an answer, retry a call already known to fail, or work around the denied interaction',
      ],
      'operator cancels, pauses, or stops': [
        'Treat an explicit operator cancellation, pause, or stop as a stop',
        'If the operator pauses or stops, stop asking, state settled and unresolved material items, and leave alignment unconfirmed',
      ],
    };
    for (const [scenario, phrases] of Object.entries(scenarios)) {
      for (const phrase of phrases) expect(skill!.template, `${scenario}: ${phrase}`).toContain(phrase);
    }
    // Shared-understanding dialogue: orient before asking, explain plainly with calibrated confidence, and treat
    // options, corrections, and the final confirmation as parts of the same method.
    const dialogue: Record<string, string[]> = {
      'orient before the first question': [
        'orient and research, explain, ask one material question, investigate and falsify the answer, incorporate corrections',
        'Repeat the questions and checks until no unresolved item could materially change shared understanding, then end the whole dialogue with an explicit three-way confirmation',
        'Get your bearings before the first question',
        'Read what the conversation, the supplied context, and the repository or project context already say',
      ],
      'settled decisions are not asked again': [
        'A decision the operator already made there is settled',
        'do not ask it again unless new evidence contradicts it',
      ],
      'explain what, how and why plainly without quizzing': [
        'what the thing is, how it works, and why it is that way where the evidence shows why',
        'Give the smallest complete account first',
        'Skip what they plainly already know',
        'no quizzes, no asking them to repeat it back, no lecture',
      ],
      'factual and historical uncertainty survives': [
        'Say what a source establishes, what it only suggests, and what you could not find',
        'Never promote an inferred reason to a stated fact',
      ],
      'every option has pros, cons, and a recommendation': [
        'Give every option you present a short pro, a short con, and your recommendation with its reason',
        'when an option has none worth naming, say so instead of inventing one',
      ],
      'a confident recommendation does not settle a choice': [
        'A recommendation does not settle a decision',
        'a material choice the operator has not made stays on the frontier',
        'never fold it into the brief as an assumption',
      ],
      'operator corrections are incorporated and checked': [
        'When the operator corrects your explanation, a fact, or a recommendation, accept it',
        'say what changed in your account',
      ],
      'confirmation options carry costs and a recommendation': [
        'Give each outcome its cost and benefit, and recommend Aligned only when no material item is open',
        'any error left in the brief carries forward',
        'It costs another round and keeps the brief accurate',
        'right when a material item is wrong or missing',
      ],
      'bare confirmation is understanding only': [
        'A bare confirmation is understanding only',
        'requires a separate operator request',
        'Grilling itself creates no Hive feature, plan, or other Hive state',
      ],
      'upfront instruction authorizes one next stage': [
        '"then create a plan after alignment"',
        'authorizes the one next stage it names, only once alignment is confirmed, and you do not ask for authorization a second time',
        "the active role's existing planning, approval, and tool boundaries",
        'never implies approval, task sync, or execution',
      ],
    };
    for (const [scenario, phrases] of Object.entries(dialogue)) {
      for (const phrase of phrases) expect(skill!.template, `${scenario}: ${phrase}`).toContain(phrase);
    }
    // The skill stays endpoint-neutral: commands choose the endpoint, so neither one is named as the method's end.
    expect(skill!.template).not.toContain('/implementation-brief');
    expect(skill!.template).not.toContain('/interview');
    expect(skill!.template).not.toContain('/grill');
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
    expect(skill!.template).toContain('- operator decisions, each with its reason when the operator or the evidence gave one\n- operator preferences');
    expect(skill!.template).toContain('Confirmed alignment ends the interaction');
    expect(skill!.template).toContain('requires a separate operator request');
    expect(skill!.template).toContain('A named destination authorizes writing only the confirmed alignment brief there');
    expect(skill!.template).toContain('No minimum, maximum, fixed research timing, or forced delegation applies');
    expect(skill!.template).not.toMatch(/After 2-3|mandatory fan-out|minimum lanes|maximum lanes/i);
  });

  it('bundles adversarial-review as a read-only posture inside the reviewing role', () => {
    const skill = BUILTIN_SKILLS.find((entry) => entry.name === 'adversarial-review');

    expect(skill).toBeDefined();
    expect(skill!.template).toContain('neverinfamous/memory-journal-mcp');
    expect(skill!.template).toContain('dementev-dev/adversarial-review');
    expect(skill!.template).toContain('poteto/noodle');
    expect(skill!.description).toContain('explicitly asked');
    expect(skill!.description).toContain('adversarial');
    expect(skill!.template).toContain('Stay read-only. Do not edit files');
    expect(skill!.template).toContain('If any review step mutates the artifact under review, stop and report the mutation');
    expect(skill!.template).toContain('Report missing, empty, stale, or invalid review inputs');
    expect(skill!.template).toContain('Host output format wins');
    expect(skill!.template).toContain('`git --no-optional-locks status --short`');
    // The posture is an adjuster: roles keep their own method, labels and finding bar, and it adds no authority.
    expect(skill!.template).toContain('the host agent contract still wins');
    expect(skill!.template).toContain('Code and simplicity reviewers keep the shared Review Investigation steps; plan review and approach advice keep their own methods and do not adopt those steps');
    expect(skill!.template).toContain('adds no authority, verdict, reviewer, roster, finding quota, or required sequence of passes');
  });

  it('retires the adversarial mode detection, lens roster and baseline-then-attack sequence', () => {
    const template = BUILTIN_SKILLS.find((entry) => entry.name === 'adversarial-review')!.template;
    const upstream = readFileSync(path.join(resolvePackagedSkillsDir(), 'adversarial-review', 'UPSTREAM.md'), 'utf8');

    // These competed with each role's own method; the source influences stay named in the Reference Basis.
    for (const retired of ['## Mode Detection', '## Review Protocol', 'Separate baseline from attack', 'Use the smallest lens set', '### Lens Coverage', 'Boundary Breaker', 'Stress Tester', 'Skeptic + Architect']) {
      expect(template, retired).not.toContain(retired);
    }
    expect(template).toContain('does not keep their mode detection, lens panels, or fixed baseline-then-attack sequence');
    expect(upstream).toContain('Deliberate adaptation');
    expect(upstream).toContain('a fixed lens roster would add a second reviewer-selection scheme beside configured reviewers');
    expect(upstream).toContain('the requirement that a required reviewer or companion still runs');
  });

  it('keeps the role report substance and the clean-result validity under the adversarial posture', () => {
    const template = BUILTIN_SKILLS.find((entry) => entry.name === 'adversarial-review')!.template;

    expect(template).toContain('its assessment label, the Review Basis and Coverage entries');
    expect(template).toContain('the file:line anchor, the decisive quoted line, the reachable consequence, and what you did to disprove it');
    expect(template).toContain('Material leads you rejected keep their clearing evidence in Coverage');
    expect(template).toContain('No structured output is added for the adversarial pass');
    expect(template).toContain('do not invent findings, praise, or extra structure to look thorough');
    expect(template).toContain('look for both sides: a counterexample that breaks the assumption, and a guard, contract, or test that already defeats the concern');
    // Illustration: a supported source finding, its guarded control, and the limit of source evidence.
    expect(template).toContain('It is a source-based finding; it does not show that anything ran or that a test fails');
    expect(template).toContain('Guarded control');
    expect(template).toContain('APPROVE with No action');
    expect(template).toContain('ALREADY_MINIMAL');
    // The fictional example must not reuse identifiers from the evaluation scenarios.
    for (const fixtureName of ['firstItemId', 'lastItemId', 'clampLimit']) {
      expect(template).not.toContain(fixtureName);
    }
  });

  it('bundles adversarial-review external validation as optional and failure-reporting', () => {
    const skill = BUILTIN_SKILLS.find((entry) => entry.name === 'adversarial-review');

    expect(skill).toBeDefined();
    expect(skill!.template).toContain('External or cross-model validation is useful but not required');
    expect(skill!.template).toContain('remains required; this posture neither adds it nor drops it');
    expect(skill!.template).toContain('Confirm the output exists and is non-empty before using it');
    expect(skill!.template).toContain('Report missing, failed, timed out, or empty output as a validation failure');
    expect(skill!.template).toContain('Do not let external tools mutate the artifact under review');
  });

  it('uses host finding bars for adversarial falsification and permits clean results', () => {
    const template = BUILTIN_SKILLS.find((entry) => entry.name === 'adversarial-review')!.template;
    expect(template).toContain('Try to falsify the claims the artifact depends on');
    expect(template).toContain('A failed attempt to find a defect is a legitimate clean result');
    expect(template).toContain('Severity:');
    expect(template).toContain('severity separate from certainty');
    expect(template).toContain('A plausible failure path alone is a lead');
    expect(template).toContain('REVISE`: a supported material failure or applicable requirement violation');
    expect(template).toContain('approach-advisor` gives advice without an approval verdict');
    expect(template).toContain('simplicity-reviewer` keeps `SIMPLIFY/MINOR_TWEAKS/ALREADY_MINIMAL/NEEDS_DISCUSSION`');
    expect(template).toContain('`plan-reviewer` keeps `OKAY/REJECT`');
    expect(template).toContain('[APPROVED / REVISE / NEEDS_DISCUSSION]');
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
    expect(skill!.template).toContain('progress and revision history belong in the feature Worklog');
    expect(skill!.template).not.toContain('primary human-facing review surface and history');
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
    const template = readSkillTemplate('writing-plans');
    const baseline = template.slice(template.indexOf('## Verification Planning'), template.indexOf('## Worker-Branch Task Granularity'));
    const method = readSkillReference('writing-plans', 'verification-planning.md');

    // Baseline: what a planner must hold even when the reference is missing or overridden.
    for (const token of ['local iteration', 'task acceptance', 'integration checkpoint', 'release certification']) {
      expect(baseline, token).toContain(`\`${token}\``);
    }
    for (const requirement of [
      'candidate and input identity',
      "replaces the task's current `Verify` list and decision table",
      'an approved explicit gate stays binding until an approved amendment',
      'Name an integrated-only deferral in the task and mirror it under `## Final Verification`',
      'A later commit neither keeps nor discards evidence by itself',
      'a plan cannot narrow an operator-defined outcome on its own',
    ]) {
      expect(baseline, requirement).toContain(requirement);
    }

    // Method: the disclosed reference carries the full decision model.
    for (const token of [
      'local iteration', 'task acceptance', 'integration checkpoint', 'release certification',
      'passed and applies', 'invalidated', 'not run', 'failed', 'blocked',
      'retain', 'replace', 'invalidate', 'defer', 'drop',
    ]) {
      expect(method, token).toContain(`\`${token}\``);
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
      expect(method, requirement).toContain(requirement);
    }
    const recovery = [
      'Retain the first failure and its cleanup evidence',
      'Reproduce the failure red with the smallest valid check at the owning layer',
      'Verify the owner and affected consumers',
      'Decide from input impact whether the certificate is invalidated',
    ].map((step) => method.indexOf(step));
    expect(recovery.every((index) => index >= 0)).toBe(true);
    expect(recovery).toEqual([...recovery].sort((a, b) => a - b));
    expect(template).toContain('replacing each rather than appending');
    expect(template).toContain('- [Integrated acceptance gate record per Verification Planning; match any task-named integrated-only deferral]');
    // The inline baseline does not carry the disclosed method a second time.
    expect(template).not.toContain('Physical-STAC correction.');
    expect(template).not.toContain('A certificate is the set of candidate-bound gate records');
  });

  it('plans verification-efficiency goals across the delivery schedule while preserving required proof', () => {
    const template = readSkillTemplate('writing-plans');
    const method = readSkillReference('writing-plans', 'verification-planning.md');
    const section = method.slice(method.indexOf('## Verification-efficiency goals'), method.indexOf('## After a broad gate fails'));

    expect(section.length).toBeGreaterThan(0);
    for (const requirement of [
      'initial validation, one representative correction after a failure, and integration',
      'preparation and setup, queueing and locks, execution, cleanup, and repeated acceptance',
      'mark the rest unknown',
      'which costly executions disappear and which remain',
      'Faster focused checks alone do not establish a whole-delivery improvement',
      "judge the outcome's stated scope against the complete schedule evidence",
      'Keeping every required acceptance run is valid when that evidence supports the improvement the outcome claims',
      'An explicitly local feedback outcome stays local',
      'report no end-to-end gain without evidence',
      "changing the requirement needs the operator's agreement",
      'sets no numerical limit or measured-baseline requirement',
      'Keep indivisible composition, state, order, and default-routing proofs',
      'needs evidence that it preserves the relevant invariants and coverage',
      'an unrun node never counts',
      'stays one invocation until an authorized amendment changes it',
      'plan wording cannot override a repository requirement',
      'identify its intended scope first',
      'each retained exception and each unchanged default',
      'scope similarity alone does not authorize amending a task',
    ]) {
      expect(section, requirement).toContain(requirement);
    }
    expect(method).toContain('an unrelated commit does not invalidate it');
    expect(method).toContain('a new commit identity alone is not that reason');
    expect(method).toContain('A binding whole-invocation gate reruns whole');
    for (const text of [template, method]) {
      expect(text).not.toContain('or when the gate has never passed on this candidate');
      expect(text).not.toContain('while the acceptance runs they feed are unchanged');
    }
    // Baseline selects the reference for an efficiency outcome and keeps the outcome scope binding without it.
    expect(template).toContain('A stated verification-efficiency outcome is planned against the scope it states');
    expect(template).toContain('work from a stated verification-efficiency outcome');
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
    expect(template).toContain('Once applicable required evidence and reviews are sufficient, stop');
    expect(template).toContain('Any required `FAIL` makes the verdict `FAIL`');
    expect(template).toContain('an empty or incomplete set is missing proof');
    expect(template).toContain('A required `PARTIAL`, `UNVERIFIED`, or `BLOCKED` result, or any other missing required proof, prevents `PASS`');
    expect(template).toContain('use `PARTIAL` only when an environmental or tool limitation is the sole reason required proof is missing');
    expect(template).toContain('A final `FAIL` means required acceptance failed or remains unproven; it does not imply that an executed command exited unsuccessfully');
  });

  it('states each verification obligation once and keeps the observed-failure and worker-prose rules', () => {
    const template = BUILTIN_SKILLS.find((entry) => entry.name === 'verification')!.template;

    expect(template.match(/skipped, unrun, failed, or blocked are not PASS/g)).toHaveLength(1);
    expect(template.match(/An unexplained green retry does not resolve an intermittent failure/g)).toHaveLength(1);
    expect(template).toContain('unaffected results stay under the reuse rule above');
    expect(template).not.toContain('Retain unaffected results only with a short, defensible non-impact reason');
    expect(template).not.toContain('Report required skips and unrun checks honestly');
    expect(template).not.toContain('run the required check on the current target or report the claim as unverified/blocked');
    // Owners of the condensed repetition remain.
    expect(template).toContain('Run the check on the current target when required output or applicability is unavailable');
    expect(template).toContain('report UNVERIFIED or BLOCKED, never PASS');
    expect(template).toContain('Worker prose alone cannot support a PASS');
    expect(template).toContain('3. Mark the result FAIL');
    expect(template).toContain('Do not explain it away unless repository docs or code prove the behavior is intentional');
    expect(template).toContain('End standalone reports with exactly one verdict line');
  });

  it('requires whole-schedule evidence for end-to-end speedup claims', () => {
    const template = BUILTIN_SKILLS.find((entry) => entry.name === 'verification')!.template;

    expect(template).toContain('### End-to-end speedup claims');
    expect(template).toContain('on the same workload and measurement surface as the baseline');
    expect(template).toContain('a measured speedup, an observed elimination');
    expect(template).toContain('a projected benefit from the schedule');
    expect(template).toContain('A faster focused check supports a claim about that check only');
    expect(template).toContain('is not a failure unless a measured goal requires it');
    expect(template).toContain('a speedup claim never overrides them');
    expect(template).toContain('a new commit identity alone neither keeps nor discards it');
    expect(template).toContain('an unrun node never counts');
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

  it('asks systematic-debugging for causal evidence and selectable techniques, not a compulsory phase sequence', () => {
    const template = BUILTIN_SKILLS.find((entry) => entry.name === 'systematic-debugging')!.template;
    const techniques = readSkillReference('systematic-debugging', 'diagnostic-techniques.md');

    expect(template).toContain('NO FIXES WITHOUT CAUSAL EVIDENCE FIRST');
    expect(template).toContain('## The Causal-Evidence Bar');
    expect(template).toContain('No fixed sequence of steps has to run first');
    for (const criterion of ['**Observed**', '**Located**', '**Explained**']) expect(template).toContain(criterion);
    expect(template).toContain('Settled evidence ends the search');
    expect(template).toContain('instrumenting every component only delays the fix');
    expect(template).toContain('Ambiguous evidence needs a discriminating observation');
    expect(template).toContain('## Choose Techniques By Uncertainty');
    // The generic four-phase traversal and per-boundary instrumentation are neither mandatory here nor moved there as a ritual.
    for (const retired of ['## The Four Phases', 'You MUST complete each phase', 'Phase 1', 'BEFORE proposing fixes, add diagnostic instrumentation', 'For EACH component boundary']) {
      expect(template, retired).not.toContain(retired);
      expect(techniques, retired).not.toContain(retired);
    }
    expect(techniques).toContain('None is a stage to pass through');
    expect(techniques).toContain('stop when the causal-evidence bar in `SKILL.md` is met');
    expect(techniques).toContain('the technique is unnecessary when the failing component is already known');
    expect(techniques).not.toMatch(/\b(must|always) (complete|run|add|instrument)\b/i);
    // Retained: first wrong behavior, state protection and the role's attempt budget.
    expect(template).toContain('## Protect State While Experimenting');
    expect(template).toContain('do not clear user or Hive-managed files, break locks, or discard retained evidence to test the hypothesis');
    expect(template).toContain('it never resets or extends the role\'s retained attempt budget');
    expect(template).toContain('A Forager keeps its three iterations and three failed approaches, and every failed attempt counts toward them');
    expect(template).toContain('follow the role\'s own safe recovery and reporting');
    expect(template).toContain('A diagnosis-only assignment stays report-only throughout');
    expect(techniques).toContain('It neither resets nor extends any attempt budget the role keeps');
    expect(techniques).toContain('The state protections in `SKILL.md` apply to every experiment');
    // Fictional examples must not reuse identifiers from the evaluation scenarios.
    for (const fixtureName of ['calc', 'ledger', 'remote', 'subtract', 'firstItemId']) {
      expect(template).not.toContain(fixtureName);
      expect(techniques).not.toContain(fixtureName);
    }
  });

  it('ships the obra/superpowers license and a pinned source record beside the retained systematic-debugging text', () => {
    const skillDir = path.join(resolvePackagedSkillsDir(), 'systematic-debugging');
    const license = readFileSync(path.join(skillDir, 'LICENSE.superpowers'), 'utf8');
    const upstream = readFileSync(path.join(skillDir, 'UPSTREAM.md'), 'utf8');
    const template = BUILTIN_SKILLS.find((entry) => entry.name === 'systematic-debugging')!.template;

    expect(license.startsWith('MIT License\n\nCopyright (c) 2025 Jesse Vincent\n')).toBe(true);
    expect(upstream).toContain('https://github.com/obra/superpowers');
    expect(upstream).toContain('030a222af19c1f3a93c6eb876a7422d8e4fc0162');
    expect(upstream).toContain('LICENSE.superpowers');
    expect(upstream).toContain('LICENSE.pstack');
    expect(template).toContain('obra/superpowers');
    expect(template).toContain('`LICENSE.superpowers`');
    // The adaptation account names the four-phase change and no longer claims the phases are retained.
    expect(upstream).toContain('## Deliberate adaptations');
    expect(upstream).toContain('Four phases became a causal-evidence bar and selectable techniques');
    expect(upstream).toContain('references/diagnostic-techniques.md');
    expect(upstream).toContain('never resets or extends a role\'s retained attempt budget');
    expect(upstream).not.toContain('the four phase headings with the steps of Phases 1 to 3');
  });

  it('documents task() fan-out paths for parallel-exploration', () => {
    const skill = BUILTIN_SKILLS.find((entry) => entry.name === 'parallel-exploration');

    expect(skill).toBeDefined();
    // The complete fan-out calls are disclosed examples; the rules that make them safe stay inline.
    expect(readSkillReference('parallel-exploration', 'research-examples.md')).toContain('task({');
    expect(readSkillReference('parallel-exploration', 'research-examples.md')).toContain('// BAD: Wait for each before spawning next');
    expect(skill!.template).toContain(
      'Launch every currently known, necessary, non-duplicative independent question before waiting for any results.'
    );
    expect(skill!.template).toContain('fit in one context window');
    expect(skill!.template).toContain('return to Hive');
    expect(skill!.template).toContain('Dependency decides serial vs parallel');
    expect(skill!.template).toContain('Wait mode decides blocking foreground vs background');
    expect(skill!.template).toContain('Blocking does not mean serial');
    expect(skill!.template).toContain('If the only reason for serializing is that `task()` is blocking, that is incorrect');
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

    expect(template).toContain("Lane changes receive the reviews required by the active primary's Review Routing");
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
    // Final-verification placement is owned by writing-plans and orchestrating-ad-hoc-work, not repeated here.
    expect(background).not.toContain('## Final Verification');
    expect(background).toContain('consume the lane boundaries and ready wave from `orchestrating-ad-hoc-work`; do not redefine them here');
    expect(background).toContain('`dispatching-parallel-agents` owns launch mechanics and writer isolation');
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
    expect(skill!.template).toContain("apply the primary's Review Routing");
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
    expect(skill!.template).toContain('explicit verification-efficiency outcome and the binding schedule is about to repeat expensive acceptance that contradicts it, raise the mismatch before the repeat');
    expect(skill!.template).toContain('never waive or move a gate yourself');
    expect(skill!.template).toContain('a target task milestone keeps its requested dependency closure while any broader reconciliation is raised separately');
    expect(skill!.template).toContain('A task with no such mismatch runs as approved');
  });

  it('keeps the milestone safety baseline inline and the full procedure in the disclosed reference', () => {
    const executing = readSkillTemplate('executing-plans');
    const reference = readSkillReference('executing-plans', 'task-milestones.md');
    const suggesting = reference.slice(reference.indexOf('## Suggesting milestones'), reference.indexOf('## Executing requested milestones'));
    const running = reference.slice(reference.indexOf('## Executing requested milestones'));

    // Baseline: holds when the reference is missing, overridden or unreadable.
    for (const rule of [
      'hive_status({ feature })',
      'ask for clarification if the feature, target, or any companion is ambiguous or missing',
      'A bare target request has no companions; never infer them from task numbers, readiness, or topic',
      'A cancelled requested root is a blocker',
      "each requested root's own stored `dependsOn` edges recursively, including each root",
      'stop traversal at `done` tasks',
      'Only `done` satisfies a dependency',
      'Never infer edges from numbering or follow reverse dependents',
      'Inspect live or uncertain workers before dispatch; do not launch overlapping replacements',
      'Exclude unrelated tasks and descendants unless the operator explicitly expands scope',
      'Re-read status between batches and on each new run/continue request',
      'target AND every explicitly named companion verified, integrated where applicable, and marked `done`',
      'A source commit or worker completion alone is insufficient',
      'do not call `hive_feature_complete` merely because the milestone was achieved while other tasks remain',
      'hand off final verification instead of executing it in that request',
      'If the reference cannot be read, dispatch no new milestone work',
      'do not search generated skill caches for another copy',
    ]) {
      expect(executing, rule).toContain(rule);
    }

    // Procedure: two sections for two different consumers, each self-sufficient for its job.
    expect(reference).toContain('Numerical ranges such as "tasks 2-8" never define scope.');
    expect(reference.indexOf('## Shared definitions')).toBeLessThan(reference.indexOf('## Suggesting milestones'));
    expect(suggesting.length).toBeGreaterThan(0);
    expect(running.length).toBeGreaterThan(0);
    for (const rule of [
      'projected NEW unfinished task count',
      'actual task folders counted',
      'companions: none',
      'U_i be the current unfinished union of the closures of suggested target i and its explicitly listed companions',
      'U_i minus the union of the preceding suggested U_j',
      'Run feature "<feature>" until task "<task-folder>" (<task-title>) is complete.',
      'Continue feature "<feature>" until task "<next-task-folder>" (<next-task-title>) is done.',
      'Also complete companion task "<companion-folder>" (<companion-title>) before stopping.',
      'Run final verification for feature "<feature>" and complete it only after the required checks pass.',
      'Do not produce a projection from numbering',
      'Approval and sync outcomes stay as they were persisted',
    ]) {
      expect(suggesting, rule).toContain(rule);
    }
    // The consumers stay distinct: the execution section does not carry the recommendation-table method.
    expect(running).not.toContain('projected NEW unfinished task count');
    expect(running).not.toContain('U_i');
    for (const rule of [
      'preserve the exact feature, target, and explicitly named companions from the suggested prompt',
      'ask only when a material scheduling or authority decision remains unresolved',
      'hive_status({ feature })',
      'one unique task folder/title within that feature',
      'Ask for clarification if the feature, target, or any companion is ambiguous or missing',
      'A bare target request has no companions; never infer them from task numbers, readiness, or topic',
      'Only if all requested roots are already `done`',
      'an already-done target does not short-circuit unfinished companions',
      'milestone satisfied without dispatch',
      "union of each requested root's own stored `dependsOn` edges recursively, including each root",
      'Deduplicate roots and shared prerequisites',
      'Include companion prerequisites even when numbered beyond the target',
      'resolved implicit sequential shorthand',
      'never infer edges from numbering or follow reverse dependents',
      'Stop traversal at `done` tasks: their outgoing edges are historical',
      'Only `done` satisfies a dependency',
      'Cancelled or missing prerequisites are blockers',
      '`pending`, `in_progress`, `blocked`, `failed`, and `partial` are unfinished, not satisfied',
      'A cancelled requested root is a blocker',
      'Companions expand requested scope, not dependency edges',
      'Schedule only the combined unfinished closure by actual dependencies and existing ownership/resource rules',
      'Inspect live or uncertain workers before dispatch; do not launch overlapping replacements',
      'Exclude unrelated tasks and descendants unless the operator explicitly expands scope',
      'Re-read status between batches and on each new run/continue request',
      'recompute the union for all requested roots from updated stored edges each time, including approved and synced dependency amendments',
      'target AND every explicitly named companion verified, integrated where applicable, and marked `done`',
      'Wait for a slower independent companion even if the target finishes first',
      'applicable checks, required review, and cleanup completed',
      'call `hive_feature_complete` merely because the milestone was achieved while other tasks remain',
      'completed and remaining combined closure scope, other remaining feature tasks',
      'concrete continuation prompt',
      'When no unfinished feature tasks remain after achievement, emit `Run final verification for feature "<feature>" and complete it only after the required checks pass.` with the exact feature substituted',
      'Stop at the requested milestone and hand off final verification instead of executing it in that request',
      'milestone completion does not waive whole-feature final verification',
    ]) {
      expect(running, rule).toContain(rule);
    }
    // Situations a consumer must get right: non-contiguous scope, shared prerequisites, a done target with an unfinished companion.
    expect(running).toContain('If task 8 is already done and task 1 is unfinished, execute task 1\'s unfinished closure');
    expect(running).toContain('share `03-storage` count and run it once');
    expect(running).toContain('A cancelled task in a requested root\'s closure blocks the milestone');
    for (const rule of [
      'State what the operator or system can do at that point and the verifiable signal',
      'citing the source task or plan section instead of a subsystem label',
      'Describe expected capability, not proven readiness before execution',
      'do not invent capabilities or evidence',
      'list it as an explicit companion in that milestone',
      'suggest separate milestones and list the remaining work',
      'Never fabricate a dependency to force a linear split',
      'never sweep in earlier-numbered or all-ready tasks',
      'Deduplicate shared prerequisites, and count each requested root unless it is already covered or done',
      'Show the exact folders in each counted set',
    ]) {
      expect(suggesting, rule).toContain(rule);
    }
    expect(suggesting).toContain('Task 1 is non-contiguous with the rest of its row');
    expect(suggesting).toContain('the projected count is 8');

    // Step 5/6 of the execution skill now defer to the reference for the stopping boundary and whole-feature completion.
    expect(executing).toContain('repeat only within its combined unfinished prerequisite closure until all requested roots are done');
    expect(executing).toContain('For whole-feature execution, after all tasks complete');
    expect(executing).toContain('Call `hive_feature_complete` only after the required checks pass');
    expect(executing).toContain('Apply the primary prompt\'s existing full-feature verification/completion procedure');
    expect(executing).toContain('including every `## Final Verification` obligation and deferred check, required review, and applicable cleanup');

    const dispatch = readSkillTemplate('dispatching-parallel-agents');
    expect(dispatch).toContain('run/continue a feature until a target task is complete/done');
    expect(dispatch).toContain('executing-plans');
    expect(dispatch).toContain('apply Target Task Milestones before');
    expect(dispatch).toContain('Explicit companion suffixes use the same procedure');
  });

  it('routes accepted review work without promoting optional feedback to automatic fixes', () => {
    const executing = BUILTIN_SKILLS.find((entry) => entry.name === 'executing-plans')!.template;
    const adhoc = BUILTIN_SKILLS.find((entry) => entry.name === 'orchestrating-ad-hoc-work')!.template;
    expect(executing).toContain("Apply the primary's Review Follow-Up before remediation and closure");
    expect(executing).toContain('Route accepted work through this decision tree');
    expect(executing).toContain('| Accepted local correction to the completed batch | **Same implementation lane**');
    expect(executing).toContain('fresh worker when delegated');
    expect(executing).toContain("review packet from the primary's Review Handoffs");
    expect(executing).toContain('feature/task identity, plan path and current section, spec path');
    expect(executing).toContain('current `specStale`/`specStaleReason` from `hive_status`');
    expect(executing).toContain('reviewers may query status but receive no task brief');
    expect(executing).not.toContain('| Minor / local to the completed batch | **Inline fix**');
    expect(adhoc).toContain("Apply the primary's Review Follow-Up guidance to settled lane reviews before remediation and closure");
    expect(adhoc).toContain('preserve usable unaffected review coverage');
    expect(adhoc).toContain("reviews required by the active primary's Review Routing");
  });

  it('defers task report ownership and interruption recovery to the primary prompt', () => {
    const executing = BUILTIN_SKILLS.find((entry) => entry.name === 'executing-plans')!.template;
    const context = BUILTIN_SKILLS.find((entry) => entry.name === 'context-engineering')!.template;
    expect(executing).toContain("read the report it published and record status and a compact summary under the primary prompt's Task Report Ownership rules");
    expect(executing).toContain("follow the primary prompt's Interrupted Worker Recovery rules; a failed run does not fail the task");
    expect(executing).not.toContain('record its summary and terminal report');
    expect(context).toContain('Task reports and `handoff.md` are task records, not managed context. Do not copy report history into context.');
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

  it('includes task() parallel guidance for dispatching-parallel-agents', () => {
    const skill = BUILTIN_SKILLS.find((entry) => entry.name === 'dispatching-parallel-agents');

    expect(skill).toBeDefined();
    const launches = readSkillReference('dispatching-parallel-agents', 'launch-examples.md');
    expect(launches).toContain('task({');
    expect(launches).toContain('Gate-open only: use background: true');
    expect(launches).toContain('Blocking alternative, including every gate-closed session');
    expect(skill!.template).toContain('references/launch-examples.md');
    expect(skill!.template).toContain('Independent Forager worktrees may be created and dispatched under one parent');
    expect(skill!.template).toContain('hive_worktree_create');
    expect(skill!.template).not.toContain('hive_existing_workspace_start');
    expect(skill!.template).toContain('In feature-task mode, pass each returned topology-aware pin unchanged');
    expect(skill!.template).toContain('a singleton composite scalar is accepted');
    expect(skill!.template).toContain('In ad-hoc mode, return result state and its exact pin to `orchestrating-ad-hoc-work`');
    expect(skill!.template).toContain('hive_adhoc_worktree_merge');
    expect(skill!.template).toContain('Treat installs, builds, formatters, generators, and tests as mutations');
    expect(skill!.template).toContain('Ordinary Scout, advisor, and reviewer launches remain eligible for same-message parallel dispatch');
    expect(skill!.template).toContain('one primary goal');
    expect(skill!.template).toContain('disjoint path ownership or sequence overlapping writers');
    expect(skill!.template).toContain('parallel-exploration');
    expect(skill!.template).not.toMatch(/Treat unresolved lanes as blockers/i);
    expect(skill!.template).toContain('execution-decisions');
    expect(skill!.template).toContain('Dependencies guide sequencing');
    expect(skill!.template).toContain('Explicit null suppresses fallback');
    expect(skill!.template).toContain('**One writer per worktree:**');
    expect(skill!.template).toContain('**Destination checkpoints:**');
    expect(skill!.template).toContain('it does not trigger an overlapping replacement writer');
    expect(skill!.template).toContain('Distinct worktrees do not isolate fixed-path fixtures, ports, databases, containers, generated outputs, or external mutable resources');
    // One complete example per host: the raw reference holds both, and each host's rendering holds exactly one.
    expect(launches.match(/hive_feature_select\(\{ feature: "feature-name" \}\)/g)).toHaveLength(2);
    for (const host of [OPENCODE_V1_PROFILE, createHostProfile('opencode-v2')]) {
      expect(renderHostMarkdown(launches, host, 'dispatching-parallel-agents/references/launch-examples.md').match(/hive_feature_select\(\{ feature: "feature-name" \}\)/g)).toHaveLength(1);
    }
    expect(skill!.template).toContain('Batch independent Hive calls in one response/step');
    expect(skill!.template).toContain("same-call `cleanup: 'worktree+branch'`");
    expect(skill!.template).not.toContain('Only dispatch tasks that are runnable');
    expect(skill!.template).not.toContain('Proceed only after operator approval');
  });

  it('includes every native-required field in managed Forager examples', () => {
    let exampleCount = 0;

    // Disclosed references carry the complete launches, so they are scanned with every skill entry point.
    const packagedMarkdown = BUILTIN_SKILLS.flatMap((skill) => {
      const dir = path.join(resolvePackagedSkillsDir(), skill.name, 'references');
      const refs = existsSync(dir) ? readdirSync(dir).filter((file) => file.endsWith('.md')) : [];
      return [{ name: skill.name, template: skill.template }, ...refs.map((file) => ({ name: `${skill.name}/${file}`, template: readFileSync(path.join(dir, file), 'utf8') }))];
    });

    for (const skill of packagedMarkdown) {
      for (const match of skill.template.matchAll(/(?:await\s+)?task\(\{([\s\S]*?)\}\)/g)) {
        const fields = match[1];
        if (!fields.includes('forager-worker')) continue;
        exampleCount += 1;
        expect(fields, skill.name).toMatch(/\bsubagent_type\s*:/);
        expect(fields, skill.name).toMatch(/\bdescription\s*:/);
        expect(fields, skill.name).toMatch(/\bprompt\s*:/);
      }
      for (const match of skill.template.matchAll(/(?:await\s+)?subagent\(\{([\s\S]*?)\}\)/g)) {
        const fields = match[1];
        if (!fields.includes('forager-worker')) continue;
        exampleCount += 1;
        expect(fields, skill.name).toMatch(/\bagent\s*:/);
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

    // The general/helper exception is owned by the two skills that dispatch writers; background only schedules them.
    for (const name of ['dispatching-parallel-agents', 'executing-plans']) {
      const skill = BUILTIN_SKILLS.find((entry) => entry.name === name);

      expect(skill).toBeDefined();
      expect(skill!.template, name).toContain('ordinary `task()` call');
      expect(skill!.template, name).toContain('Native helpers keep only their bounded operational permissions');
    }
    for (const name of ['background-delegation', 'dispatching-parallel-agents', 'executing-plans']) {
      const skill = BUILTIN_SKILLS.find((entry) => entry.name === name);

      expect(skill).toBeDefined();
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
    const protocol = readSkillReference('background-delegation', 'board-protocol.md');
    const launches = readSkillReference('dispatching-parallel-agents', 'launch-examples.md');

    expect(skill).toBeDefined();
    expect(skill!.description).toContain('Agent Hive');
    // Wait mode and the safe-stop conditions stay inline.
    expect(skill!.template).toContain('OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS');
    expect(skill!.template).toContain('OPENCODE_EXPERIMENTAL');
    expect(skill!.template).toContain('task({ background: true');
    expect(skill!.template).toContain('native background completion notification');
    for (const tool of ['hive_background_status', 'hive_background_reconcile', 'hive_background_reconcile_batch', 'hive_background_cancel']) {
      expect(skill!.template).toContain(tool);
    }
    expect(skill!.template).not.toContain('task_status');
    expect(skill!.template).toContain('Delegation-first orchestration is the baseline');
    expect(skill!.template).toContain('Background mode only changes wait mode and board protocol');
    expect(skill!.template).toContain('background-delegation governs scheduling and wait mode');
    expect(skill!.template).toContain('Allowed foreground/blocking escape reasons: dependency, risk, simplicity, user interaction, ownership conflict, or lifecycle/board concerns.');
    expect(skill!.template).toContain('Gate-closed sessions use normal blocking `task()` wait mode');
    expect(skill!.template).toContain('Background is a wait mode, not the definition of parallelism');
    expect(skill!.template).toContain('Independent ordinary Scout, advisor, and reviewer tasks can run in parallel');
    expect(skill!.template).toContain('Lane count never selects wait mode');
    expect(skill!.template).toContain('Every Forager lane, including report-only diagnosis');
    expect(skill!.template).toContain('The owning workflow determines placement; create the matching worktree before dispatch for tracked Git writes');
    expect(skill!.template).toContain('Direct checkout work is unmanaged OpenCode work');
    expect(skill!.template).toContain('one small, local, immediately verified integration fix');
    expect(skill!.template).toContain('There is no exact-one-read or exact-one-write quota');
    expect(skill!.template).toContain('one independently answerable question or one primary goal');
    expect(skill!.template).toContain('one owner, one expected output, and one verification/return contract');
    expect(skill!.template).toContain('manual task or plan amendment');
    expect(skill!.template).toContain('Every returned result is terminal');
    expect(skill!.template).toContain('Every follow-up after a returned result uses a fresh child session');
    expect(skill!.template).toContain('observe-only board handles');
    expect(skill!.template).toContain('Pass `task_id` only when an explicit operator instruction or explicit runtime-owned interruption-recovery mechanism authorizes continuation');
    expect(skill!.template).toContain('If the child may still be active or its lifecycle is uncertain');
    expect(skill!.template).toContain('Compaction re-anchoring of a currently running worker is distinct from follow-up work');
    expect(skill!.template).toContain('tightly coupled code, tests, docs, and multiple files');
    expect(skill!.template).toContain('second patch/test loop');
    expect(skill!.template).toContain('behavior-contract change');
    expect(skill!.template).toContain('consume the lane boundaries and ready wave from `orchestrating-ad-hoc-work`; do not redefine them here');
    expect(skill!.template).toContain('terminal-unreconciled');
    expect(skill!.template).toContain('Waiting, pending, terminal-unreconciled, stale, or ownership-overlapping lanes need a board action');
    expect(skill!.template).toContain('Reconcile and ignore are bookkeeping only');
    expect(skill!.template).toContain('Cancel acknowledgement does not prove the worker stopped');
    expect(skill!.template).toContain('Treat installs, builds, formatters, generators, and tests as mutations');
    expect(skill!.template).toContain('`hive_status` is not that surface');
    expect(skill!.template).toContain("do not edit the active host's `background-jobs.json` board file directly");
    expect(skill!.template).toContain('never guess the latest child');
    expect(skill!.template).toContain('do not send another prompt or launch an overlapping writer');
    expect(skill!.template).toContain('waitingForNativeCompletion');
    expect(skill!.template).toContain('recommendedNextAction');
    expect(skill!.template).toContain("Nested delegation outside Architect's permitted blocking terminal planning-helper layer");
    expect(skill!.template).toContain('When Architect runs as a primary');
    expect(skill!.template).toContain('When Architect is task-spawned');
    expect(skill!.template).toContain('Background board tools and primary-control operations are denied in children');
    expect(skill!.template).toContain('return board/control requests');
    expect(skill!.template).toContain('references/board-protocol.md');
    expect(skill!.template).not.toContain('Treat unresolved lanes as blockers.');

    // Disclosed: field meanings, reconcile and hint handling, the one observation example and board mistakes.
    for (const detail of [
      'Treat prompt acknowledgment as notification only',
      'completionNotificationsPending > 0',
      'reconcileItemsRequired == 0',
      'schedulerGuidance.reason',
      'wait_for_native_completion_notification',
      'orchestrationBurden',
      'hive_background_reconcile_batch',
      'requiresHiveStatusRefresh',
      '`job_not_terminal` means wait for native completion',
      'Reconcile each board row exactly once',
      'archived by the tool and hidden from normal status',
      'Forgotten terminal jobs',
      'Wait-only polling',
      'Manual board mutation',
    ]) {
      expect(protocol, detail).toContain(detail);
    }
    expect(protocol.match(/^```ts$/gm)).toHaveLength(2); // the one example, once per host
    expect(skill!.template).not.toContain('requiresHiveStatusRefresh');

    // Launch mechanics are owned by dispatch, so the background skill carries no launch recipe.
    expect(launches).toContain('Blocking launch (gate-closed sessions):');
    expect(launches).toContain('Background launch (gate-open sessions):');
    expect(launches).toContain('hive_adhoc_worktree_create({ repoIds })');
    expect(launches).not.toContain('hive_adhoc_worktree_create({});');
    expect(launches).toContain("subagent_type: 'forager-worker'");
    expect(skill!.template).not.toContain('hive_adhoc_worktree_create');
    expect(skill!.template).not.toContain('Gate-closed Forager launch');

    // Placement, final-verification, specialist and verification-routing manuals belong to roles and owning workflows.
    for (const retired of ['## Specialist Selection', '## Verification Routing', '## Feature-Task Final Verification Gates', '## Decision Examples', '## Context Packet']) {
      expect(skill!.template, retired).not.toContain(retired);
    }
    for (const text of [skill!.template, protocol]) {
      expect(text).not.toContain('hive_existing_workspace_start');
      expect(text).not.toContain('hive_execution_prepare');
      expect(text).not.toContain('binding-in-progress');
      expect(text).not.toContain('wait for the native correlation event');
      expect(text).not.toContain('poll when available');
      expect(text).not.toContain('@explorer');
      expect(text).not.toContain('subtask');
      expect(text).not.toContain('tmux');
      expect(text).not.toContain('zellij');
      expect(text).not.toContain('hive_background_task');
      expect(text).not.toContain('hive_background_output');
    }

    // The packet fields and prompt placement are launch mechanics, now owned by dispatch.
    const dispatch = readSkillTemplate('dispatching-parallel-agents');
    expect(dispatch).toContain('Put the complete Forager packet directly in the unchanged native `task.prompt`');
    expect(dispatch).toContain('ordinary Scout, advisor, and reviewer packets also go in `task.prompt`');
    expect(dispatch).toContain('objective and done criteria, known findings and file or reference pointers, prior failures or attempts');
  });

  it('keeps both Forager launches lane-scoped and shows the board observation once, after native completion', () => {
    const launches = readSkillReference('dispatching-parallel-agents', 'launch-examples.md');
    const protocol = readSkillReference('background-delegation', 'board-protocol.md');
    const fence = '`'.repeat(3);
    const launchExample = (text: string, heading: string, label: string) => {
      const opening = `${heading}\n\n${label}\n\n${fence}ts\n`;
      const start = text.indexOf(opening);
      return start === -1 ? undefined : text.slice(start + opening.length, text.indexOf(`\n${fence}`, start + opening.length));
    };
    // Each host's example is complete on its own, so every assertion holds for each rendering.
    for (const [host, label, read] of [
      [OPENCODE_V1_PROFILE, 'OpenCode v1:', 'hive_repositories_status()'],
      [createHostProfile('opencode-v2'), 'OpenCode v2:', '// repositories: the repositories array from the hive_repositories_status result'],
    ] as const) {
      const text = renderHostMarkdown(launches, host, 'dispatching-parallel-agents/references/launch-examples.md');
      const gateClosed = launchExample(text, 'Blocking launch (gate-closed sessions):', label);
      const example = launchExample(text, 'Background launch (gate-open sessions):', label);
      expect(gateClosed, label).toBeDefined();
      expect(example, label).toBeDefined();
      for (const launch of [gateClosed!, example!]) {
        expect(launch).toContain(read);
        expect(launch).toContain('const requestedRepoIds = lane.repoIds;');
        expect(launch).toContain('requestedRepoIds.includes(id)');
        expect(launch).toContain('new Set(requestedRepoIds).size !== requestedRepoIds.length');
        expect(launch).toContain('requestedRepoIds.some((id) => !selectedRepoIds.includes(id))');
        expect(launch).toContain('Placement blocker: lane.repoIds must exactly match repository status IDs');
        expect(launch).toContain('const repoIds = selectedRepoIds;');
        expect(launch).toContain('hive_adhoc_worktree_create({ repoIds })');
      }
      expect(example).toContain('background: true');
      // The launch stops where the board protocol starts; reconciliation is not duplicated here.
      expect(example).not.toContain('hive_background_reconcile');

      const board = renderHostMarkdown(protocol, host, 'background-delegation/references/board-protocol.md');
      const observation = launchExample(board, 'Launch an independent read-only lane in the background, keep doing unrelated foreground work, observe the board, then reconcile once.', label);
      expect(observation, label).toBeDefined();
      expect(observation).toContain('background: true');
      expect(observation!.indexOf('hive_background_status({})')).toBeLessThan(observation!.lastIndexOf('hive_background_status({})'));
      expect(observation!.lastIndexOf('hive_background_status({})')).toBeLessThan(observation!.indexOf('hive_background_reconcile({'));
    }
  });

  describe('disclosed references of the workflow and context skills', () => {
    const REFERENCES: Record<string, string> = {
      'background-delegation': 'board-protocol.md',
      'dispatching-parallel-agents': 'launch-examples.md',
      'parallel-exploration': 'research-examples.md',
      'executing-plans': 'task-milestones.md',
      'writing-plans': 'verification-planning.md',
      'context-engineering': 'mutation-and-recovery.md',
      'systematic-debugging': 'diagnostic-techniques.md',
    };

    it('points to each reference with a read-when line and a link that stays inside the skill directory', () => {
      for (const [skill, file] of Object.entries(REFERENCES)) {
        const template = readSkillTemplate(skill);
        expect(template, skill).toMatch(new RegExp(`^Read \\[references/${file.replace('.', '\\.')}\\]\\(references/${file.replace('.', '\\.')}\\) (when|before) `, 'm'));
        const dir = path.join(resolvePackagedSkillsDir(), skill);
        for (const text of [template, readSkillReference(skill, file)]) {
          // No installed path, generated-cache path, parent-directory link or checkout-relative document is required.
          expect(text, skill).not.toMatch(/\/home\/|\.config\/opencode|agent-hive\/generated|\]\(\.\.\/|\]\(\//);
        }
        expect(existsSync(path.join(dir, 'references', file)), `${skill}/${file}`).toBe(true);
        expect(readdirSync(path.join(dir, 'references')), skill).toEqual([file]);
      }
    });

    it('states in each reference that it adds method and not authority', () => {
      for (const [skill, file] of Object.entries(REFERENCES)) {
        expect(readSkillReference(skill, file), `${skill}/${file}`).toMatch(/not authority|no authority|never authority|not authorization/);
      }
    });

    it('lets a complete own read support the requested edit while incomplete reads and corruption stay stops', () => {
      const template = readSkillTemplate('context-engineering');
      const reference = readSkillReference('context-engineering', 'mutation-and-recovery.md');
      // Routine safety is inline: an incomplete read cannot be replaced, and a missing file is the only unguarded write.
      expect(template).toContain('`complete: false` means the document is incomplete, so it cannot support a replacement');
      expect(template).toContain('Finish every chunk before constructing a whole-document replacement');
      expect(template).toContain('Omit revision and hash only when creating a missing file');
      expect(template).toContain('hive_context_read({ name: "auth-decisions" })\n');
      expect(template).toContain('A named read starts without a cursor');
      // A complete own read is the positive base for the authorized edit; a chunk only described to you is not part of it.
      expect(template).toContain('Your read is complete when you hold every chunk of one named read: your own first call without a cursor, then each `nextCursor` continuation through `complete: true`');
      expect(template).toContain("Joined in order, those chunks' `content` is the document at that read's `revision` and `contentHash`, and it is the base for a replacement you are authorized to make");
      expect(template).toContain('A chunk or cursor you were only told about, such as one quoted in an assignment or an earlier result, is not part of your read; start a new named read without a cursor');
      expect(template).toContain("Once your read is complete, carry out the requested edit: change only what was asked, keep every other byte of the document, and pass that read's revision and hash");
      expect(template).toContain('When you replace the whole document with `hive_context_write`, your read must be complete');
      expect(template).not.toContain('the ordinary route to a section edit');
      // A bounded edit needs the observed passage plus surrounding text, not unrelated chunks, and states what the guards do not prove.
      expect(template).toContain('To change one passage, use `hive_context_edit` instead; it does not need a complete read');
      expect(template).toContain('continue only until you hold the whole passage and enough surrounding text to justify the change');
      expect(template).toContain('do not report a partial read as a check of the whole document');
      expect(template).toContain('read the document and establish whether the edit applied before retrying');
      expect(template).toContain('finding `newText` in the document does not prove this call put it there');
      // The no-write promise covers refusals before publication; a publication error can leave the prior bytes or a pending marker.
      expect(template).toContain('A call refused before publication (invalid text, stale revision or hash, no match, ambiguous match, identical text, invalid metadata) writes nothing');
      expect(template).toContain('the prior bytes are restored, or a pending marker remains and the next managed mutation reports `context_reconciliation_required`');
      expect(template).toContain('do not assume an identical retry is safe');
      expect(template).not.toContain('A failed edit writes nothing');
      expect(reference).toContain('A refusal before publication, which covers every result in the table, leaves the document, index, and revision unchanged');
      expect(reference).toContain('An error while publishing restores the prior bytes or leaves the pending marker described below');
      expect(reference).not.toContain('Every failure leaves the document');
      expect(reference).toContain('hive_context_edit({');
      expect(reference).toContain('A process that writes the file directly while a publication is in progress is outside that guarantee');
      for (const reason of ['context_edit_no_match', 'context_edit_ambiguous', 'context_edit_no_change', 'stale_revision']) {
        expect(reference, reason).toContain(`\`${reason}\``);
      }
      expect(template).toContain('Stop managed mutations and report the exact error');
      expect(template).toContain('never authorizes an agent to hand-edit them');
      // Recovery stays operator work, stated before the procedure and again inline.
      const stop = reference.indexOf('An agent that meets either error stops managed mutations');
      const operator = reference.indexOf('Repair is separately authorized operator recovery');
      const steps = reference.indexOf('1. Quiesce writers.');
      expect(stop).toBeGreaterThan(-1);
      expect(stop).toBeLessThan(operator);
      expect(operator).toBeLessThan(steps);
      expect(reference).toContain('Reading this section does not authorize an agent to edit, delete, or rewrite `index.json`, the pending marker, or any manifest');
      expect(reference).toContain('the honest outcome is a stopped mutation and a report');
      expect(template).toContain('Repairing context control files is separately authorized operator recovery');
      for (const text of [template, reference]) {
        expect(text).not.toMatch(/(?:edit|rewrite|delete|remove|restore) (?:the )?`?index\.json`? (?:to|so that|and then retry)/i);
      }
    });
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

    it('states the same-name skill override per host and names no fallback copy', () => {
      const configuration = reference('configuration.md');
      const ownership = readRepoFile('packages/opencode-hive/docs/SKILL-OWNERSHIP.md');
      for (const text of [configuration, ownership]) {
        expect(text).toMatch(/[Oo]n v1/);
        expect(text).toMatch(/[Oo]n v2,? the (materialized )?copy can still hold the bundle/);
        expect(text).toContain('resolves the name to the unique user skill');
        expect(text).toContain('nothing falls back to an older generated copy');
      }
      expect(configuration).not.toContain('are not materialized for that name');
    });

    it('lists every specStaleReason hive_status can report', () => {
      const union = readRepoFile('packages/hive-core/src/services/taskService.ts')
        .match(/export type TaskSpecFreshnessReason =([^;]+);/)![1];
      const reasons = [...union.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
      expect(reasons.length).toBeGreaterThan(0);
      expect(readRepoFile('packages/opencode-hive/src/runtime/hive-tools.ts')).toContain("specStaleReason ?? 'freshness_unavailable'");
      const table = section(reference('runtime-layout.md'), '### Spec freshness (`specStaleReason`)');
      expect(new Set(firstCellNames(table))).toEqual(new Set([...reasons, 'freshness_unavailable']));
    });

    it('names every registered Hive tool and no unregistered one in the ownership reference', () => {
      const named = new Set(codeNames(reference('tool-ownership.md')).filter((name) => name.startsWith('hive_')));
      expect(named).toEqual(new Set(HIVE_TOOL_NAMES));
    });

    it('matches the paths and branches hive-core produces', () => {
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

        new BackgroundJobService(root, 'opencode-v2').registerLaunch({ taskId: 'probe', sessionId: 'probe', agentName: 'forager-worker' });
        expect(existsSync(path.join(hiveDir, 'runtime', 'opencode-v2', 'background-jobs.json'))).toBe(true);
        expect(layout).toContain('OpenCode v2 uses the same file names under `.hive/runtime/opencode-v2/`');
        expect(layout).toContain('An absent v2 store is empty, not a lost copy of v1');

        expect(getNextIndexedFeatureDirectoryName(root, 'my-feature')).toBe('01_my-feature');
        expect(layout).toContain('<NN>_<feature-name>');
        expect(reference('../SKILL.md')).toContain('`01_my-feature`');

        expect(new WorktreeService({ baseDir: root, hiveDir }).getWorktreePath('feat', '01-task', 'c'))
          .toBe(path.join(hiveDir, '.worktrees', 'feat', '01-task--c'));
        expect(layout).toContain('`.hive/.worktrees/<feature>/<task>--<candidate>`');

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
    // Retained: item-level approval, the prune bar and hard-won gotchas. The generic anti-pattern table and closing summary
    // restated rules that Progressive Placement, Write What Exists, Maintenance Workflow and Red Flags own.
    expect(template).toContain('Wait for item-level approval');
    expect(template).toContain('Do not auto-approve');
    expect(template).toContain('Silence is not evidence that a hard-won safety rule is unnecessary');
    expect(template).toContain('## Red Flags');
    expect(template).not.toContain('## Anti-Patterns');
    expect(template).not.toContain('## Summary');
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

  it('teaches writing-for-agents authors to distinguish contracts, protocols and techniques', () => {
    const template = BUILTIN_SKILLS.find((entry) => entry.name === 'writing-for-agents')!.template;
    const upstream = readFileSync(path.join(resolvePackagedSkillsDir(), 'writing-for-agents', 'UPSTREAM.md'), 'utf8');

    expect(template).toContain('## Contracts, protocols, and techniques');
    expect(template).toContain('A **contract** states a required outcome');
    expect(template).toContain('A **protocol** fixes an order because the order protects state, authority, or evidence');
    expect(template).toContain('A **technique** is a method the agent selects when it answers an open question');
    expect(template).toContain('Identical process across runs is required only where a protocol protects something');
    expect(template).not.toContain('the agent takes the same _process_ every run');
    // Hierarchy, pointer and completion-criterion guidance is retained.
    for (const retained of ['**Progressive disclosure**', '**Co-location**', 'A **context pointer**', 'completion criterion', 'single source of truth']) {
      expect(template).toContain(retained);
    }
    expect(upstream).toContain('Predictability objective');
    expect(upstream).toContain('Identical process across runs is the goal only where a protocol protects something');
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
    expect(template).toContain('stale_context_cursor');
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
    // Session-store layout is a runtime fact owned by hive-config; context selection only points there.
    expect(template).toContain('are runtime facts owned by `hive-config`');
    expect(template).toContain('a feature-local `sessions.json` is a projection and never alternate recovery truth');
    expect(template).not.toContain('`.hive/sessions.json`');
    const layout = readSkillReference('hive-config', 'runtime-layout.md');
    expect(layout).toContain('feature-local navigation projection, not canonical');
    expect(layout).toContain('It holds canonical session bindings');
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
    expect(readFileSync(path.join(writingSkillDir, 'SKILL-MECHANICS.md'), 'utf8')).toContain('`disableSkills` in the global `~/.config/opencode/agent_hive.json` only');
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
      // The docs request the skills by name or by v2 TUI @-mention, never by slash command.
      expect(content).toMatch(/Ask for `complexity-review` by name|ask for the skill by name/);
      expect(content).toContain('`@complexity-review <scope>`');
      expect(content).toContain('`@complexity-audit <scope>`');
      expect(content).not.toMatch(/\/complexity-(review|audit)/);
    }
    for (const content of [readRepoFile('packages/opencode-hive/README.md'), readRepoFile('docs/OPERATOR-GUIDE.md')]) {
      expect(content).toContain('does not register skills as slash commands');
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

describe('host sections in packaged skills', () => {
  const V2 = createHostProfile('opencode-v2');
  const HOSTS: HostProfile[] = [OPENCODE_V1_PROFILE, V2];
  const skillsRoot = resolvePackagedSkillsDir();

  function markdownFiles(): string[] {
    return readdirSync(skillsRoot, { recursive: true, encoding: 'utf8' })
      .filter((relative) => relative.endsWith('.md') && existsSync(path.join(skillsRoot, relative.split(path.sep)[0]!, 'SKILL.md')));
  }
  const rawText = (relative: string) => readFileSync(path.join(skillsRoot, relative), 'utf8');
  const rendered = (relative: string, host: HostProfile) => renderHostMarkdown(rawText(relative), host, relative);
  const sectionTexts = (name: string, host: HostProfile) => markdownFiles()
    .filter((relative) => relative.split(path.sep)[0] === name)
    .map((relative) => rendered(relative, host))
    .join('\n');
  const hostSensitive = ['background-delegation', 'dispatching-parallel-agents', 'parallel-exploration', 'executing-plans', 'hive-config'];

  it('pairs every host section, closes it, and removes every marker when rendered', () => {
    for (const relative of markdownFiles()) {
      const raw = rawText(relative);
      expect((raw.match(/^<!-- hive-host opencode-v1 -->$/gm) ?? []).length, relative).toBe((raw.match(/^<!-- hive-host opencode-v2 -->$/gm) ?? []).length);
      for (const host of HOSTS) {
        const out = rendered(relative, host);
        expect(out, relative).not.toContain('hive-host');
        expect(out, relative).not.toMatch(/\{\{|@@|%HOST%/);
      }
    }
  });

  it('contains no backslash-escaped backticks in packaged skill Markdown', () => {
    for (const relative of markdownFiles()) expect(rawText(relative), relative).not.toContain('\\`');
  });

  it('keeps every host section readable in the raw package source with no placeholders', () => {
    const raw = rawText('background-delegation/SKILL.md');
    expect(raw).toContain('`task({ background: true, ... })`');
    expect(raw).toContain('`subagent({ background: true, ... })`');
    expect(raw).not.toMatch(/\{\{|@@|%HOST%/);
    expect(parseNativeSkillMarkdown('raw', raw)?.name).toBe('background-delegation');
  });

  it('renders OpenCode v1 wording without v2 syntax and OpenCode v2 wording without v1 syntax', () => {
    const allSkills = readdirSync(skillsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    // Every skill is checked, so a new native-syntax sentence outside a host section fails here.
    expect(allSkills).toEqual(expect.arrayContaining(hostSensitive));
    for (const name of allSkills) {
      const v1 = sectionTexts(name, OPENCODE_V1_PROFILE);
      const v2 = sectionTexts(name, V2);
      expect(v1, name).not.toMatch(/\bsubagent\(|sessionID|`subagent`|skill\(\{ id/);
      expect(v2, name).not.toMatch(/\btask\(|subagent_type|`task\.prompt`|skill\(\{ name/);
      // `task_id` is only the Hive trace tool's own argument on v2.
      expect(v2.replace(/hive_task_trace\(\{ task_id/g, ''), name).not.toContain('task_id');
    }
  });

  it('keeps every raw code example complete, with host markers outside the fences', () => {
    // Native discovery serves the raw file, so a fence must hold one whole example and never a marker.
    const hostsMentioned = (code: string) => [/\btask\(/.test(code), /\bsubagent\(/.test(code)].filter(Boolean).length;
    const unbalanced = (code: string) => {
      const stack: string[] = [];
      const pairs: Record<string, string> = { ')': '(', '}': '{', ']': '[' };
      for (const char of code) {
        if ('({['.includes(char)) stack.push(char);
        else if (pairs[char] !== undefined && stack.pop() !== pairs[char]) return true;
      }
      return stack.length > 0;
    };
    let checked = 0;
    for (const relative of markdownFiles()) {
      let open: { line: number; lang: string; body: string[] } | undefined;
      for (const [index, line] of rawText(relative).split('\n').entries()) {
        const fence = /^\s*```(\w*)\s*$/.exec(line);
        if (fence && !open) {
          open = { line: index + 1, lang: fence[1]!, body: [] };
        } else if (fence && open) {
          const code = open.body.join('\n');
          const where = `${relative}:${open.line}`;
          if (/^(ts|typescript)$/.test(open.lang)) {
            expect(unbalanced(code), `${where} holds an incomplete example`).toBe(false);
            expect(hostsMentioned(code), `${where} mixes both hosts' native calls`).toBeLessThanOrEqual(1);
            checked += 1;
          }
          open = undefined;
        } else if (open) {
          expect(line, `${relative}:${index + 1} puts a host marker inside a code fence`).not.toContain('hive-host');
          open.body.push(line);
        }
      }
      expect(open, `${relative} leaves a code fence open`).toBeUndefined();
    }
    expect(checked).toBeGreaterThan(10);
  });

  it('renders the same number of complete examples for each host', () => {
    const fenceCount = (text: string) => (text.match(/^```(?:ts|typescript)$/gm) ?? []).length;
    for (const relative of markdownFiles()) {
      expect(fenceCount(rendered(relative, OPENCODE_V1_PROFILE)), relative).toBe(fenceCount(rendered(relative, V2)));
    }
  });

  it('obtains repository status through the selected read transport on every profile', () => {
    const profiles = [OPENCODE_V1_PROFILE, V2, createHostProfile('opencode-v2', { readTransport: 'direct' })];
    for (const host of profiles) {
      const skill = sectionTexts('dispatching-parallel-agents', host);
      const system = renderHiveSystemPrompt(host);
      if (host.host === 'opencode-v1') {
        // Direct host: the example reads the status as an ordinary call.
        expect(skill).toContain('const { repositories } = hive_repositories_status();');
        expect(system).not.toContain('Hive Read Transport');
        continue;
      }
      // Neither v2 transport can issue the read as a direct call from the example.
      expect(skill).not.toMatch(/hive_repositories_status\(/);
      expect(skill).toContain('// repositories: the repositories array from the hive_repositories_status result, read through the Hive read transport first.');
      expect(skill).toContain('obtain its result through the Hive read transport your system prompt names before the launch');
      expect(skill).toContain('the examples below bind its `repositories` array property, not the whole result, as `repositories`');
      // The skill's two branches match the statement the profile's system prompt makes.
      expect(skill).toContain('call it from code passed to `execute`, using the exact path the Code Mode catalog lists');
      expect(skill).toContain('when your system prompt says Hive reads are direct tool calls, call it directly');
      expect(skill).not.toMatch(/\bhive\.[a-z_]+\(|tools\.hive_|mcp__|codemode\./);
      if (host.readTransport === 'codemode') {
        expect(system).toContain('call them from code passed to `execute`, using the exact paths its Code Mode catalog lists');
      } else {
        expect(system).toContain('are direct tool calls');
      }
      // Control tools and the native subagent call stay direct after the read.
      expect(skill).toContain('The Hive control tools and the native `subagent()` call in them are direct calls.');
    }
  });

  it('keeps the corruption preflight on the active host\'s session index', () => {
    const layout = (host: HostProfile) => {
      const text = rendered('hive-config/references/runtime-layout.md', host);
      const start = text.indexOf('The session index is');
      return text.slice(start, text.indexOf('## Background board'));
    };
    const v1 = layout(OPENCODE_V1_PROFILE);
    expect(v1).toContain('The session index is `.hive/sessions.json`.');
    expect(v1).toContain('The host\'s `chat.message` hook');
    const v2 = layout(V2);
    expect(v2).toContain('The session index is `.hive/runtime/opencode-v2/sessions.json`.');
    expect(v2).toContain('`sessions.json.corrupt-<timestamp>` sibling in the same directory');
    expect(v2).toContain('`sessions.json.corrupt-*` sibling exists in its directory');
    // No v1 path or v1 hook claim in a recipe an OpenCode v2 agent would follow.
    expect(v2).not.toContain('.hive/sessions.json');
    expect(v2).not.toContain('chat.message');
    for (const host of HOSTS) {
      const text = layout(host);
      expect(text).toContain('So read the session index directly, with a shell or file read, before any session-resolving call.');
      expect(text).toContain('report both paths to the primary or operator, who decides how to restore it');
      expect(text).toContain('avoid session-resolving calls; when you need a feature-scoped read, pass `feature` explicitly');
    }
    const overview = rendered('hive-config/SKILL.md', V2);
    expect(overview).toContain('(`.hive/runtime/opencode-v2/sessions.json`)');
    expect(overview).not.toContain('chat message');
    expect(rendered('hive-config/SKILL.md', OPENCODE_V1_PROFILE)).toContain('a corrupt `sessions.json` is reset by the next chat message or by any tool call that resolves a session route');
  });

  it('describes background tool gating only as the active host gates it', () => {
    const ownership = (host: HostProfile) => rendered('hive-config/references/tool-ownership.md', host);
    expect(ownership(OPENCODE_V1_PROFILE).match(/experiment-gated/g)?.length).toBe(2);
    expect(ownership(V2)).not.toContain('experiment-gated');
    expect(ownership(V2)).toContain('`.hive/runtime/opencode-v2/background-jobs.json` for OpenCode v2');
    for (const name of ['background-delegation', 'parallel-exploration']) {
      expect(sectionTexts(name, V2), name).not.toContain('env-gated');
    }
  });

  it('keeps native dispatch rules at the same strength on both hosts', () => {
    for (const host of HOSTS) {
      const dispatch = sectionTexts('dispatching-parallel-agents', host);
      const background = rendered('background-delegation/SKILL.md', host);
      const call = host.nativeTask.tool + '()';
      const field = host.nativeTask.continuationField;
      expect(dispatch).toContain(`Dispatch one primary goal per native \`${call}\` invocation and expect one terminal report.`);
      expect(dispatch).toContain(`Primaries must not pass \`${field}\` or infer continuation eligibility`);
      expect(dispatch).toContain(`only when explicit operator instruction or runtime-owned interruption recovery authorizes continuation; otherwise launch fresh.`);
      expect(dispatch).toContain(`A rare native \`general\` exception is an ordinary \`${call}\` call with ordinary tools only: no Hive authority, recursion, or questions.`);
      expect(dispatch).toContain(`${host.nativeTask.agentField}: 'forager-worker'`);
      // Background schedules launches; its safe-launch rule keeps the same continuation strength without the launch recipes.
      expect(background).toContain(`Pass \`${field}\` only when an explicit operator instruction or explicit runtime-owned interruption-recovery mechanism authorizes continuation; otherwise launch fresh.`);
      expect(background).toContain(`Every Forager lane, including report-only diagnosis, needs a native \`${call}\` call with a Forager or Forager-derived agent.`);
    }
  });

  it('keeps the OpenCode v1 database recipes version-scoped and gives v2 only public reads', () => {
    const v1 = sectionTexts('hive-config', OPENCODE_V1_PROFILE);
    const v2 = sectionTexts('hive-config', V2);
    expect(v1).toContain('## OpenCode v1 session store');
    expect(v1).toContain('sqlite3 -readonly');
    expect(v2).toContain('## OpenCode v2 sessions');
    expect(v2).toContain('`hive_task_trace_content`');
    expect(v2).toContain('do not read the host\'s database directly');
    for (const forbidden of ['sqlite3', 'opencode.db', 'OPENCODE_DB', 'json_extract']) expect(v2, forbidden).not.toContain(forbidden);
  });

  it('describes v2 background and nesting settings without an experiment variable or config rewrite', () => {
    const v2 = sectionTexts('hive-config', V2) + sectionTexts('background-delegation', V2);
    expect(v2).toContain('No experiment variable gates background subagents on OpenCode v2.');
    expect(v2).toContain('Hive does not rewrite it');
    expect(v2).not.toContain('OPENCODE_EXPERIMENTAL');
    expect(sectionTexts('hive-config', OPENCODE_V1_PROFILE)).toContain('OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS');
  });

  it('names each host\'s own board store and keeps the shared board rule host-neutral', () => {
    const v1 = sectionTexts('background-delegation', OPENCODE_V1_PROFILE);
    const v2 = sectionTexts('background-delegation', V2);
    expect(v1).toContain('.hive/background-jobs.json');
    expect(v1).not.toContain('opencode-v2/background-jobs.json');
    expect(v2).toContain('.hive/runtime/opencode-v2/background-jobs.json');
    expect(v2).not.toMatch(/\.hive\/background-jobs\.json/);
    for (const host of HOSTS) {
      expect(rendered('background-delegation/SKILL.md', host)).toContain("do not edit the active host's `background-jobs.json` board file directly");
      expect(rendered('background-delegation/references/board-protocol.md', host)).toContain("Manual board mutation: editing the active host's `background-jobs.json`");
    }
  });

  it('words the OpenCode v2 serialization rule as a complete sentence', () => {
    expect(rendered('parallel-exploration/SKILL.md', V2)).toContain('If the only reason for serializing is that `subagent()` is blocking, that is incorrect.');
  });

  it('attributes global config creation and creation-time child state to OpenCode v1 only', () => {
    const v1 = rendered('hive-config/references/configuration.md', OPENCODE_V1_PROFILE);
    const v2 = rendered('hive-config/references/configuration.md', V2);
    expect(v1).toContain("the plugin's config hook creates it at host startup");
    expect(v1).toContain('Existing child sessions keep their creation-time permissions and prompts.');
    expect(v2).toContain('The v2 entry never creates the global file.');
    expect(v2).toContain('catalog built at activation');
    expect(v2).not.toContain('creation-time permissions');
    expect(v2).not.toContain("config hook creates it");
  });
});
