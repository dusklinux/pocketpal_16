const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const backend = path.join(root, 'node_modules', 'llama.rn');
const patch = path.join(root, 'patches', 'llama-cpp.patch');
const commit = 'c83f3058b6f876f2f7e6ccbada858b2446860c85';
const hash = crypto
  .createHash('sha256')
  .update(fs.readFileSync(patch))
  .digest('hex');
const marker = path.join(backend, '.pocketpal16-backend');
if (
  JSON.parse(fs.readFileSync(path.join(backend, 'package.json'))).version !==
  '0.13.0-rc.7'
) {
  throw new Error('The backend patch requires llama.rn 0.13.0-rc.7.');
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
  // Embed updated Metal source instead of retaining kernels from the old engine.
  const metal = path.join(
    backend,
    'vendor',
    'llama.cpp',
    'ggml',
    'src',
    'ggml-metal',
  );
  const kernels = path.join(metal, 'kernels');
  for (const file of fs.readdirSync(metal)) {
    if (/^ggml-metal-embed.*\.s$/.test(file)) {
      fs.unlinkSync(path.join(metal, file));
    }
  }
  for (const file of fs
    .readdirSync(kernels)
    .filter(
      file =>
        file.endsWith('.metal') &&
        !['fa_common.metal', 'fa_vec_common.metal'].includes(file),
    )) {
    const original = fs.readFileSync(path.join(kernels, file), 'utf8');
    const includes = [
      'common.h',
      ...[
        'dequantize.h',
        'quantize.h',
        'fa_common.metal',
        'fa_vec_common.metal',
      ].filter(name => original.includes(`#include "${name}"`)),
    ];
    let source =
      includes
        .map(name => fs.readFileSync(path.join(kernels, name), 'utf8'))
        .join('') + original;
    source = source
      .replace(
        /^\s*#include "(?:common.h|dequantize.h|quantize.h|fa_common.metal|fa_vec_common.metal)".*\n/gm,
        '',
      )
      .replace(/^\s*#pragma once.*\n/gm, '');
    source = source.replace(
      /^\s*#include "ggml-metal-impl.h".*\n/gm,
      fs.readFileSync(path.join(metal, 'ggml-metal-impl.h'), 'utf8'),
    );
    source = source.replace(/^\s*#include "ggml-common.h".*\n/gm, () =>
      fs.readFileSync(path.join(metal, '..', 'ggml-common.h'), 'utf8'),
    );
    if (/^\s*#include "/m.test(source)) {
      throw new Error(`Unresolved Metal include in ${file}`);
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
  for (const file of [
    'src/version.ts',
    'lib/commonjs/version.js',
    'lib/module/version.js',
  ]) {
    const filename = path.join(backend, file);
    fs.writeFileSync(
      filename,
      fs
        .readFileSync(filename, 'utf8')
        .replaceAll('11385', '0')
        .replaceAll('bf9a0cc', commit.slice(0, 7)),
    );
  }
  fs.writeFileSync(marker, hash);
}
console.log(
  `Prepared llama.cpp ${commit.slice(0, 12)} (text-only, CPU/Metal).`,
);
