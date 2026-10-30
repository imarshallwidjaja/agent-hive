// Copies the Koffi runtime that Hive's crash-released locks load into dist/native/koffi.
//
// The extension is packaged without node_modules, so the bundle loads Koffi from this artifact-relative copy:
// the original loader, its package metadata and license, and every prebuilt binary the pinned package ships.
// One platform-neutral VSIX therefore carries all supported platforms; nothing is downloaded at build or run time.
const fs = require('fs');
const path = require('path');

const packageRoot = path.resolve(__dirname, '..');
const pinned = require(path.join(packageRoot, 'package.json')).devDependencies.koffi;
const sourceRoot = path.dirname(require.resolve('koffi/package.json', { paths: [packageRoot] }));
const installed = require(path.join(sourceRoot, 'package.json')).version;
if (installed !== pinned) {
  throw new Error(`Installed koffi ${installed} does not match the pinned ${pinned}; reinstall dependencies before building.`);
}

const destinationRoot = path.join(packageRoot, 'dist', 'native', 'koffi');
const binaryRoot = path.join('build', 'koffi');
const binaries = fs.readdirSync(path.join(sourceRoot, binaryRoot)).sort()
  .map((triplet) => path.join(binaryRoot, triplet, 'koffi.node'))
  .filter((relative) => fs.existsSync(path.join(sourceRoot, relative)));
if (binaries.length === 0) throw new Error(`No Koffi prebuilt binaries found under ${path.join(sourceRoot, binaryRoot)}`);

for (const relative of ['index.js', 'package.json', 'LICENSE.txt', ...binaries]) {
  const destination = path.join(destinationRoot, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(sourceRoot, relative), destination);
}
console.log(`Copied koffi ${installed} with ${binaries.length} prebuilt binaries to ${path.relative(packageRoot, destinationRoot)}`);
