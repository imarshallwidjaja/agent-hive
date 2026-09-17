import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FeatureJson } from '../types.js';
import {
  acquireLockSync,
  FEATURE_NAME_PATTERN,
  fileExists,
  getFeaturesPath,
  listFeatureDirectories,
  readJson,
  writeJsonAtomic,
} from '../utils/paths.js';
import {
  addConstraint,
  clearConstraints,
  editConstraint,
  readConstraintRegister,
} from './constraintRegister.js';
import type { ConstraintRegister } from './constraintRegister.js';

export function resolveExistingFeaturePath(projectRoot: string, featureName: string): string {
  const matches = listFeatureDirectories(projectRoot).filter((entry) => {
    const feature = readJson<FeatureJson>(path.join(getFeaturesPath(projectRoot), entry.directoryName, 'feature.json'));
    return typeof feature?.name === 'string'
      && FEATURE_NAME_PATTERN.test(feature.name)
      && (entry.directoryName === featureName || feature.name === featureName);
  });
  if (matches.length !== 1) {
    throw new Error(matches.length === 0
      ? `Feature '${featureName}' not found`
      : `Feature namespace contains multiple entries named '${featureName}'`);
  }
  return path.join(getFeaturesPath(projectRoot), matches[0]!.directoryName);
}

export class FeatureConstraintService {
  constructor(private readonly projectRoot: string) {}

  private constraintsPath(featureName: string): string {
    return path.join(resolveExistingFeaturePath(this.projectRoot, featureName), 'constraints.json');
  }

  private readStored(filePath: string): unknown {
    if (!fileExists(filePath)) return undefined;
    if (fs.lstatSync(filePath).isSymbolicLink()) {
      throw new Error('Feature constraints path must not be a symbolic link');
    }
    return readJson<unknown>(filePath);
  }

  private update(featureName: string, mutation: (register: ConstraintRegister) => ConstraintRegister): ConstraintRegister {
    const filePath = this.constraintsPath(featureName);
    const release = acquireLockSync(filePath);
    try {
      const next = mutation(readConstraintRegister(this.readStored(filePath)));
      writeJsonAtomic(filePath, { entries: next.entries, revision: next.revision });
      return next;
    } finally {
      release();
    }
  }

  read(featureName: string): ConstraintRegister {
    return readConstraintRegister(this.readStored(this.constraintsPath(featureName)));
  }

  add(featureName: string, text: string): ConstraintRegister {
    return this.update(featureName, (register) => addConstraint(register, text));
  }

  edit(featureName: string, id: string, expectedRevision: number, replacement: string | null): ConstraintRegister {
    return this.update(featureName, (register) => editConstraint(register, id, expectedRevision, replacement));
  }

  clear(featureName: string, expectedRevision: number): ConstraintRegister {
    return this.update(featureName, (register) => clearConstraints(register, expectedRevision));
  }
}
