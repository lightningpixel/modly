// Wire git to the version-controlled hooks in .githooks (runs via `prepare` on
// every `npm install`). Failures are swallowed so installing outside a git
// checkout (e.g. CI from a tarball) never breaks the install.
import { spawnSync } from 'node:child_process'

const r = spawnSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' })
if (r.status === 0) {
  console.log('[setup-hooks] git hooks enabled (core.hooksPath = .githooks)')
} else {
  console.log('[setup-hooks] skipped (not a git checkout) — hooks not wired')
}
