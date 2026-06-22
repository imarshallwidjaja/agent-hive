import * as fs from 'fs';
import * as path from 'path';
import {
  getActiveFeaturePath,
  getFeaturePath,
  getFeaturesPath,
  getNextIndexedFeatureDirectoryName,
  getFeatureJsonPath,
  getTasksPath,
  getPlanPath,
  listFeatureDirectories,
  ensureDir,
  readJson,
  writeJson,
  fileExists,
} from '../utils/paths.js';
import type { FeatureJson, FeatureStatusType, TaskInfo, FeatureInfo, TaskStatus } from '../types.js';
import { ReviewService } from './reviewService.js';

export class FeatureService {
  private reviewService: ReviewService;

  constructor(private projectRoot: string) {}

  private getReviewService(): ReviewService {
    if (!this.reviewService) {
      this.reviewService = new ReviewService(this.projectRoot);
    }

    return this.reviewService;
  }

  create(name: string, ticket?: string): FeatureJson {
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
    ensureDir(path.dirname(getActiveFeaturePath(this.projectRoot)));
    fs.writeFileSync(getActiveFeaturePath(this.projectRoot), name, 'utf-8');

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

  getActive(): FeatureJson | null {
    const activeName = this.readActiveFeatureName();
    if (activeName) {
      const activeFeature = this.get(activeName);
      if (activeFeature && isActiveFeatureStatus(activeFeature.status)) {
        return activeFeature;
      }
    }

    const features = this.list();
    for (const name of features) {
      const feature = this.get(name);
      if (feature && isActiveFeatureStatus(feature.status)) {
        return feature;
      }
    }
    return null;
  }

  setActive(name: string): void {
    const feature = this.get(name);
    if (!feature) {
      throw new Error(`Feature '${name}' not found`);
    }

    ensureDir(path.dirname(getActiveFeaturePath(this.projectRoot)));
    fs.writeFileSync(getActiveFeaturePath(this.projectRoot), name, 'utf-8');
  }

  updateStatus(name: string, status: FeatureStatusType): FeatureJson {
    const feature = this.get(name);
    if (!feature) throw new Error(`Feature '${name}' not found`);

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

  getInfo(name: string): FeatureInfo | null {
    const feature = this.get(name);
    if (!feature) return null;

    const tasks = this.getTasks(name);
    const hasPlan = fileExists(getPlanPath(this.projectRoot, name));
    const reviewCounts = this.getReviewService().countByDocument(name);
    const commentCount = reviewCounts.plan;

    return {
      name: feature.name,
      status: feature.status,
      tasks,
      hasPlan,
      commentCount,
      reviewCounts,
    };
  }

  private getTasks(featureName: string): TaskInfo[] {
    const tasksPath = getTasksPath(this.projectRoot, featureName);
    if (!fileExists(tasksPath)) return [];

    const folders = fs.readdirSync(tasksPath, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort();

    return folders.map(folder => {
      const statusPath = `${tasksPath}/${folder}/status.json`;
      const status = readJson<TaskStatus>(statusPath);
      const name = folder.replace(/^\d+-/, '');
      
      return {
        folder,
        name,
        status: status?.status || 'pending',
        origin: status?.origin || 'plan',
        planTitle: status?.planTitle,
        summary: status?.summary,
      };
    });
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

  private readActiveFeatureName(): string | null {
    const activeFeaturePath = getActiveFeaturePath(this.projectRoot);
    if (!fileExists(activeFeaturePath)) {
      return null;
    }

    const activeFeature = fs.readFileSync(activeFeaturePath, 'utf-8').trim();
    return activeFeature || null;
  }
}

function isActiveFeatureStatus(status: FeatureStatusType): boolean {
  return status === 'planning' || status === 'approved' || status === 'executing';
}
