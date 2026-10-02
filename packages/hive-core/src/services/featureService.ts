import * as path from 'path';
import {
  getFeaturesPath,
  getNextIndexedFeatureDirectoryName,
  getFeatureJsonPath,
  getTasksPath,
  listFeatureDirectories,
  ensureDir,
  readJson,
  writeJson,
  assertValidFeatureName,
} from '../utils/paths.js';
import type { FeatureJson, FeatureStatusType } from '../types.js';

export { FEATURE_NAME_PATTERN, assertValidFeatureName } from '../utils/paths.js';

export class FeatureService {
  constructor(private projectRoot: string) {}

  create(name: string, ticket?: string): FeatureJson {
    assertValidFeatureName(name);
    const existingFeature = listFeatureDirectories(this.projectRoot).find((feature) => feature.logicalName === name);
    if (existingFeature) {
      throw new Error(`Feature '${name}' already exists`);
    }

    const featurePath = path.join(getFeaturesPath(this.projectRoot), getNextIndexedFeatureDirectoryName(this.projectRoot, name));

    ensureDir(featurePath);
    ensureDir(getTasksPath(this.projectRoot, name));

    const feature: FeatureJson = {
      name,
      status: 'planning',
      ticket,
      createdAt: new Date().toISOString(),
    };

    writeJson(getFeatureJsonPath(this.projectRoot, name), feature);

    return feature;
  }

  get(name: string): FeatureJson | null {
    return readJson<FeatureJson>(getFeatureJsonPath(this.projectRoot, name));
  }

  list(options?: { includeArchived?: boolean }): string[] {
    const features = listFeatureDirectories(this.projectRoot);
    return features
      .filter((feature) => {
        if (options?.includeArchived) return true;
        const json = readJson<FeatureJson>(getFeatureJsonPath(this.projectRoot, feature.logicalName));
        return json?.status !== 'archived';
      })
      .map((feature) => feature.logicalName)
      .sort((left, right) => left.localeCompare(right));
  }

  updateStatus(name: string, status: FeatureStatusType): FeatureJson {
    const feature = this.get(name);
    if (!feature) throw new Error(`Feature '${name}' not found`);
    if (feature.status === 'completed' && status !== 'completed') {
      throw new Error(`Feature '${name}' is completed and cannot be reopened`);
    }

    feature.status = status;
    
    if (status === 'approved' && !feature.approvedAt) {
      feature.approvedAt = new Date().toISOString();
    }
    if (status === 'completed' && !feature.completedAt) {
      feature.completedAt = new Date().toISOString();
    }
    if (status === 'archived' && !feature.archivedAt) {
      feature.archivedAt = new Date().toISOString();
    }

    writeJson(getFeatureJsonPath(this.projectRoot, name), feature);
    return feature;
  }

  complete(name: string): FeatureJson {
    const feature = this.get(name);
    if (!feature) throw new Error(`Feature '${name}' not found`);
    
    if (feature.status === 'completed') {
      throw new Error(`Feature '${name}' is already completed`);
    }

    return this.updateStatus(name, 'completed');
  }

  archive(name: string, reason?: string): FeatureJson {
    const feature = this.get(name);
    if (!feature) throw new Error(`Feature '${name}' not found`);
    if (feature.status === 'completed') {
      throw new Error(`Feature '${name}' is completed and cannot be archived`);
    }

    feature.status = 'archived';
    if (!feature.archivedAt) {
      feature.archivedAt = new Date().toISOString();
    }
    if (reason) {
      feature.archiveReason = reason;
    }

    writeJson(getFeatureJsonPath(this.projectRoot, name), feature);
    return feature;
  }

  setSession(name: string, sessionId: string): void {
    const feature = this.get(name);
    if (!feature) throw new Error(`Feature '${name}' not found`);

    feature.sessionId = sessionId;
    writeJson(getFeatureJsonPath(this.projectRoot, name), feature);
  }

  getSession(name: string): string | undefined {
    const feature = this.get(name);
    return feature?.sessionId;
  }

}
