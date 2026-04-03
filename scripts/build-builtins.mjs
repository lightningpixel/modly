/**
 * Compile built-in extensions (TypeScript → CommonJS JS) and copy manifests.
 * Output: out/builtin-extensions/{id}/processor.js + manifest.json
 */

import { execSync }                                           from 'child_process'
import { readdirSync, existsSync, cpSync, mkdirSync, statSync } from 'fs'
import { join, dirname }                                      from 'path'
import { fileURLToPath }                                      from 'url'

const root   = join(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(root, 'src', 'areas', 'workflows', 'nodes')
const outDir = join(root, 'out', 'builtin-extensions')

if (!existsSync(srcDir)) {
  console.log('[build-builtins] No builtin-extensions directory found, skipping.')
  process.exit(0)
}

// 1. Compile TypeScript
console.log('[build-builtins] Compiling TypeScript…')
execSync('npx tsc -p tsconfig.builtins.json', { cwd: root, stdio: 'inherit' })

// 2. Copy manifest.json, and optionally package.json + npm install
for (const id of readdirSync(srcDir)) {
  const extSrcDir = join(srcDir, id)
  if (!statSync(extSrcDir).isDirectory()) continue
  // Only process extension folders (those with a manifest.json)
  if (!existsSync(join(extSrcDir, 'manifest.json'))) continue

  const extOutDir = join(outDir, id)
  mkdirSync(extOutDir, { recursive: true })

  const manifestSrc = join(extSrcDir, 'manifest.json')
  if (existsSync(manifestSrc)) {
    cpSync(manifestSrc, join(extOutDir, 'manifest.json'))
    console.log(`[build-builtins] ${id}: manifest.json copied`)
  } else {
    console.warn(`[build-builtins] ${id}: manifest.json missing — skipping`)
  }

  const pkgSrc = join(extSrcDir, 'package.json')
  if (existsSync(pkgSrc)) {
    cpSync(pkgSrc, join(extOutDir, 'package.json'))
    console.log(`[build-builtins] ${id}: Installing npm dependencies…`)
    execSync('npm install --omit=dev --no-audit --no-fund', {
      cwd:   extOutDir,
      stdio: 'inherit',
    })
    console.log(`[build-builtins] ${id}: npm install done`)
  }
}

console.log('[build-builtins] Done.')
