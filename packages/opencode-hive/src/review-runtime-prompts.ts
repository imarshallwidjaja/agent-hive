export const REVIEW_SOURCE_RESOLUTION_BOUNDARY = 'Provider outcome, exact-OID snapshot resolution, freshness revalidation, and provenance are runtime-owned. Preserve the returned sourceResolution and compact provenance envelope unchanged. Never fetch, checkout, synthesize or mutate live refs, FETCH_HEAD, the index, worktree, or Git configuration.';

export const REVIEW_FROZEN_WORKSPACE_BOUNDARY = 'Use only the supplied frozen absolute workspace paths. Process cwd is live source and is never an authorized source path. Do not roll back live source or review-workspace state.';

export const REVIEW_WORKSPACE_LIFECYCLE_BOUNDARY = 'The only normal review-workspace lifecycle is creator create, primary claim, primary inspect, and one normal cleanup. The sole exception is one runtime-authenticated recovery cleanup by the exact originating vulnerability primary after a cleanup-recovery-required result. Do not create a second workspace or skip cleanup.';
