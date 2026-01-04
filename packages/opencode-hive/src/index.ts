import { tool, type Plugin } from "@opencode-ai/plugin";
import * as fs from "fs/promises";
import * as path from "path";

// ============================================================================
// TYPES
// ============================================================================

interface StepStatus {
  name: string;
  order: number;
  status: "pending" | "in_progress" | "done" | "blocked";
  startedAt?: string;
  completedAt?: string;
  summary?: string;
  sessionId?: string;
  sessionTitle?: string;
}

interface Feature {
  name: string;
  createdAt: string;
  status: "active" | "completed" | "archived";
}

// ============================================================================
// UTILITIES
// ============================================================================

function getHivePath(directory: string): string {
  return path.join(directory, ".hive");
}

function getFeaturePath(directory: string, featureName: string): string {
  return path.join(getHivePath(directory), "features", featureName);
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

async function getActiveFeature(directory: string): Promise<string | null> {
  const masterPath = path.join(getHivePath(directory), "active-feature.txt");
  try {
    return (await fs.readFile(masterPath, "utf-8")).trim();
  } catch {
    return null;
  }
}

async function setActiveFeature(directory: string, name: string): Promise<void> {
  const masterPath = path.join(getHivePath(directory), "active-feature.txt");
  await ensureDir(path.dirname(masterPath));
  await fs.writeFile(masterPath, name);
}

// ============================================================================
// TOOL FACTORIES
// ============================================================================

function createFeatureCreateTool(directory: string) {
  return tool({
    description: "Create a new feature in .hive/features/. Sets it as active.",
    args: {
      name: tool.schema.string().describe("Feature name (kebab-case)"),
      ticket: tool.schema.string().describe("Problem description / ticket content"),
    },
    async execute({ name, ticket }) {
      const featurePath = getFeaturePath(directory, name);
      
      await ensureDir(path.join(featurePath, "problem"));
      await ensureDir(path.join(featurePath, "context"));
      await ensureDir(path.join(featurePath, "execution"));
      
      await fs.writeFile(path.join(featurePath, "problem", "ticket.md"), ticket);
      
      const feature: Feature = {
        name,
        createdAt: new Date().toISOString(),
        status: "active",
      };
      await writeJson(path.join(featurePath, "feature.json"), feature);
      await setActiveFeature(directory, name);
      
      return `Feature "${name}" created at .hive/features/${name}/`;
    },
  });
}

function createStepCreateTool(directory: string) {
  return tool({
    description: "Create an execution step for the active feature. Creates folder with spec.md and status.json, initializes OpenCode session.",
    args: {
      name: tool.schema.string().describe("Step name (kebab-case)"),
      order: tool.schema.number().describe("Step order (1, 2, 3...)"),
      spec: tool.schema.string().describe("Step specification / requirements (markdown)"),
    },
    async execute({ name, order, spec }) {
      const featureName = await getActiveFeature(directory);
      if (!featureName) return "Error: No active feature. Use hive_feature_create first.";
      
      const stepFolder = `${String(order).padStart(2, "0")}-${name}`;
      const stepPath = path.join(
        getFeaturePath(directory, featureName),
        "execution",
        stepFolder
      );
      
      await ensureDir(stepPath);
      
      await fs.writeFile(path.join(stepPath, "spec.md"), spec);
      
      const status: StepStatus = {
        name,
        order,
        status: "pending",
      };
      
      await writeJson(path.join(stepPath, "status.json"), status);
      
      return `Step "${name}" created at execution/${stepFolder}/\nUse VSCode Hive sidebar to create a session.`;
    },
  });
}

function createStepUpdateTool(directory: string) {
  return tool({
    description: "Update step status, summary, or session info",
    args: {
      stepFolder: tool.schema.string().describe("Step folder name (e.g., 01-setup)"),
      status: tool.schema.string().optional().describe("New status: pending, in_progress, done, blocked"),
      summary: tool.schema.string().optional().describe("Completion summary"),
    },
    async execute({ stepFolder, status, summary }) {
      const featureName = await getActiveFeature(directory);
      if (!featureName) return "Error: No active feature.";
      
      const statusPath = path.join(
        getFeaturePath(directory, featureName), 
        "execution", 
        stepFolder, 
        "status.json"
      );
      const stepStatus = await readJson<StepStatus>(statusPath);
      if (!stepStatus) return `Error: Step ${stepFolder} not found.`;
      
      if (status) {
        stepStatus.status = status as StepStatus["status"];
        if (status === "in_progress" && !stepStatus.startedAt) {
          stepStatus.startedAt = new Date().toISOString();
        }
        if (status === "done") {
          stepStatus.completedAt = new Date().toISOString();
        }
      }
      if (summary) stepStatus.summary = summary;
      
      await writeJson(statusPath, stepStatus);
      return `Step "${stepStatus.name}" updated: status=${stepStatus.status}`;
    },
  });
}

function createDecisionTool(directory: string) {
  return tool({
    description: "Log an architectural decision to context/",
    args: {
      title: tool.schema.string().describe("Decision title"),
      content: tool.schema.string().describe("Decision content (markdown)"),
    },
    async execute({ title, content }) {
      const featureName = await getActiveFeature(directory);
      if (!featureName) return "Error: No active feature.";
      
      const timestamp = new Date().toISOString().split("T")[0];
      const filename = `${timestamp}-${title.toLowerCase().replace(/\s+/g, "-")}.md`;
      const decisionPath = path.join(getFeaturePath(directory, featureName), "context", filename);
      
      const fullContent = `# ${title}\n\n_Logged: ${new Date().toISOString()}_\n\n${content}`;
      await fs.writeFile(decisionPath, fullContent);
      return `Decision logged: ${filename}`;
    },
  });
}

function createReportTool(directory: string) {
  return tool({
    description: "Generate a PROBLEM/CONTEXT/EXECUTION report for the active feature",
    args: {},
    async execute() {
      const featureName = await getActiveFeature(directory);
      if (!featureName) return "Error: No active feature.";
      
      const featurePath = getFeaturePath(directory, featureName);
      
      let problem = "(no ticket)";
      try { problem = await fs.readFile(path.join(featurePath, "problem", "ticket.md"), "utf-8"); } catch {}
      
      let context = "";
      try {
        const files = await fs.readdir(path.join(featurePath, "context"));
        for (const file of files.filter(f => f.endsWith(".md"))) {
          const c = await fs.readFile(path.join(featurePath, "context", file), "utf-8");
          context += `\n### ${file}\n${c}\n`;
        }
      } catch {}
      
      let execution = "";
      try {
        const entries = await fs.readdir(path.join(featurePath, "execution"), { withFileTypes: true });
        const stepFolders = entries.filter(e => e.isDirectory()).map(e => e.name).sort();
        
        for (const folder of stepFolders) {
          const statusPath = path.join(featurePath, "execution", folder, "status.json");
          const stepStatus = await readJson<StepStatus>(statusPath);
          if (stepStatus) {
            const icon = stepStatus.status === "done" ? "✅" : stepStatus.status === "in_progress" ? "🔄" : "⬜";
            execution += `${icon} **${stepStatus.order}. ${stepStatus.name}** (${stepStatus.status})`;
            if (stepStatus.sessionId) execution += ` [session: ${stepStatus.sessionId}]`;
            execution += "\n";
            if (stepStatus.summary) execution += `   ${stepStatus.summary}\n`;
          }
        }
      } catch {}
      
      return `# Feature: ${featureName}\n\n## PROBLEM\n${problem}\n\n## CONTEXT\n${context || "(no decisions)"}\n\n## EXECUTION\n${execution || "(no steps)"}`;
    },
  });
}

// ============================================================================
// PLUGIN
// ============================================================================

const HIVE_SYSTEM_PROMPT = `
## Hive - Feature Development Tracking

You have access to hive tools for tracking feature development. Use them proactively:

### When to use hive_feature_create:
- User asks to implement a new feature
- User asks to build something new
- User describes a problem to solve
- Starting any significant development work

### Workflow:
1. **New feature request** → Call \`hive_feature_create\` with feature name and problem description
2. **Planning phase** → Call \`hive_step_create\` to break work into atomic steps
3. **During work** → Call \`hive_step_update\` to track progress
4. **Key decisions** → Call \`hive_decision\` to log architectural choices
5. **Status check** → Call \`hive_report\` to see current state

### Example:
User: "Implement OAuth2 login with Google"
You: Call hive_feature_create(name: "oauth-login", ticket: "Implement OAuth2 login flow with Google provider...")

DO NOT skip feature tracking. Every significant piece of work should be tracked in hive.
`;

const plugin: Plugin = async (ctx) => {
  const { directory } = ctx;

  return {
    "experimental.chat.system.transform": async (
      _input: unknown,
      output: { system: string[] }
    ) => {
      output.system.push(HIVE_SYSTEM_PROMPT);
    },

    tool: {
      hive_feature_create: createFeatureCreateTool(directory),
      hive_step_create: createStepCreateTool(directory),
      hive_step_update: createStepUpdateTool(directory),
      hive_decision: createDecisionTool(directory),
      hive_report: createReportTool(directory),
    },

    command: {
      hive: {
        description: "Create a new feature: /hive <feature-name>",
        async run(args: string) {
          const name = args.trim();
          if (!name) return "Usage: /hive <feature-name>";
          return `Create feature "${name}" using hive_feature_create tool. Ask for the problem description.`;
        },
      },
      plan: {
        description: "Generate execution steps for the active feature",
        async run() {
          const featureName = await getActiveFeature(directory);
          if (!featureName) return "No active feature. Use /hive <name> first.";
          
          let problem = "(no ticket)";
          try { problem = await fs.readFile(path.join(getFeaturePath(directory, featureName), "problem", "ticket.md"), "utf-8"); } catch {}
          
          return `Generate execution steps for "${featureName}".\n\nPROBLEM:\n${problem}\n\nUse hive_step_create for each step.`;
        },
      },
      done: {
        description: "Mark current step as complete",
        async run(args: string) {
          return `Mark current in_progress step as done using hive_step_update with summary: "${args.trim() || "Completed"}"`;
        },
      },
      report: {
        description: "Show feature status report",
        async run() {
          const featureName = await getActiveFeature(directory);
          if (!featureName) return "No active feature. Use /hive <name> first.";
          return `Call hive_report tool to generate the status report for feature "${featureName}".`;
        },
      },
    },
  };
};

export default plugin;
