import { describe, expect, it, beforeAll, afterAll, spyOn } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import {
  acquireLock,
  acquireLockSync,
  writeAtomic,
  writeAtomicDurable,
  writeJsonAtomic,
  writeJsonLocked,
  writeJsonLockedSync,
  patchJsonLocked,
  patchJsonLockedSync,
  deepMerge,
  getLockPath,
  readJson,
  normalizePath,
  getGlobalSessionsPath,
  getHivePath,
  getProjectContextPath,
  getFeaturePath,
  LegacyLockError,
  probeLock,
} from "./paths";
import { isNativeLockHeld, resolveLockAnchor, windowsBackend } from "./nativeLock";
import {
  NATIVE_OBSERVATION_OWNERS,
  getNativeBackgroundJobsPath,
  getNativeFeatureSessionsPath,
  getNativeSessionsPath,
  isNativeObservationOwner,
} from "../native-observations";

const TEST_DIR = "/tmp/hive-core-test-" + process.pid;

function cleanup() {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true });
  }
}

describe("Atomic + Locked JSON Utilities", () => {
  beforeAll(() => {
    cleanup();
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterAll(() => {
    cleanup();
  });

  describe("acquireLock", () => {
    it("serializes acquirers in one process and keeps a stable anchor after release", async () => {
      const filePath = path.join(TEST_DIR, "lock-blocking.json");
      const order: string[] = [];

      const release1 = await acquireLock(filePath);
      order.push("lock1-acquired");
      const anchorPath = resolveLockAnchor(filePath).anchorPath;
      const anchorInode = fs.statSync(anchorPath).ino;

      const lock2Promise = acquireLock(filePath, { timeout: 1000 }).then((release) => {
        order.push("lock2-acquired");
        return release;
      });
      await new Promise((r) => setTimeout(r, 100));
      release1();
      order.push("lock1-released");
      const release2 = await lock2Promise;
      release2();
      order.push("lock2-released");

      expect(order).toEqual(["lock1-acquired", "lock1-released", "lock2-acquired", "lock2-released"]);
      expect(fs.existsSync(getLockPath(filePath))).toBe(false);
      expect(fs.statSync(anchorPath).ino).toBe(anchorInode);
    });

    it("times out while a live owner holds the lock and names the recorded holder", async () => {
      const filePath = path.join(TEST_DIR, "lock-timeout.json");
      const release = await acquireLock(filePath);
      try {
        await expect(acquireLock(filePath, { timeout: 100, retryInterval: 10 }))
          .rejects.toThrow(new RegExp(`Failed to acquire lock .*recorded holder pid ${process.pid}`));
      } finally {
        release();
      }
    });

    it("never ignores a legacy exclusive-create lock file and leaves it in place", async () => {
      const filePath = path.join(TEST_DIR, "lock-legacy.json");
      const lockPath = getLockPath(filePath);
      fs.writeFileSync(lockPath, JSON.stringify({ pid: 99999, timestamp: '2026-09-17T01:00:00.000Z' }));
      const pastTime = new Date(Date.now() - 60000);
      fs.utimesSync(lockPath, pastTime, pastTime);

      const failure = await acquireLock(filePath, { timeout: 50, retryInterval: 5, staleLockTTL: 1000 }).catch((error) => error);
      expect(failure).toBeInstanceOf(LegacyLockError);
      expect(failure.message).toContain('holder pid 99999');
      expect(failure.message).toContain('2026-09-17T01:00:00.000Z');
      expect(fs.existsSync(lockPath)).toBe(true);
      expect(probeLock(filePath)).toBe('legacy');
      // Waiting released the native lock again; the legacy owner still decides.
      expect(isNativeLockHeld(resolveLockAnchor(filePath))).toBe(false);
    });
  });

  describe("acquireLockSync", () => {
    it("times out synchronously when lock held", () => {
      const filePath = path.join(TEST_DIR, "lock-sync-timeout.json");
      const release = acquireLockSync(filePath);
      try {
        expect(() => acquireLockSync(filePath, { timeout: 100, retryInterval: 10 })).toThrow(/Failed to acquire lock/);
      } finally {
        release();
      }
      acquireLockSync(filePath, { timeout: 0 })();
    });

    it("anchors .hive resources outside deletable task directories", () => {
      const taskPath = path.join(TEST_DIR, "project", ".hive", "features", "01_f", "tasks", "01-t");
      const statusPath = path.join(taskPath, "status.json");
      const release = acquireLockSync(statusPath);
      try {
        const anchor = resolveLockAnchor(statusPath);
        expect(path.dirname(anchor.anchorPath)).toBe(path.join(fs.realpathSync(TEST_DIR), "project", ".hive", ".locks"));
        fs.rmSync(taskPath, { recursive: true, force: true });
        expect(() => acquireLockSync(statusPath, { timeout: 0 })).toThrow(/Failed to acquire lock/);
      } finally {
        release();
      }
      expect(probeLock(statusPath)).toBe('free');
    });

    it("keeps excluding contenders when an atomic write replaces a locked leaf symlink", () => {
      const realDirectory = path.join(TEST_DIR, "leaf-link-real");
      const linkDirectory = path.join(TEST_DIR, "leaf-link-config");
      fs.mkdirSync(realDirectory, { recursive: true });
      fs.mkdirSync(linkDirectory, { recursive: true });
      fs.writeFileSync(path.join(realDirectory, "agent_hive.json"), "{}");
      const configPath = path.join(linkDirectory, "agent_hive.json");
      fs.symlinkSync(path.join(realDirectory, "agent_hive.json"), configPath);

      const release = acquireLockSync(configPath);
      try {
        // The configuration write renames over the logical name, turning the link into a regular file.
        writeAtomic(configPath, '{"replaced":true}');
        expect(fs.lstatSync(configPath).isSymbolicLink()).toBe(false);
        expect(probeLock(configPath)).toBe('held');
        expect(() => acquireLockSync(configPath, { timeout: 0 })).toThrow(/Failed to acquire lock/);
      } finally {
        release();
      }
      expect(probeLock(configPath)).toBe('free');
    });

    it("gives a resource reached through a symlinked parent directory the same anchor", () => {
      const realDirectory = path.join(TEST_DIR, "parent-alias-real");
      const aliasDirectory = path.join(TEST_DIR, "parent-alias-link");
      fs.mkdirSync(realDirectory, { recursive: true });
      fs.symlinkSync(realDirectory, aliasDirectory);
      const viaAlias = path.join(aliasDirectory, "state.json");
      expect(resolveLockAnchor(viaAlias).anchorPath).toBe(resolveLockAnchor(path.join(realDirectory, "state.json")).anchorPath);
      const release = acquireLockSync(viaAlias);
      try {
        expect(() => acquireLockSync(path.join(realDirectory, "state.json"), { timeout: 0 })).toThrow(/Failed to acquire lock/);
      } finally {
        release();
      }
    });

    it("diagnostic opens and a repeated release never drop the successor's lock", () => {
      const filePath = path.join(TEST_DIR, "lock-successor.json");
      const releaseFirst = acquireLockSync(filePath);
      releaseFirst();
      const releaseSecond = acquireLockSync(filePath);
      try {
        releaseFirst();
        const anchorPath = resolveLockAnchor(filePath).anchorPath;
        fs.closeSync(fs.openSync(anchorPath, 'r'));
        expect(JSON.parse(fs.readFileSync(anchorPath, 'utf8'))).toMatchObject({ protocol: 'hive-native-lock/v1', pid: process.pid });
        expect(probeLock(filePath)).toBe('held');
        expect(() => acquireLockSync(filePath, { timeout: 0 })).toThrow(/Failed to acquire lock/);
      } finally {
        releaseSecond();
      }
      expect(probeLock(filePath)).toBe('free');
    });

    it("releases native ownership when the diagnostic record cannot be written", () => {
      const filePath = path.join(TEST_DIR, "lock-diagnostic-failure.json");
      const truncateSpy = spyOn(fs, "ftruncateSync").mockImplementation((() => {
        throw Object.assign(new Error("diagnostic write failed"), { code: "EIO" });
      }) as typeof fs.ftruncateSync);
      try {
        expect(() => acquireLockSync(filePath)).toThrow(/diagnostic write failed/);
      } finally {
        truncateSpy.mockRestore();
      }
      expect(probeLock(filePath)).toBe('free');
    });

    it("fails closed when the anchor cannot carry a native lock", () => {
      const filePath = path.join(TEST_DIR, "lock-anchor-directory.json");
      fs.mkdirSync(resolveLockAnchor(filePath).anchorPath, { recursive: true });
      expect(() => acquireLockSync(filePath, { timeout: 0 })).toThrow(/EISDIR|not a regular file/);
      expect(() => probeLock(filePath)).toThrow(/EISDIR|not a regular file/);
    });

    it("reports a failed native release instead of treating it as clean", () => {
      const filePath = path.join(TEST_DIR, "lock-release-failure.json");
      const release = acquireLockSync(filePath);
      const originalClose = fs.closeSync;
      const closeSpy = spyOn(fs, "closeSync").mockImplementationOnce(((descriptor: number) => {
        originalClose(descriptor);
        throw Object.assign(new Error("close failed"), { code: "EIO" });
      }) as typeof fs.closeSync);
      try {
        expect(() => release()).toThrow(/close failed/);
      } finally {
        closeSpy.mockRestore();
      }
      expect(probeLock(filePath)).toBe('free');
    });
  });

  // Linux cannot load kernel32, so these drive the Windows backend through a stand-in for Koffi's kernel32 calls.
  // They pin how Windows error codes are classified, not Windows runtime behavior.
  describe("Windows backend error classification", () => {
    function backendFailingOpenWith(lastError: number) {
      const calls: string[] = [];
      const functions: Record<string, (...args: unknown[]) => unknown> = {
        CreateFileW: () => { calls.push("CreateFileW"); return -1; },
        GetLastError: () => lastError,
      };
      const koffi = {
        load: () => ({ func: (signature: string) => functions[/(\w+)\(/.exec(signature)![1]!] ?? (() => { throw new Error(`unexpected call: ${signature}`); }) }),
        struct: () => undefined,
      };
      return { backend: windowsBackend(koffi as never), calls };
    }

    it("reports an anchor as free when the file or its parent directory is missing", () => {
      for (const missing of [2, 3]) {
        const { backend, calls } = backendFailingOpenWith(missing);
        expect(backend.isLocked("C:\\project\\.hive\\.locks\\absent.lock")).toBe(false);
        expect(calls).toEqual(["CreateFileW"]);
      }
    });

    it("fails closed for other open errors and whenever acquisition cannot open the anchor", () => {
      expect(() => backendFailingOpenWith(5).backend.isLocked("C:\\anchor.lock")).toThrow(/Windows error 5/);
      expect(() => backendFailingOpenWith(3).backend.tryLock("C:\\anchor.lock")).toThrow(/Windows error 3/);
    });
  });

  describe("crash release across processes", () => {
    const bunExecutable = process.execPath;
    const nodeExecutable = Bun.which("node");
    let nodeHelperPath: string;

    beforeAll(async () => {
      // Node runs the product helpers from a bundle of this source; Koffi resolves from this installation.
      const output = await Bun.build({
        entrypoints: [path.join(import.meta.dir, "paths.ts")],
        outdir: path.join(TEST_DIR, "node-helper"),
        target: "node",
        format: "esm",
        external: ["koffi"],
        define: { __HIVE_KOFFI_MODULE__: JSON.stringify(require.resolve("koffi")) },
      });
      if (!output.success) throw new AggregateError(output.logs, "node helper bundle failed");
      nodeHelperPath = output.outputs[0]!.path;
    });

    const ownerScript = (helper: string, filePath: string) => `
      const { acquireLockSync } = await import(${JSON.stringify(helper)});
      acquireLockSync(${JSON.stringify(filePath)});
      process.stdout.write("locked\\n");
      setInterval(() => {}, 1000);
    `;
    const contenderScript = (helper: string, filePath: string) => `
      const { acquireLockSync } = await import(${JSON.stringify(helper)});
      try { acquireLockSync(${JSON.stringify(filePath)}, { timeout: 0 })(); process.stdout.write("acquired"); }
      catch (error) { process.stdout.write("refused: " + error.message); process.exitCode = 3; }
    `;

    async function startOwner(executable: string, args: string[]) {
      const child = Bun.spawn([executable, ...args], { stdout: "pipe", stderr: "pipe" });
      const reader = child.stdout.getReader();
      const { value } = await reader.read();
      expect(new TextDecoder().decode(value)).toContain("locked");
      return child;
    }

    function runContender(executable: string, args: string[]) {
      const result = Bun.spawnSync([executable, ...args], { stdout: "pipe", stderr: "pipe" });
      return { exitCode: result.exitCode, output: `${result.stdout.toString()}${result.stderr.toString()}` };
    }

    it("a SIGKILLed Node owner's lock is acquired by Bun without filesystem cleanup", async () => {
      expect(nodeExecutable).toBeTruthy();
      const filePath = path.join(TEST_DIR, "project", ".hive", "crash-node.json");
      const owner = await startOwner(nodeExecutable!, ["--input-type=module", "-e", ownerScript(nodeHelperPath, filePath)]);
      try {
        const anchorInode = fs.statSync(resolveLockAnchor(filePath).anchorPath).ino;
        expect(probeLock(filePath)).toBe('held');
        expect(() => acquireLockSync(filePath, { timeout: 0 })).toThrow(new RegExp(`recorded holder pid ${owner.pid}`));
        owner.kill("SIGKILL");
        expect(await owner.exited).not.toBe(0);
        const release = acquireLockSync(filePath, { timeout: 1000 });
        expect(fs.statSync(resolveLockAnchor(filePath).anchorPath).ino).toBe(anchorInode);
        release();
      } finally {
        owner.kill("SIGKILL");
      }
    });

    it("a SIGKILLed Bun owner's lock is acquired by a fresh Node process", async () => {
      expect(nodeExecutable).toBeTruthy();
      const filePath = path.join(TEST_DIR, "project", ".hive", "crash-bun.json");
      const ownerFile = path.join(TEST_DIR, "bun-owner.ts");
      fs.writeFileSync(ownerFile, ownerScript(path.join(import.meta.dir, "paths.ts"), filePath));
      const owner = await startOwner(bunExecutable, [ownerFile]);
      try {
        const nodeContender = ["--input-type=module", "-e", contenderScript(nodeHelperPath, filePath)];
        const refused = runContender(nodeExecutable!, nodeContender);
        expect(refused.exitCode).toBe(3);
        expect(refused.output).toContain(`recorded holder pid ${owner.pid}`);
        owner.kill("SIGKILL");
        await owner.exited;
        expect(runContender(nodeExecutable!, nodeContender)).toEqual({ exitCode: 0, output: "acquired" });
      } finally {
        owner.kill("SIGKILL");
      }
    });

    it("a child process started while the lock is held does not inherit it", async () => {
      const filePath = path.join(TEST_DIR, "project", ".hive", "inherit.json");
      const release = acquireLockSync(filePath);
      const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
      try {
        release();
        expect(probeLock(filePath)).toBe('free');
      } finally {
        child.kill("SIGKILL");
        await child.exited;
      }
    });
  });

  describe("writeAtomic", () => {
    it("writes file atomically via temp+rename", () => {
      const filePath = path.join(TEST_DIR, "atomic.txt");

      writeAtomic(filePath, "hello world");

      expect(fs.readFileSync(filePath, "utf-8")).toBe("hello world");
    });

    it("creates parent directories", () => {
      const filePath = path.join(TEST_DIR, "nested", "dir", "atomic.txt");

      writeAtomic(filePath, "nested content");

      expect(fs.readFileSync(filePath, "utf-8")).toBe("nested content");
    });

    it("cleans up temp file when rename fails", () => {
      const filePath = path.join(TEST_DIR, "cleanup", "fail.txt");
      const tempPath = `${filePath}.tmp.${process.pid}.12345`;
      const dateSpy = spyOn(Date, "now").mockReturnValue(12345);
      const renameSpy = spyOn(fs, "renameSync").mockImplementation(
        ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
          expect(String(oldPath)).toBe(tempPath);
          expect(String(newPath)).toBe(filePath);
          const err = new Error("rename failed") as NodeJS.ErrnoException;
          err.code = "EACCES";
          throw err;
        }) as typeof fs.renameSync
      );

      try {
        expect(() => writeAtomic(filePath, "should fail")).toThrow(/rename failed/);
      } finally {
        renameSpy.mockRestore();
        dateSpy.mockRestore();
      }

      expect(fs.existsSync(tempPath)).toBe(false);
      expect(fs.existsSync(filePath)).toBe(false);
    });
  });

  describe("writeAtomicDurable", () => {
    it("flushes the temporary file before rename and the containing directory after rename", () => {
      const filePath = path.join(TEST_DIR, "durable", "atomic.txt");
      const directory = path.dirname(filePath);
      const descriptorPaths = new Map<number, string>();
      const events: string[] = [];
      const originalOpen = fs.openSync;
      const originalFsync = fs.fsyncSync;
      const originalRename = fs.renameSync;
      const openSpy = spyOn(fs, "openSync").mockImplementation(((target, flags, mode) => {
        const descriptor = originalOpen(target, flags, mode);
        descriptorPaths.set(descriptor, String(target));
        return descriptor;
      }) as typeof fs.openSync);
      const fsyncSpy = spyOn(fs, "fsyncSync").mockImplementation((descriptor => {
        events.push(`fsync:${descriptorPaths.get(descriptor)}`);
        originalFsync(descriptor);
      }) as typeof fs.fsyncSync);
      const renameSpy = spyOn(fs, "renameSync").mockImplementation(((source, destination) => {
        events.push(`rename:${String(destination)}`);
        originalRename(source, destination);
      }) as typeof fs.renameSync);

      try {
        writeAtomicDurable(filePath, "durable content");
      } finally {
        renameSpy.mockRestore();
        fsyncSpy.mockRestore();
        openSpy.mockRestore();
      }

      expect(fs.readFileSync(filePath, "utf-8")).toBe("durable content");
      const renameIndex = events.indexOf(`rename:${filePath}`);
      const tempSyncIndex = events.findIndex(event => event.startsWith(`fsync:${filePath}.tmp.`));
      expect(tempSyncIndex).toBeGreaterThanOrEqual(0);
      expect(renameIndex).toBeGreaterThanOrEqual(0);
      expect(tempSyncIndex).toBeLessThan(renameIndex);
      if (process.platform !== "win32") {
        const directorySyncIndex = events.indexOf(`fsync:${directory}`);
        expect(directorySyncIndex).toBeGreaterThanOrEqual(0);
        expect(directorySyncIndex).toBeGreaterThan(renameIndex);
      }
    });
  });

  describe("writeJsonAtomic", () => {
    it("writes JSON atomically with formatting", () => {
      const filePath = path.join(TEST_DIR, "data.json");
      const data = { foo: "bar", num: 42 };

      writeJsonAtomic(filePath, data);

      const content = fs.readFileSync(filePath, "utf-8");
      expect(JSON.parse(content)).toEqual(data);
      expect(content).toContain("\n"); // Formatted
    });
  });

  describe("writeJsonLocked", () => {
    it("writes JSON with lock protection", async () => {
      const filePath = path.join(TEST_DIR, "locked.json");
      const data = { key: "value" };

      await writeJsonLocked(filePath, data);

      expect(readJson<typeof data>(filePath)).toEqual(data);
      expect(fs.existsSync(getLockPath(filePath))).toBe(false);
    });

    it("serializes concurrent writes", async () => {
      const filePath = path.join(TEST_DIR, "concurrent.json");
      const writes: number[] = [];

      // Start multiple concurrent writes
      const promises = [1, 2, 3, 4, 5].map(async (n) => {
        await writeJsonLocked(filePath, { value: n });
        writes.push(n);
      });

      await Promise.all(promises);

      // All writes completed
      expect(writes).toHaveLength(5);

      // File has valid JSON (last writer wins)
      const final = readJson<{ value: number }>(filePath);
      expect(final?.value).toBeGreaterThanOrEqual(1);
      expect(final?.value).toBeLessThanOrEqual(5);
    });
  });

  describe("writeJsonLockedSync", () => {
    it("writes JSON with lock protection synchronously", () => {
      const filePath = path.join(TEST_DIR, "locked-sync.json");
      const data = { sync: true };

      writeJsonLockedSync(filePath, data);

      expect(readJson<typeof data>(filePath)).toEqual(data);
      expect(fs.existsSync(getLockPath(filePath))).toBe(false);
    });

    it("creates parent directories before lock acquisition", () => {
      const filePath = path.join(TEST_DIR, "nested", "deep", "locked-sync.json");
      const data = { nested: true };

      writeJsonLockedSync(filePath, data);

      expect(readJson<typeof data>(filePath)).toEqual(data);
      expect(fs.existsSync(getLockPath(filePath))).toBe(false);
    });
  });

  describe("ENOENT lock retries", () => {
    it("retries acquireLockSync when lock create gets transient ENOENT", () => {
      const filePath = path.join(TEST_DIR, "retry-lock.json");
      const lockPath = getLockPath(filePath);
      const originalOpenSync = fs.openSync.bind(fs);
      let firstAttempt = true;
      const openSpy = spyOn(fs, "openSync").mockImplementation(((targetPath: fs.PathLike, flags: number, mode?: fs.Mode) => {
        if (String(targetPath) === lockPath && firstAttempt) {
          firstAttempt = false;
          const err = new Error("Transient ENOENT") as NodeJS.ErrnoException;
          err.code = "ENOENT";
          throw err;
        }
        return originalOpenSync(targetPath, flags, mode);
      }) as typeof fs.openSync);

      try {
        const release = acquireLockSync(filePath, { timeout: 200, retryInterval: 1 });
        release();
      } finally {
        openSpy.mockRestore();
      }
    });
  });

  describe("deepMerge", () => {
    it("merges top-level fields", () => {
      const target: Record<string, unknown> = { a: 1, b: 2 };
      const patch: Record<string, unknown> = { b: 3, c: 4 };

      const result = deepMerge(target, patch);

      expect(result).toEqual({ a: 1, b: 3, c: 4 });
    });

    it("deep merges nested objects", () => {
      const target: Record<string, unknown> = {
        outer: { inner1: "a", inner2: "b" },
        other: "x",
      };
      const patch: Record<string, unknown> = {
        outer: { inner2: "c", inner3: "d" },
      };

      const result = deepMerge(target, patch);

      expect(result).toEqual({
        outer: { inner1: "a", inner2: "c", inner3: "d" },
        other: "x",
      });
    });

    it("replaces arrays (no merge)", () => {
      const target: Record<string, unknown> = { arr: [1, 2, 3] };
      const patch: Record<string, unknown> = { arr: [4, 5] };

      const result = deepMerge(target, patch);

      expect(result).toEqual({ arr: [4, 5] });
    });

    it("ignores undefined values in patch", () => {
      const target: Record<string, unknown> = { a: 1, b: 2 };
      const patch: Record<string, unknown> = { a: undefined, c: 3 };

      const result = deepMerge(target, patch);

      expect(result).toEqual({ a: 1, b: 2, c: 3 });
    });

    it("allows null to overwrite", () => {
      const target: Record<string, unknown> = { a: { nested: true } };
      const patch: Record<string, unknown> = { a: null };

      const result = deepMerge(target, patch);

      expect(result).toEqual({ a: null });
    });

    it("handles deeply nested objects", () => {
      const target: Record<string, unknown> = {
        level1: {
          level2: {
            level3: { keep: true, update: "old" },
          },
        },
      };
      const patch: Record<string, unknown> = {
        level1: {
          level2: {
            level3: { update: "new", add: true },
          },
        },
      };

      const result = deepMerge(target, patch);

      expect(result).toEqual({
        level1: {
          level2: {
            level3: { keep: true, update: "new", add: true },
          },
        },
      });
    });
  });

  describe("patchJsonLocked", () => {
    it("patches existing JSON file", async () => {
      const filePath = path.join(TEST_DIR, "patch.json");
      fs.writeFileSync(filePath, JSON.stringify({ a: 1, b: 2 }));

      const result = await patchJsonLocked<{ a: number; b: number; c?: number }>(
        filePath,
        { b: 3, c: 4 }
      );

      expect(result).toEqual({ a: 1, b: 3, c: 4 });
      expect(readJson<typeof result>(filePath)).toEqual({ a: 1, b: 3, c: 4 });
    });

    it("creates file if not exists", async () => {
      const filePath = path.join(TEST_DIR, "new-patch.json");

      const result = await patchJsonLocked<{ x: number }>(filePath, { x: 1 });

      expect(result).toEqual({ x: 1 });
    });

    it("deep merges nested objects in patch", async () => {
      const filePath = path.join(TEST_DIR, "nested-patch.json");
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          status: "pending",
          metadata: { owner: "abc", attempt: 1 },
        })
      );

      await patchJsonLocked(filePath, {
        metadata: { updatedAt: "2025-01-01T00:00:00Z" },
      });

      const result = readJson<Record<string, unknown>>(filePath);
      expect(result).toEqual({
        status: "pending",
        metadata: {
          owner: "abc",
          attempt: 1,
          updatedAt: "2025-01-01T00:00:00Z",
        },
      });
    });
  });

  describe("patchJsonLockedSync", () => {
    it("patches synchronously", () => {
      const filePath = path.join(TEST_DIR, "patch-sync.json");
      fs.writeFileSync(filePath, JSON.stringify({ x: 1 }));

      const result = patchJsonLockedSync<{ x: number; y?: number }>(filePath, {
        y: 2,
      });

      expect(result).toEqual({ x: 1, y: 2 });
    });
  });

  describe("normalizePath", () => {
    it("converts Windows backslashes to forward slashes", () => {
      expect(normalizePath("C:\\Users\\test\\project")).toBe("C:/Users/test/project");
    });

    it("leaves Unix paths unchanged", () => {
      expect(normalizePath("/home/user/project")).toBe("/home/user/project");
    });
  });

  describe("getGlobalSessionsPath", () => {
    it("returns .hive/sessions.json under project root", () => {
      const result = getGlobalSessionsPath("/my/project");
      expect(result).toBe(path.join("/my/project", ".hive", "sessions.json"));
    });

    it("is consistent with getHivePath", () => {
      const hivePath = getHivePath("/my/project");
      const sessionsPath = getGlobalSessionsPath("/my/project");
      expect(sessionsPath).toBe(path.join(hivePath, "sessions.json"));
    });
  });

  describe("getProjectContextPath", () => {
    it("returns the project-level context namespace", () => {
      expect(getProjectContextPath("/my/project")).toBe(path.join("/my/project", ".hive", "context"));
    });
  });
});

describe("native observation paths", () => {
  const root = "/my/project";

  it("offers a closed set of owners and rejects everything else", () => {
    expect([...NATIVE_OBSERVATION_OWNERS]).toEqual(["opencode-v1", "opencode-v2"]);
    expect(isNativeObservationOwner("opencode-v2")).toBe(true);
    for (const value of ["", "OpenCode-v1", "../escape", "opencode-v3", undefined, null, 2]) {
      expect(isNativeObservationOwner(value)).toBe(false);
    }
    expect(() => getNativeSessionsPath(root, "../escape" as never)).toThrow("Unknown native observation owner");
    expect(() => getNativeBackgroundJobsPath(root, "" as never)).toThrow("Unknown native observation owner");
    expect(() => getNativeFeatureSessionsPath(root, "feature", "x" as never)).toThrow("Unknown native observation owner");
  });

  it("keeps the long-standing v1 locations", () => {
    expect(getNativeSessionsPath(root, "opencode-v1")).toBe(getGlobalSessionsPath(root));
    expect(getNativeBackgroundJobsPath(root, "opencode-v1")).toBe(path.join(root, ".hive", "background-jobs.json"));
  });

  it("nests v2 stores under their own runtime directory", () => {
    expect(getNativeSessionsPath(root, "opencode-v2")).toBe(path.join(root, ".hive", "runtime", "opencode-v2", "sessions.json"));
    expect(getNativeBackgroundJobsPath(root, "opencode-v2")).toBe(path.join(root, ".hive", "runtime", "opencode-v2", "background-jobs.json"));
  });

  it("derives feature projections from the resolved feature directory, including indexed prefixes", () => {
    const projectRoot = path.join(TEST_DIR, "native-paths");
    fs.mkdirSync(path.join(projectRoot, ".hive", "features", "07_indexed"), { recursive: true });
    const featurePath = getFeaturePath(projectRoot, "indexed");
    expect(featurePath).toBe(path.join(projectRoot, ".hive", "features", "07_indexed"));
    expect(getNativeFeatureSessionsPath(projectRoot, "indexed", "opencode-v1")).toBe(path.join(featurePath, "sessions.json"));
    expect(getNativeFeatureSessionsPath(projectRoot, "indexed", "opencode-v2")).toBe(path.join(featurePath, "runtime", "opencode-v2", "sessions.json"));
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });
});
