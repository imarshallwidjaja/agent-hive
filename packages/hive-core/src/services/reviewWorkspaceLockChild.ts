import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { ReviewWorkspaceService } from './reviewWorkspaceService.js';

const [mode, projectRoot, enteredPath, releasePath, startPath, outcomePath] = process.argv.slice(2);

if (!mode || !projectRoot || !enteredPath || !releasePath || !startPath || !outcomePath) {
  throw new Error('Review workspace lock child arguments are required.');
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await fs.access(filePath);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function writeOutcome(status: 'completed' | 'error', message?: string): Promise<void> {
  await fs.writeFile(outcomePath, JSON.stringify({ status, message }), 'utf8');
}

await waitForFile(startPath);
const service = new ReviewWorkspaceService({ projectRoot });
const internal = service as unknown as {
  publishRunLock?: (...args: unknown[]) => Promise<void>;
};

if (mode === 'crash-recovery') {
  internal.publishRunLock = async () => {
    await fs.writeFile(enteredPath, 'recovery-guarded', 'utf8');
    process.kill(process.pid, 'SIGKILL');
    await new Promise(() => undefined);
  };
}

try {
  await service.withVulnerabilityMaterialization(async () => {
    if (mode === 'crash-owner') {
      await fs.writeFile(enteredPath, 'owner-entered', 'utf8');
      process.kill(process.pid, 'SIGKILL');
      await new Promise(() => undefined);
    }
    const lockMetadataPath = path.join(
      projectRoot,
      '.hive',
      '.worktrees',
      'review',
      '.locks',
      'vulnerability-materialization-boundary.lock',
      'owner.json',
    );
    const metadata = await fs.readFile(lockMetadataPath, 'utf8');
    await fs.writeFile(enteredPath, metadata, 'utf8');
    if (mode === 'hold') await waitForFile(releasePath);
  });
  await writeOutcome('completed');
} catch (error) {
  await writeOutcome('error', (error as Error).message);
  process.exitCode = 2;
}
