import { execFileSync } from 'node:child_process';
import path from 'node:path';

const packageDirectory = path.resolve(import.meta.dirname, '..', '..', 'packages', 'opencode-hive');

export function validateNpmPublishAccess({ npmUser, collaborators }) {
  if (!npmUser) {
    throw new Error('npm whoami returned an empty username');
  }

  const access = collaborators[npmUser];

  if (!access) {
    throw new Error(`npm user ${npmUser} is not listed as a collaborator on opencode-hive`);
  }

  if (access !== 'read-write') {
    throw new Error(`npm user ${npmUser} has ${access} access to opencode-hive; expected read-write`);
  }

  return access;
}

function readNpmUser() {
  return execFileSync('npm', ['whoami'], {
    cwd: packageDirectory,
    encoding: 'utf8',
  }).trim();
}

function readCollaborators() {
  const collaboratorsJson = execFileSync('npm', ['access', 'list', 'collaborators', 'opencode-hive', '--json'], {
    cwd: packageDirectory,
    encoding: 'utf8',
  });

  return JSON.parse(collaboratorsJson);
}

function main() {
  const npmUser = readNpmUser();
  console.log(`Authenticated to npm as ${npmUser}`);

  const access = validateNpmPublishAccess({
    npmUser,
    collaborators: readCollaborators(),
  });

  console.log(`npm publish preflight passed for ${npmUser} (${access})`);
}

if (import.meta.main) {
  main();
}
