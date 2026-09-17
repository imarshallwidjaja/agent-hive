import { randomUUID } from 'node:crypto';
import type { StandingConstraintEntry } from '../types.js';

export const CONSTRAINTS_MAX_CHARS = 8000;
export const LEGACY_CONSTRAINT_ID = 'legacy';

export interface ConstraintRegister {
  entries: StandingConstraintEntry[];
  revision: number;
  constraints: string;
  constraintsChars: number;
}

interface StoredConstraintRegister {
  entries: StandingConstraintEntry[];
  revision: number;
}

const CONSTRAINT_ID_PATTERN = /^constraint-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ConstraintRegisterError extends Error {
  constructor(
    readonly reason: 'blank_constraint' | 'constraints_too_long' | 'constraint_not_found' | 'invalid_register' | 'stale_revision',
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function readConstraintRegister(
  stored?: unknown,
): ConstraintRegister {
  if (stored === undefined) return buildRegister([], 0);
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) {
    throw invalidRegister('Register must be an object.');
  }
  const candidate = stored as Partial<StoredConstraintRegister>;
  if (!Array.isArray(candidate.entries)) {
    throw invalidRegister('Register entries must be an array.', { field: 'entries' });
  }
  if (!Number.isSafeInteger(candidate.revision) || candidate.revision! < 0) {
    throw invalidRegister('Register revision must be a non-negative safe integer.', { field: 'revision' });
  }

  const ids = new Set<string>();
  const entries = candidate.entries.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw invalidRegister('Constraint entries must be objects.', { index });
    }
    const { id, text } = entry as StandingConstraintEntry;
    if (typeof id !== 'string' || (id !== LEGACY_CONSTRAINT_ID && !CONSTRAINT_ID_PATTERN.test(id))) {
      throw invalidRegister('Constraint entry ID is malformed.', { field: 'id', index });
    }
    if (ids.has(id)) throw invalidRegister('Constraint entry IDs must be unique.', { field: 'id', id, index });
    if (typeof text !== 'string' || !text.trim()) {
      throw invalidRegister('Constraint entry text must be a non-blank string.', { field: 'text', index });
    }
    ids.add(id);
    return { id, text };
  });
  return buildRegister(entries, candidate.revision!);
}

function invalidRegister(message: string, details: Record<string, unknown> = {}): ConstraintRegisterError {
  return new ConstraintRegisterError('invalid_register', message, details);
}

function buildRegister(entries: StandingConstraintEntry[], revision: number): ConstraintRegister {
  const constraints = entries.map((entry) => entry.text).join('\n\n');
  const register = {
    entries,
    revision,
    constraints,
    constraintsChars: constraints.length,
  };
  if (register.constraintsChars > CONSTRAINTS_MAX_CHARS) {
    throw new ConstraintRegisterError(
      'constraints_too_long',
      `Constraints are ${register.constraintsChars} characters (UTF-16 code units), over the ${CONSTRAINTS_MAX_CHARS} character cap.`,
      { constraintsChars: register.constraintsChars, cap: CONSTRAINTS_MAX_CHARS },
    );
  }
  return register;
}

function buildConstraintRegister(entries: StandingConstraintEntry[], revision: number): ConstraintRegister {
  return readConstraintRegister({ entries, revision });
}

export function addConstraint(register: ConstraintRegister, text: string): ConstraintRegister {
  if (!text.trim()) {
    throw new ConstraintRegisterError('blank_constraint', 'Constraint additions must not be blank.');
  }
  if (register.entries.some((entry) => entry.text === text)) return register;
  return buildConstraintRegister(
    [...register.entries, { id: `constraint-${randomUUID()}`, text }],
    register.revision + 1,
  );
}

export function editConstraint(
  register: ConstraintRegister,
  id: string,
  expectedRevision: number,
  replacement: string | null,
): ConstraintRegister {
  if (replacement !== null && !replacement.trim()) {
    throw new ConstraintRegisterError('blank_constraint', 'Constraint edits must not be blank. Use explicit removal instead.');
  }
  if (register.revision !== expectedRevision) {
    throw new ConstraintRegisterError(
      'stale_revision',
      `Constraints changed since revision ${expectedRevision}; current revision is ${register.revision}.`,
      { expectedRevision, revision: register.revision },
    );
  }
  const index = register.entries.findIndex((entry) => entry.id === id);
  if (index === -1) {
    throw new ConstraintRegisterError('constraint_not_found', `Constraint ID "${id}" does not exist.`, { id });
  }
  if (replacement === register.entries[index]!.text) return register;

  const entries = register.entries.map((entry) => ({ ...entry }));
  if (replacement === null) entries.splice(index, 1);
  else entries[index] = { ...entries[index]!, text: replacement };
  return buildConstraintRegister(entries, register.revision + 1);
}

export function clearConstraints(register: ConstraintRegister, expectedRevision: number): ConstraintRegister {
  if (register.revision !== expectedRevision) {
    throw new ConstraintRegisterError(
      'stale_revision',
      `Constraints changed since revision ${expectedRevision}; current revision is ${register.revision}.`,
      { expectedRevision, revision: register.revision },
    );
  }
  return buildConstraintRegister([], register.revision + 1);
}
