// Environment for the Python processes Modly spawns. Kept free of Electron
// imports so it can be unit-tested directly.

/** Vars that would redirect imports or installs to the user's own Python. */
const PYTHON_REDIRECT_VARS = [
  'PYTHONHOME', 'PYTHONPATH', 'PYTHONSTARTUP', 'PYTHONUSERBASE',
  'PIP_USER', 'PIP_TARGET', 'PIP_PREFIX', 'PIP_REQUIRE_VIRTUALENV',
  'VIRTUAL_ENV', 'CONDA_PREFIX',
]

/**
 * Search-path vars an AppImage launcher points into its own mount. Python and
 * the compilers pip runs would load the AppImage's bundled libraries instead of
 * the system ones, which breaks venv creation and native builds (#236).
 */
const APPIMAGE_PATH_VARS: Record<string, string> = {
  LD_LIBRARY_PATH: ':',
  LD_PRELOAD:      ' ',
  PATH:            ':',
}

function withoutEntriesUnder(value: string, dir: string, separator: string): string {
  const root = dir.replace(/\/+$/, '')
  return value
    .split(separator === ' ' ? /[\s:]+/ : separator)
    .filter((entry) => entry !== '' && entry !== root && !entry.startsWith(`${root}/`))
    .join(separator)
}

/** The env without vars that redirect to the user's system Python. */
export function pythonChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...env }
  for (const name of PYTHON_REDIRECT_VARS) delete clean[name]
  return clean
}

/**
 * pythonChildEnv, plus no path entries into the AppImage mount. Only for
 * extension setup, which runs the stable Python copy, pip and system compilers.
 * Not for the API or process extensions: they relaunch the Electron binary that
 * lives inside the mount (MODLY_NODE_EXECUTABLE) and may need its libraries.
 */
export function extensionChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = pythonChildEnv(env)
  // APPDIR is set by the AppImage runtime to its mount (/tmp/.mount_Modly-XXXX).
  const appDir = env.APPDIR
  if (!appDir) return clean
  for (const [name, separator] of Object.entries(APPIMAGE_PATH_VARS)) {
    const value = clean[name]
    if (value === undefined) continue
    const kept = withoutEntriesUnder(value, appDir, separator)
    if (kept) clean[name] = kept
    else delete clean[name]
  }
  return clean
}
