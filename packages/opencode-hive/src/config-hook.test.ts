import { describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { PluginInput } from "@opencode-ai/plugin";
import plugin from "./index";

function createStubShell(): PluginInput["$"] {
  let shell: PluginInput["$"];

  const fn = ((..._args: unknown[]) => {
    throw new Error("shell not available in this test");
  }) as unknown as PluginInput["$"];

  shell = Object.assign(fn, {
    braces(pattern: string) {
      return [pattern];
    },
    escape(input: string) {
      return input;
    },
    env() {
      return shell;
    },
    cwd() {
      return shell;
    },
    nothrow() {
      return shell;
    },
    throws() {
      return shell;
    },
  });

  return shell;
}

function createProject(worktree: string): PluginInput["project"] {
  return {
    id: "test",
    worktree,
    time: { created: Date.now() },
  };
}

describe("opencode-hive config hook", () => {
  it("applies configured model variants", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "hive-config-"));
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "hive-project-"));
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;

    process.env.HOME = tempHome;
    delete process.env.USERPROFILE;

    try {
      const configDir = path.join(tempHome, ".config", "opencode");
      fs.mkdirSync(configDir, { recursive: true });
      const configPath = path.join(configDir, "agent_hive.json");

      const config = {
        agents: {
          hive: {
            model: "anthropic/claude",
            variant: "reasoning",
          },
          forager: {
            model: "anthropic/claude:existing",
            variant: "fast",
          },
        },
      };

      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

      const ctx: PluginInput = {
        directory: projectDir,
        worktree: projectDir,
        serverUrl: new URL("http://localhost:1"),
        project: createProject(projectDir),
        client: {} as PluginInput["client"],
        $: createStubShell(),
      };

      const hooks = await plugin(ctx);
      const opencodeConfig: Record<string, unknown> = {};
      await hooks.config?.(opencodeConfig);

      const agentConfig = opencodeConfig.agent as Record<string, { model?: string }>;
      expect(agentConfig.hive.model).toBe("anthropic/claude:reasoning");
      expect(agentConfig.forager.model).toBe("anthropic/claude:existing");
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
      fs.rmSync(projectDir, { recursive: true, force: true });

      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }

      if (previousUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = previousUserProfile;
      }
    }
  });
});
