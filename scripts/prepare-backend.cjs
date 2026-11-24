const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');

const root = path.resolve(__dirname, '..');
const rootPkg = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
);
const expectedBridgeVersion = String(
  rootPkg.dependencies?.['llama.rn'] ?? '',
).replace(/^[~^]/, '');
if (!expectedBridgeVersion) {
  throw new Error('Could not determine llama.rn version from package.json.');
}

const backend = path.join(root, 'node_modules', 'llama.rn');
const patch = path.join(root, 'patches', 'llama-cpp.patch');
const commit = 'af5c58347fdbc2cd19e65b278e81c8f528f8a175';
const hash = crypto
  .createHash('sha256')
  .update(fs.readFileSync(patch))
  .digest('hex');
const marker = path.join(backend, '.pocketpal16-backend');

const installedBridgeVersion = JSON.parse(
  fs.readFileSync(path.join(backend, 'package.json'), 'utf8'),
).version;
if (installedBridgeVersion !== expectedBridgeVersion) {
  throw new Error(
    `The backend patch requires llama.rn ${expectedBridgeVersion}, found ${installedBridgeVersion}.`,
  );
}

function resolveLocalInclude(includeName, currentDir, searchDirs) {
  for (const baseDir of [currentDir, ...searchDirs]) {
    const candidate = path.resolve(baseDir, includeName);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

function expandMetalFile(filePath, searchDirs, included) {
  const canonical = path.resolve(filePath);
  if (included.has(canonical)) return '';
  included.add(canonical);

  const dir = path.dirname(canonical);
  const lines = fs.readFileSync(canonical, 'utf8').split('\n');
  const output = [];

  for (const line of lines) {
    if (/^\s*#pragma\s+once\b/.test(line)) {
      continue;
    }
    const match = /^\s*#include\s+"([^"]+)"/.exec(line);
    if (match) {
      const target = resolveLocalInclude(match[1], dir, searchDirs);
      if (!target) {
        throw new Error(
          `Unresolved Metal include "${match[1]}" in ${path.relative(root, canonical)}`,
        );
      }
      const expanded = expandMetalFile(target, searchDirs, included);
      if (expanded) output.push(expanded);
      continue;
    }
    output.push(line);
  }

  return output.join('\n');
}

function embedMetalKernels() {
  const metal = path.join(
    backend,
    'vendor',
    'llama.cpp',
    'ggml',
    'src',
    'ggml-metal',
  );
  const kernels = path.join(metal, 'kernels');
  if (!fs.existsSync(kernels)) {
    throw new Error(`Expected Metal kernels directory not found: ${kernels}`);
  }

  const searchDirs = [
    kernels,
    metal,
    path.join(metal, '..'),
    path.join(metal, '..', '..', 'include'),
  ];

  // Clean stale generated assembly embeddings.
  for (const file of fs.readdirSync(metal)) {
    if (/^ggml-metal-embed.*\.s$/.test(file)) {
      fs.unlinkSync(path.join(metal, file));
    }
  }

  // Dynamically identify helper .metal files included by other files in kernels/.
  const includedMetalHelpers = new Set();
  for (const file of fs.readdirSync(kernels)) {
    const fullPath = path.join(kernels, file);
    if (!fs.statSync(fullPath).isFile()) continue;
    const text = fs.readFileSync(fullPath, 'utf8');
    for (const match of text.matchAll(/^\s*#include\s+"([^"]+\.metal)"/gm)) {
      const resolved = resolveLocalInclude(match[1], kernels, searchDirs);
      if (resolved) includedMetalHelpers.add(resolved);
    }
  }

  const commonHeader = path.join(kernels, 'common.h');
  const hasCommonHeader = fs.existsSync(commonHeader);

  const kernelFiles = fs
    .readdirSync(kernels)
    .filter(
      file =>
        file.endsWith('.metal') &&
        !includedMetalHelpers.has(path.resolve(kernels, file)),
    )
    .sort();

  for (const file of kernelFiles) {
    const kernelPath = path.join(kernels, file);
    const included = new Set();
    const parts = [];

    // Always preload common.h first; `included` deduplicates any later explicit include.
    if (hasCommonHeader) {
      parts.push(expandMetalFile(commonHeader, searchDirs, included));
    }
    parts.push(expandMetalFile(kernelPath, searchDirs, included));

    const source = parts.join('\n') + '\n';
    if (/^\s*#include\s+"/m.test(source)) {
      throw new Error(
        `Unresolved Metal include remained after expansion in ${file}`,
      );
    }
    const kind = path.basename(file, '.metal').replaceAll('-', '_');
    const bytes = Buffer.from(source);
    const lines = [];
    for (let start = 0; start < bytes.length; start += 16) {
      lines.push(
        '.byte ' +
          [...bytes.subarray(start, start + 16)]
            .map(byte => '0x' + byte.toString(16).padStart(2, '0'))
            .join(','),
      );
    }
    fs.writeFileSync(
      path.join(metal, `ggml-metal-embed-${kind}.s`),
      `.section __DATA,__ggml_metallib\n.globl _ggml_metallib_${kind}_start\n_ggml_metallib_${kind}_start:\n${lines.join('\n')}\n.globl _ggml_metallib_${kind}_end\n_ggml_metallib_${kind}_end:\n`,
    );
  }
}

function updateBridgeVersionMetadata() {
  const shortCommit = commit.slice(0, 7);
  for (const file of [
    'src/version.ts',
    'lib/commonjs/version.js',
    'lib/module/version.js',
  ]) {
    const filename = path.join(backend, file);
    const original = fs.readFileSync(filename, 'utf8');
    const updated = original
      .replace(/(BUILD_NUMBER(?:\s*:\s*\w+)?\s*=\s*)(['"]?)\d+\2/g, '$1$20$2')
      .replace(
        /(BUILD_COMMIT(?:\s*:\s*\w+)?\s*=\s*)(['"])[0-9a-fA-F]{7,40}\2/g,
        `$1$2${shortCommit}$2`,
      );
    if (!updated.includes(shortCommit)) {
      throw new Error(
        `Failed to update BUILD_COMMIT in ${file}; inspect llama.rn version file format.`,
      );
    }
    fs.writeFileSync(filename, updated);
  }
}

if (fs.existsSync(marker)) {
  if (fs.readFileSync(marker, 'utf8') !== hash) {
    throw new Error(
      'Backend patch changed. Remove node_modules/llama.rn and reinstall dependencies.',
    );
  }
} else {
  const result = spawnSync('patch', ['-p1', '-f', '-F', '0', '-i', patch], {
    cwd: backend,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `Backend patch failed. Reinstall llama.rn before retrying.\n${result.stdout}\n${result.stderr}`,
    );
  }
  embedMetalKernels();
  updateBridgeVersionMetadata();
  fs.writeFileSync(marker, hash);
}

console.log(
  `Prepared llama.cpp ${commit.slice(0, 12)} (text-only, CPU/Metal).`,
);
