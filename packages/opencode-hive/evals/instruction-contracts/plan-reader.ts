// Read-only comparison reader over the candidate's own hive-core bundle (/opt/ic/exercise-core/index.js, the same
// build as the installed plugin). It exposes exactly one operation, a full plan read through the public path and
// PlanService APIs, so a supervisor's approval decision rests on the candidate's own revision rules rather than a copy
// of them. It never writes and has no output sink of its own: exercise-driver.ts returns its result through the
// scanned evidence boundary. Runs only inside an exercise container (Node type stripping).
//
// The public read touches more than plan.md: it resolves the feature directory (listing every feature's feature.json
// when the name is not a directory name), reads the canonical review comments or the legacy comments file, and tests
// the approval marker. All of those inputs are checked here, before the core opens any of them.
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const CORE_BUNDLE = '/opt/ic/exercise-core/index.js';
export const PLAN_READ_LIMITS = Object.freeze({ planBytes: 256 * 1024, commentsBytes: 256 * 1024, metadataBytes: 64 * 1024, markerBytes: 4 * 1024, featureDirectories: 512 });
const FEATURE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

type Json = any;
type Core = { getFeaturePath: (root: string, feature: string) => string; getPlanPath: (root: string, feature: string) => string; PlanService: new (root: string) => { read: (feature: string, options: { mode: 'full' }) => Json } };

export type PlanReadFailure =
  | 'feature_name_invalid' | 'core_unavailable' | 'feature_path_escapes' | 'plan_not_regular' | 'plan_oversize' | 'plan_missing'
  | 'plan_input_rejected' | 'plan_input_oversize' | 'plan_read_failed';

export type PlanReadOutcome =
  | { ok: true; featurePath: string; planPath: string; result: Json }
  | { ok: false; failure: PlanReadFailure };

function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep) && !rel.split(sep).includes('..');
}

/** One optional input file: absent, acceptable, or refused (link, device, hardlink, other type) or oversize. */
function inputFile(path: string, maxBytes: number): 'absent' | 'ok' | 'rejected' | 'oversize' {
  let stat;
  try { stat = lstatSync(path); } catch (error) { return (error as Json)?.code === 'ENOENT' || (error as Json)?.code === 'ENOTDIR' ? 'absent' : 'rejected'; }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) return 'rejected';
  return stat.size > maxBytes ? 'oversize' : 'ok';
}

function realDirectory(path: string, within: string): 'absent' | 'ok' | 'escapes' {
  let stat;
  try { stat = lstatSync(path); } catch (error) { return (error as Json)?.code === 'ENOENT' ? 'absent' : 'escapes'; }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return 'escapes';
  try { return contained(within, realpathSync(path)) ? 'ok' : 'escapes'; } catch { return 'escapes'; }
}

/**
 * Full plan read for one feature of the disposable project. The `.hive` and `.hive/features` ancestors must be real
 * directories inside the project; every feature.json the core may list is a bounded regular file; the resolved
 * feature directory is a real child of `.hive/features`; and plan.md, the canonical and legacy review comments and the
 * approval marker are bounded regular files, before the core reads any of them. `load` is injectable so tests can
 * supply a core module without a container.
 */
export async function readPlan(projectRoot: string, feature: string, load: () => Promise<Core> = () => import(CORE_BUNDLE)): Promise<PlanReadOutcome> {
  if (typeof feature !== 'string' || !FEATURE_NAME.test(feature)) return { ok: false, failure: 'feature_name_invalid' };
  let core: Core;
  try {
    core = await load();
    if (typeof core.getFeaturePath !== 'function' || typeof core.getPlanPath !== 'function' || typeof core.PlanService !== 'function') return { ok: false, failure: 'core_unavailable' };
  } catch {
    return { ok: false, failure: 'core_unavailable' };
  }
  try {
    const realRoot = realpathSync(projectRoot);
    const hiveDir = join(projectRoot, '.hive');
    const featuresDir = join(hiveDir, 'features');
    const hive = realDirectory(hiveDir, realRoot);
    if (hive === 'absent') return { ok: false, failure: 'plan_missing' };
    if (hive !== 'ok') return { ok: false, failure: 'feature_path_escapes' };
    const features = realDirectory(featuresDir, realRoot);
    if (features === 'absent') return { ok: false, failure: 'plan_missing' };
    if (features !== 'ok') return { ok: false, failure: 'feature_path_escapes' };
    const realFeatures = realpathSync(featuresDir);

    // The core lists every feature directory's feature.json when the name is not itself a directory.
    const entries = readdirSync(featuresDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    if (entries.length > PLAN_READ_LIMITS.featureDirectories) return { ok: false, failure: 'plan_input_oversize' };
    for (const entry of entries) {
      const metadata = inputFile(join(featuresDir, entry.name, 'feature.json'), PLAN_READ_LIMITS.metadataBytes);
      if (metadata === 'rejected') return { ok: false, failure: 'plan_input_rejected' };
      if (metadata === 'oversize') return { ok: false, failure: 'plan_input_oversize' };
    }

    const featurePath = core.getFeaturePath(projectRoot, feature);
    const rel = relative(featuresDir, featurePath);
    if (rel === '' || rel.startsWith('..') || rel.includes(sep)) return { ok: false, failure: 'feature_path_escapes' };
    const directory = realDirectory(featurePath, realFeatures);
    if (directory === 'absent') return { ok: false, failure: 'plan_missing' };
    if (directory !== 'ok') return { ok: false, failure: 'feature_path_escapes' };
    const realFeature = realpathSync(featurePath);

    const planPath = core.getPlanPath(projectRoot, feature);
    if (planPath !== join(featurePath, 'plan.md')) return { ok: false, failure: 'feature_path_escapes' };
    const plan = inputFile(planPath, PLAN_READ_LIMITS.planBytes);
    if (plan === 'absent') return { ok: false, failure: 'plan_missing' };
    if (plan === 'rejected') return { ok: false, failure: 'plan_not_regular' };
    if (plan === 'oversize') return { ok: false, failure: 'plan_oversize' };
    if (!contained(realFeature, realpathSync(planPath))) return { ok: false, failure: 'feature_path_escapes' };

    const commentsDir = join(featurePath, 'comments');
    // A comments entry that is not a real directory inside the feature (a link or a file) is refused, not left to the core.
    if (realDirectory(commentsDir, realFeature) === 'escapes') return { ok: false, failure: 'plan_input_rejected' };
    const checks: [string, number][] = [
      [join(commentsDir, 'plan.json'), PLAN_READ_LIMITS.commentsBytes],
      [join(featurePath, 'comments.json'), PLAN_READ_LIMITS.commentsBytes],
      [join(featurePath, 'feature.json'), PLAN_READ_LIMITS.metadataBytes],
      [join(featurePath, 'APPROVED'), PLAN_READ_LIMITS.markerBytes],
    ];
    for (const [path, max] of checks) {
      const state = inputFile(path, max);
      if (state === 'rejected') return { ok: false, failure: 'plan_input_rejected' };
      if (state === 'oversize') return { ok: false, failure: 'plan_input_oversize' };
    }

    const result = new core.PlanService(projectRoot).read(feature, { mode: 'full' });
    if (!result) return { ok: false, failure: 'plan_missing' };
    return { ok: true, featurePath: relative(projectRoot, featurePath), planPath: relative(projectRoot, planPath), result };
  } catch {
    return { ok: false, failure: 'plan_read_failed' };
  }
}

/** The fields of two full plan reads that a revision-bound approval relies on; equal reads show no differences. */
export function planReadDifferences(plugin: Json, core: Json): string[] {
  const out: string[] = [];
  for (const field of ['revision', 'contentHash', 'status', 'content']) if (plugin?.[field] !== core?.[field]) out.push(field);
  if (JSON.stringify(plugin?.comments ?? null) !== JSON.stringify(core?.comments ?? null)) out.push('comments');
  return out;
}
