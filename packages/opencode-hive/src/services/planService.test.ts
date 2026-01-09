import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import { PlanService } from "./planService";
import { FeatureService } from "./featureService";
import { getPlanPath, getCommentsPath } from "../utils/paths";

const TEST_ROOT = "/tmp/hive-test-plan";

describe("PlanService", () => {
  let planService: PlanService;
  let featureService: FeatureService;

  beforeEach(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    featureService = new FeatureService(TEST_ROOT);
    planService = new PlanService(TEST_ROOT);
    featureService.create("test-feature");
  });

  afterEach(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  describe("write", () => {
    it("writes plan content to file", () => {
      const content = "# My Plan\n\n## Tasks\n\n### 1. First Task";
      
      planService.write("test-feature", content);
      
      const planPath = getPlanPath(TEST_ROOT, "test-feature");
      expect(fs.readFileSync(planPath, "utf-8")).toBe(content);
    });

    it("clears existing comments when writing", () => {
      const commentsPath = getCommentsPath(TEST_ROOT, "test-feature");
      fs.writeFileSync(commentsPath, JSON.stringify({ 
        threads: [{ id: "1", line: 1, body: "test", author: "user", timestamp: new Date().toISOString() }] 
      }));
      
      planService.write("test-feature", "# New Plan");
      
      const comments = planService.getComments("test-feature");
      expect(comments).toEqual([]);
    });
  });

  describe("read", () => {
    it("returns null when no plan exists", () => {
      featureService.create("empty-feature");
      
      const result = planService.read("empty-feature");
      
      expect(result).toBeNull();
    });

    it("returns plan content and status", () => {
      const content = "# Test Plan";
      planService.write("test-feature", content);
      
      const result = planService.read("test-feature");
      
      expect(result).not.toBeNull();
      expect(result!.content).toBe(content);
      expect(result!.status).toBe("planning");
      expect(result!.comments).toEqual([]);
    });

    it("includes comments in result", () => {
      planService.write("test-feature", "# Plan");
      planService.addComment("test-feature", {
        line: 1,
        body: "Looks good!",
        author: "reviewer",
      });
      
      const result = planService.read("test-feature");
      
      expect(result!.comments.length).toBe(1);
      expect(result!.comments[0].body).toBe("Looks good!");
    });
  });

  describe("approve", () => {
    it("sets feature status to approved", () => {
      planService.write("test-feature", "# Plan");
      
      planService.approve("test-feature");
      
      const feature = featureService.get("test-feature");
      expect(feature!.status).toBe("approved");
    });

    it("read returns approved status", () => {
      planService.write("test-feature", "# Plan");
      planService.approve("test-feature");
      
      const result = planService.read("test-feature");
      
      expect(result!.status).toBe("approved");
    });
  });

  describe("comments", () => {
    it("addComment adds a comment", () => {
      planService.write("test-feature", "# Plan");
      
      planService.addComment("test-feature", {
        line: 5,
        body: "What about error handling?",
        author: "reviewer",
      });
      
      const comments = planService.getComments("test-feature");
      expect(comments.length).toBe(1);
      expect(comments[0].body).toBe("What about error handling?");
      expect(comments[0].id).toBeDefined();
      expect(comments[0].timestamp).toBeDefined();
    });

    it("getComments returns empty array when no comments", () => {
      planService.write("test-feature", "# Plan");
      
      expect(planService.getComments("test-feature")).toEqual([]);
    });

    it("clearComments removes all comments", () => {
      planService.write("test-feature", "# Plan");
      planService.addComment("test-feature", {
        line: 1,
        body: "Comment 1",
        author: "a",
      });
      planService.addComment("test-feature", {
        line: 2,
        body: "Comment 2",
        author: "b",
      });
      
      planService.clearComments("test-feature");
      
      expect(planService.getComments("test-feature")).toEqual([]);
    });

    it("getComments returns empty array for non-existing feature", () => {
      expect(planService.getComments("nope")).toEqual([]);
    });
  });
});
