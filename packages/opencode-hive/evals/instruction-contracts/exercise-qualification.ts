// Credential-free qualification scripts for supervised exercises. Each prompt carries a `[[script:...]]` directive
// that the loopback mock provider (fixture.ts mock-provider) follows one native tool call per assistant turn, so the
// qualification drives real Hive tools, real native questions, permissions and child sessions on the installed hosts.
// It proves the supervision plumbing only: a scripted primary says nothing about how a real model behaves.
import { scriptDirective } from './fixture.ts';

type Json = any;

export const QUALIFICATION_FEATURE = 'exercise-qualification';
export const QUALIFICATION_ANSWER = 'alpha';
export const CHILD_RETURN_MARKER = 'QUALIFICATION-CHILD-RETURN';
export const COMPLETION_MARKER = 'QUALIFICATION-COMPLETE';
export const EXTERNAL_READS = ['/etc/hostname', '/etc/os-release'];

export const QUALIFICATION_PLAN = [
  '# Exercise qualification',
  '',
  '## Discovery',
  '',
  'Synthetic plan written by the credential-free exercise qualification.',
  '',
  '## Tasks',
  '',
  '### 1. Write the qualification marker',
  '',
  '**Depends on**: none',
  '',
  'Write one marker file.',
  '',
].join('\n');

/** Miniature disposable repository the qualification container starts from. */
export const QUALIFICATION_FILES = [
  { path: 'README.md', content: '# Qualification project\n\nDisposable repository for the exercise qualification.\n' },
  { path: 'src/value.txt', content: 'initial\n' },
];

/**
 * The scripted prompt for one qualification step. `planning` asks a native question, dispatches two children whose
 * external reads each raise a permission request (the first answered once, the second rejected), and reads the plan; `reread` reads the commented plan again;
 * `rewrite` rewrites it unchanged (which clears review comments, a real plugin operation) and reads it; `approve` approves the
 * revision the supervisor named; `execute` runs under the switched execution primary and writes one new project file;
 * `faultQuestion` and `faultPermission` each raise one request whose reply the qualification then loses.
 */
export function qualificationPrompt(step: string, facts: Json = {}): string {
  const F = QUALIFICATION_FEATURE;
  switch (step) {
    case 'planning':
      return `Qualification planning turn.\n${scriptDirective([
        { op: 'hive', tool: 'hive_feature_create', args: { name: F } },
        { op: 'hive', tool: 'hive_plan_write', args: { feature: F, content: QUALIFICATION_PLAN } },
        { op: 'native', tool: 'question', args: { questions: [{ question: 'Which marker should the plan use?', header: 'Marker', options: [{ label: QUALIFICATION_ANSWER, description: 'First marker' }, { label: 'beta', description: 'Second marker' }], multiple: false }] } },
        // A rejected permission ends the asking child's turn on both hosts, so the accepted read and the child's
        // return happen in one child and the rejected read in a second.
        { op: 'dispatch', agent: 'scout-researcher', prompt: 'Qualification child: read one external file and return.', script: [
          { op: 'read', path: EXTERNAL_READS[0] },
          { op: 'text', text: CHILD_RETURN_MARKER },
        ] },
        { op: 'dispatch', agent: 'scout-researcher', prompt: 'Qualification child: read one external file.', script: [
          { op: 'read', path: EXTERNAL_READS[1] },
          { op: 'text', text: 'Read finished.' },
        ] },
        { op: 'hive', tool: 'hive_plan_read', args: { feature: F } },
        { op: 'text', text: 'Plan ready for supervisor review.' },
      ])}`;
    case 'reread':
      return `Qualification review turn.\n${scriptDirective([
        { op: 'hive', tool: 'hive_plan_read', args: { feature: F } },
        { op: 'text', text: 'Plan reread with review comments.' },
      ])}`;
    case 'rewrite':
      return `Qualification revision turn.\n${scriptDirective([
        { op: 'hive', tool: 'hive_plan_write', args: { feature: F, content: QUALIFICATION_PLAN } },
        { op: 'hive', tool: 'hive_plan_read', args: { feature: F } },
        { op: 'text', text: 'Plan rewritten after review.' },
      ])}`;
    case 'approve':
      return scriptDirective([
        { op: 'hive', tool: 'hive_plan_approve', args: { feature: F, expectedRevision: facts.revision, sync: true } },
        { op: 'hive', tool: 'hive_plan_read', args: { feature: F } },
        { op: 'text', text: 'Approved the named revision.' },
      ]);
    case 'execute':
      return `Qualification execution turn.\n${scriptDirective([
        { op: 'hive', tool: 'hive_status', args: { feature: F } },
        { op: 'write', path: '/work/proj/src/qualified.txt', content: 'qualified\n' },
        { op: 'text', text: COMPLETION_MARKER },
      ])}`;
    case 'faultQuestion':
      return `Qualification fault turn.\n${scriptDirective([
        { op: 'native', tool: 'question', args: { questions: [{ question: 'Which fault marker?', header: 'Fault', options: [{ label: 'gamma', description: 'First fault marker' }, { label: 'delta', description: 'Second fault marker' }], multiple: false }] } },
        { op: 'text', text: 'Fault question answered.' },
      ])}`;
    case 'faultPermission':
      return `Qualification fault turn.\n${scriptDirective([
        { op: 'dispatch', agent: 'scout-researcher', prompt: 'Qualification child: read one external file.', script: [
          { op: 'read', path: EXTERNAL_READS[0] },
          { op: 'text', text: 'Read finished.' },
        ] },
        { op: 'text', text: 'Fault permission handled.' },
      ])}`;
    default:
      throw new Error('unknown qualification step');
  }
}
