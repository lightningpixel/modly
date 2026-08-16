import { posix, win32 } from 'path'

type SetupAccelerator = 'cuda' | 'mps' | 'cpu'

interface ExtensionSetupPayloadInput {
  pythonExe:    string
  extDir:       string
  gpuSm:        number
  cudaVersion:  number
  accelerator:  SetupAccelerator
  platform:     NodeJS.Platform
  arch:         string
  modelsDir?:   string
}

export interface ExtensionSetupPayload {
  python_exe:   string
  ext_dir:      string
  gpu_sm:       number
  cuda_version: number
  accelerator:  SetupAccelerator
  platform:     NodeJS.Platform
  arch:         string
  models_dir?:  string
}

interface PythonProcessPaths {
  modelsDir:    string
  workspaceDir: string
  tempDir:      string
}

export function isSupportedExtensionSetup(
  extensionType: 'model' | 'process' | undefined,
  entry: string,
  hasSetup: boolean,
): boolean {
  return hasSetup && (extensionType !== 'process' || entry.endsWith('.py'))
}

export function cudaVersionForDriverVersion(driverVersion: string): number {
  const driverMajor = Number.parseInt(driverVersion.split('.')[0] ?? '', 10)
  if (driverMajor >= 580) return 130
  if (driverMajor >= 570) return 128
  if (driverMajor >= 560) return 126
  if (driverMajor >= 555) return 125
  if (driverMajor >= 550) return 124
  if (driverMajor >= 545) return 123
  if (driverMajor >= 535) return 122
  if (driverMajor >= 530) return 121
  if (driverMajor >= 525) return 120
  return 118
}

export function normalizeConfiguredDirectoryPath(
  value: string,
  label: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty absolute path`)
  }
  if (value.includes('\0')) {
    throw new Error(`${label} must not contain null bytes`)
  }

  const nativePath = platform === 'win32' ? win32 : posix
  const isAbsolute = platform === 'win32'
    ? /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.test(value)
    : nativePath.isAbsolute(value)
  if (!isAbsolute) {
    throw new Error(`${label} must be an absolute ${platform} path`)
  }
  return nativePath.normalize(value)
}

export function buildExtensionSetupPayload(input: ExtensionSetupPayloadInput): ExtensionSetupPayload {
  const payload: ExtensionSetupPayload = {
    python_exe:   input.pythonExe,
    ext_dir:      input.extDir,
    gpu_sm:       input.gpuSm,
    cuda_version: input.cudaVersion,
    accelerator:  input.accelerator,
    platform:     input.platform,
    arch:         input.arch,
  }

  if (input.modelsDir !== undefined) {
    payload.models_dir = normalizeConfiguredDirectoryPath(input.modelsDir, 'modelsDir', input.platform)
  }
  return payload
}

export function buildPythonProcessPayload<TInput extends { nodeId?: string }>(
  input: TInput,
  params: Record<string, unknown>,
  paths: PythonProcessPaths,
  platform: NodeJS.Platform = process.platform,
) {
  return {
    input,
    params,
    nodeId:       input.nodeId ?? '',
    modelsDir:    normalizeConfiguredDirectoryPath(paths.modelsDir, 'modelsDir', platform),
    workspaceDir: paths.workspaceDir,
    tempDir:      paths.tempDir,
  }
}
