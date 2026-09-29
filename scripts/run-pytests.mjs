// Portable Python test runner.
// `python3` is the macOS/Linux name but does not exist on Windows (where the
// interpreter is `python` or the `py` launcher). Try each candidate until one
// actually runs, then forward unittest's exit code.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const apiDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'api')

// Prefer a project-local venv (api/.venv) when present: system Python usually
// lacks the API dependencies (fastapi, …) and the test import fails.
const venvPython = join(
  apiDir,
  '.venv',
  process.platform === 'win32' ? 'Scripts' : 'bin',
  process.platform === 'win32' ? 'python.exe' : 'python',
)

const candidates = [
  [venvPython, []],
  ['python3', []],
  ['python', []],
  ['py', ['-3']],
]

function works(cmd, prefix) {
  try {
    const r = spawnSync(cmd, [...prefix, '--version'], { stdio: 'ignore' })
    return r.status === 0
  } catch {
    return false
  }
}

const found = candidates.find(([cmd, prefix]) => works(cmd, prefix))
if (!found) {
  console.error('[run-pytests] No Python interpreter found (tried python3, python, py -3).')
  process.exit(1)
}

const [cmd, prefix] = found
const result = spawnSync(cmd, [...prefix, '-m', 'unittest', 'discover', '-s', 'tests'], {
  cwd: apiDir,
  stdio: 'inherit',
})
process.exit(result.status ?? 1)
