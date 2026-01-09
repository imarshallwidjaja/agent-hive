import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import { FeatureService } from "./featureService";
import { getFeatureJsonPath, getFeaturePath } from "../utils/paths";

const TEST_ROOT = "/tmp/hive-test-feature";

describe("FeatureService", () => {
  let service: FeatureService;

  beforeEach(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    service = new FeatureService(TEST_ROOT);
  });

  afterEach(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  describe("create", () => {
    it("creates a new feature with default status", () => {
      const feature = service.create("test-feature");
      
      expect(feature.name).toBe("test-feature");
      expect(feature.status).toBe("planning");
      expect(feature.createdAt).toBeDefined();
      expect(feature.ticket).toBeUndefined();
    });

    it("creates a feature with ticket", () => {
      const feature = service.create("test-feature", "JIRA-123");
      
      expect(feature.ticket).toBe("JIRA-123");
    });

    it("creates feature directory structure", () => {
      service.create("my-feature");
      
      const featurePath = getFeaturePath(TEST_ROOT, "my-feature");
      expect(fs.existsSync(featurePath)).toBe(true);
      expect(fs.existsSync(getFeatureJsonPath(TEST_ROOT, "my-feature"))).toBe(true);
    });

    it("throws if feature already exists", () => {
      service.create("existing");
      
      expect(() => service.create("existing")).toThrow();
    });
  });

  describe("get", () => {
    it("returns feature data", () => {
      service.create("test-feature", "TICKET-1");
      
      const feature = service.get("test-feature");
      
      expect(feature).not.toBeNull();
      expect(feature!.name).toBe("test-feature");
      expect(feature!.ticket).toBe("TICKET-1");
    });

    it("returns null for non-existing feature", () => {
      expect(service.get("nope")).toBeNull();
    });
  });

  describe("list", () => {
    it("returns empty array when no features", () => {
      expect(service.list()).toEqual([]);
    });

    it("returns all feature names", () => {
      service.create("feature-a");
      service.create("feature-b");
      service.create("feature-c");
      
      const features = service.list();
      
      expect(features).toContain("feature-a");
      expect(features).toContain("feature-b");
      expect(features).toContain("feature-c");
      expect(features.length).toBe(3);
    });
  });

  describe("updateStatus", () => {
    it("updates feature status", () => {
      service.create("test");
      
      service.updateStatus("test", "approved");
      
      const feature = service.get("test");
      expect(feature!.status).toBe("approved");
    });

    it("sets approvedAt when status becomes approved", () => {
      service.create("test");
      
      service.updateStatus("test", "approved");
      
      const feature = service.get("test");
      expect(feature!.approvedAt).toBeDefined();
    });

    it("sets completedAt when status becomes completed", () => {
      service.create("test");
      
      service.updateStatus("test", "completed");
      
      const feature = service.get("test");
      expect(feature!.completedAt).toBeDefined();
    });
  });

  describe("complete", () => {
    it("marks feature as completed", () => {
      service.create("to-complete");
      
      service.complete("to-complete");
      
      const feature = service.get("to-complete");
      expect(feature!.status).toBe("completed");
      expect(feature!.completedAt).toBeDefined();
    });
  });

  describe("getInfo", () => {
    it("returns null for non-existing feature", () => {
      expect(service.getInfo("nope")).toBeNull();
    });

    it("returns feature info with tasks array", () => {
      service.create("info-test");
      
      const info = service.getInfo("info-test");
      
      expect(info).not.toBeNull();
      expect(info!.name).toBe("info-test");
      expect(info!.status).toBe("planning");
      expect(info!.tasks).toEqual([]);
      expect(info!.hasPlan).toBe(false);
      expect(info!.commentCount).toBe(0);
    });
  });

  describe("session management", () => {
    it("setSession stores session ID", () => {
      service.create("session-test");
      
      service.setSession("session-test", "sess_12345");
      
      const feature = service.get("session-test");
      expect(feature!.sessionId).toBe("sess_12345");
    });

    it("getSession retrieves session ID", () => {
      service.create("session-test");
      service.setSession("session-test", "sess_67890");
      
      expect(service.getSession("session-test")).toBe("sess_67890");
    });

    it("getSession returns undefined when no session", () => {
      service.create("no-session");
      
      expect(service.getSession("no-session")).toBeUndefined();
    });
  });
});
