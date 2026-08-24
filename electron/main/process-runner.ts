import { Worker }      from 'worker_threads'
import { spawn }       from 'child_process'
import type { ChildProcess } from 'child_process'
import { existsSync }  from 'fs'
import { join }        from 'path'
import { API_BASE_URL } from './python-bridge'
import { getApiToken } from './api-token'

// ─── Worker code for JS process extensions ────────────────────────────────────

const WORKER_CODE = /* js */ `
const { workerData, parentPort } = require('worker_threads')
const path = require('path')
const Module = require('module')

// Resolve modules from the extension's own node_modules
const require_ext = Module.createRequire(path.join(workerData.extDir, '_'))

let processor
try {
  processor = require_ext(path.join(workerData.extDir, workerData.entry))
  if (typeof processor !== 'function') {
    throw new Error('processor.js must export a function as module.exports')
  }
} catch (err) {
  parentPort.postMessage({ type: 'error', message: 'Failed to load processor: ' + String(err) })
  process.exit(1)
}

parentPort.postMessage({ type: 'ready' })

parentPort.on('message', async (msg) => {
  if (msg.action !== 'run') return
  try {
    const context = {
      workspaceDir: workerData.workspaceDir,
      tempDir:      workerData.tempDir,
      nodeId:       msg.input?.nodeId ?? '',
      log:      (m)         => parentPort.postMessage({ type: 'log',      message: String(m) }),
      progress: (pct, label) => parentPort.postMessage({ type: 'progress', percent: pct, label }),
    }
    const result = await processor(msg.input, msg.params, context)
    parentPort.postMessage({ type: 'done', result })
  } catch (err) {
    parentPort.postMessage({ type: 'error', message: String(err) })
  }
})
`

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProcessInput {
  filePath?: string
  text?:     string
  /** Per-slot texts for multi-text-input nodes (index = target handle slot). */
  texts?:    (string | undefined)[]
  nodeId?:   string
}

export interface ProcessResult {
  filePath?: string
  text?:     string
}

export interface IProcessRunner {
  run(
    input:       ProcessInput,
    params:      Record<string, unknown>,
    onProgress?: (percent: number, label: string) => void,
    onLog?:      (message: string) => void,
  ): Promise<ProcessResult>
  terminate(): void
}

// ─── JS ProcessRunner (Worker thread) ────────────────────────────────────────

export class ProcessRunner implements IProcessRunner {
  private worker:   Worker | null = null
  private ready:    boolean       = false
  private cancelled: boolean      = false
  /** The in-flight boot, shared by overlapping runs so only one Worker is ever
   *  constructed. Null whenever no boot is running. */
  private booting:  Promise<void> | null = null
  private extDir:   string
  private entry:    string
  private workspaceDir: string
  private tempDir:  string

  constructor(extDir: string, entry: string, workspaceDir: string, tempDir: string) {
    this.extDir       = extDir
    this.entry        = entry
    this.workspaceDir = workspaceDir
    this.tempDir      = tempDir
  }

  /** Refresh the paths on a cached runner, like the Python one does — otherwise
   *  changing the models/workspace folder in Settings had no effect on a JS
   *  extension until the app restarted. The worker bakes these into its
   *  workerData, so a change has to drop it and re-boot. */
  configure(extDir: string, entry: string, workspaceDir: string, tempDir: string): void {
    const changed = extDir !== this.extDir || entry !== this.entry
      || workspaceDir !== this.workspaceDir || tempDir !== this.tempDir
    this.extDir       = extDir
    this.entry        = entry
    this.workspaceDir = workspaceDir
    this.tempDir      = tempDir
    if (changed && this.worker) {
      void this.worker.terminate()
      this.worker = null
      this.ready  = false
      // Leaving this set handed the next run an already-resolved promise with
      // no worker behind it, and `this.worker!` then threw on null.
      this.booting = null
    }
  }

  /**
   * The worker for this runner, booting one if needed.
   *
   * Returns it rather than leaving the caller to read `this.worker`, because a
   * `configure()` landing mid-boot drops the worker the boot was starting: the
   * shared promise resolves with nothing behind it. One retry covers that, and
   * a second failure means the paths are being changed faster than a worker can
   * start, which is not something to paper over.
   */
  private async ensureReady(): Promise<Worker> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.ready && this.worker) return this.worker
      // Two overlapping runs would each construct a Worker and the second would
      // orphan the first — a live thread holding the extension's node_modules that
      // nothing can terminate. Share the in-flight boot instead.
      if (this.booting) { await this.booting; continue }
      await this.boot()
    }
    if (this.ready && this.worker) return this.worker
    throw new Error('Extension worker was reconfigured while starting')
  }

  private async boot(): Promise<void> {
    const booting = new Promise<void>((resolve, reject) => {
      const worker = new Worker(WORKER_CODE, {
        eval: true,
        workerData: {
          extDir:       this.extDir,
          entry:        this.entry,
          workspaceDir: this.workspaceDir,
          tempDir:      this.tempDir,
        },
      })
      // Assign immediately: until the worker says 'ready' this was null, so
      // Cancel during a slow `require` killed nothing and reported success.
      this.worker = worker

      const settle = (err?: Error) => {
        worker.off('message', onMessage)
        worker.off('error', onError)
        worker.off('exit', onExit)
        if (err) {
          this.worker = null
          this.ready  = false
          reject(err)
        } else {
          this.ready = true
          resolve()
        }
      }
      const onMessage = (msg: { type: string; message?: string }) => {
        if (msg.type === 'ready') settle()
        else if (msg.type === 'error') { void worker.terminate(); settle(new Error(msg.message)) }
      }
      const onError = (err: Error) => settle(err)
      // A processor that calls process.exit() at module scope, or whose native
      // dependency aborts the thread, emits ONLY 'exit'. Without this the promise
      // never settled and the IPC call hung for the app's lifetime.
      const onExit = (code: number) =>
        settle(new Error(this.cancelled ? 'Cancelled' : `Extension worker exited with code ${code} while loading`))

      worker.on('message', onMessage)
      worker.once('error', onError)
      worker.once('exit', onExit)
    })

    this.booting = booting
    try {
      await booting
    } finally {
      // Only if it is still ours: a configure() during the boot may already
      // have cleared it and let another boot take the slot.
      if (this.booting === booting) this.booting = null
    }
  }

  /**
   * The cancelled flag is sticky, exactly like the Python runner's:
   * terminate() also drops this runner from the registry, so a cancelled
   * instance is never reused and the next run builds a fresh one. Clearing it
   * on entry instead made this guard dead code — a Cancel landing between the
   * IPC call and run() killed the worker, and ensureReady() then booted a NEW
   * one: the extension ran to completion after the run store was back to idle.
   */
  private throwIfCancelled(): void {
    if (this.cancelled) throw new Error('Cancelled')
  }

  async run(
    input:  ProcessInput,
    params: Record<string, unknown>,
    onProgress?: (percent: number, label: string) => void,
    onLog?:      (message: string) => void,
  ): Promise<ProcessResult> {
    // Checked on both sides of the boot: a Cancel can land before this call, or
    // during the await.
    this.throwIfCancelled()
    const worker = await this.ensureReady()
    this.throwIfCancelled()

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        worker.off('message', handler)
        worker.off('exit', onExit)
        worker.off('error', onError)
      }
      const handler = (msg: { type: string; result?: ProcessResult; message?: string; percent?: number; label?: string }) => {
        if (msg.type === 'progress') {
          onProgress?.(msg.percent ?? 0, msg.label ?? '')
        } else if (msg.type === 'log') {
          onLog?.(msg.message ?? '')
        } else if (msg.type === 'done') {
          cleanup()
          resolve(msg.result ?? {})
        } else if (msg.type === 'error') {
          cleanup()
          reject(new Error(msg.message))
        }
      }
      // Without these, terminate() (workflow Cancel, or an install swapping the
      // extension folder) killed the worker and left this promise pending for
      // the app's lifetime — the IPC call never replied and the node never ended.
      const onExit = (code: number) => {
        cleanup()
        reject(new Error(this.cancelled ? 'Cancelled' : `Extension worker exited with code ${code}`))
      }
      const onError = (err: Error) => {
        cleanup()
        reject(err)
      }

      worker.on('message', handler)
      worker.once('exit', onExit)
      worker.once('error', onError)
      worker.postMessage({ action: 'run', input, params })
    })
  }

  terminate(): void {
    this.cancelled = true
    this.worker?.terminate()
    this.worker = null
    this.ready  = false
    this.booting = null
  }
}

// ─── Python ProcessRunner (subprocess, one process per run) ───────────────────
//
// Protocol — stdin:  one JSON line  { input, params, workspaceDir, tempDir }
// Protocol — stdout: JSON lines     { type: 'progress'|'log'|'done'|'error', ... }

export class PythonProcessRunner implements IProcessRunner {
  private pythonExe    = ''
  private extDir       = ''
  private scriptPath   = ''
  private workspaceDir = ''
  private modelsDir    = ''
  private tempDir      = ''
  /** Live child, kept so terminate() (workflow Cancel) can actually kill it. */
  private proc:         ChildProcess | null = null
  private cancelled                         = false

  constructor(pythonExe: string, extDir: string, entry: string, workspaceDir: string, tempDir: string, modelsDir: string) {
    this.configure(pythonExe, extDir, entry, workspaceDir, tempDir, modelsDir)
  }

  /** Runners are cached per extension id, so paths must be refreshed on every
   *  run — otherwise changing the models/workspace folder in Settings has no
   *  effect on this extension until the app restarts. */
  configure(pythonExe: string, extDir: string, entry: string, workspaceDir: string, tempDir: string, modelsDir: string): void {
    this.pythonExe    = pythonExe
    this.extDir       = extDir
    this.scriptPath   = join(extDir, entry)
    this.workspaceDir = workspaceDir
    this.modelsDir    = modelsDir
    this.tempDir      = tempDir
  }

  async run(
    input:  ProcessInput,
    params: Record<string, unknown>,
    onProgress?: (percent: number, label: string) => void,
    onLog?:      (message: string) => void,
  ): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      // Cancel arriving between the IPC call and this spawn used to hit
      // `if (!proc?.pid) return` and kill nothing, while the handler still
      // answered {success:true}: the run store reset to idle and the extension
      // then ran to completion, unreachable because terminate() had already
      // dropped it from the registry.
      //
      // The flag is sticky on purpose — resetting it here made this guard dead
      // code, since the executor runs synchronously right after. terminate()
      // also drops the runner from the registry, so a cancelled instance is
      // never reused: the next run builds a fresh one with cancelled = false.
      if (this.cancelled) { reject(new Error('Cancelled')); return }
      const proc = spawn(this.pythonExe, [this.scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        // Same contract the API-side runner gives model extensions
        // (api/services/extension_process.py). MODLY_API_URL is what lets an
        // extension call back into Modly — e.g. POST /llm/chat for the shared LLM.
        env: {
          ...process.env,
          // Force UTF-8 stdio so Unicode prints from process extensions do not
          // crash under legacy Windows codepages (cp1252/cp932).
          PYTHONUTF8: '1',
          MODLY_API_URL: API_BASE_URL,
          // ...and what makes such a call go through: the API refuses requests
          // that cannot prove they come from a local Modly client.
          MODLY_API_TOKEN: getApiToken(),
          EXTENSION_DIR: this.extDir,
          WORKSPACE_DIR: this.workspaceDir,
          MODELS_DIR:    this.modelsDir,
          TEMP_DIR:      this.tempDir,
        },
      })
      this.proc = proc

      // Send input as a single JSON line on stdin
      proc.stdin.write(JSON.stringify({
        input,
        params,
        nodeId:       input.nodeId ?? '',
        workspaceDir: this.workspaceDir,
        tempDir:      this.tempDir,
      }) + '\n')
      proc.stdin.end()

      let stdoutBuf = ''
      let resolved  = false

      proc.stdout.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString()
        const lines = stdoutBuf.split('\n')
        stdoutBuf = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            const msg = JSON.parse(trimmed) as { type: string; percent?: number; label?: string; message?: string; result?: ProcessResult }
            if (msg.type === 'progress') {
              onProgress?.(msg.percent ?? 0, msg.label ?? '')
            } else if (msg.type === 'log') {
              onLog?.(msg.message ?? '')
            } else if (msg.type === 'done') {
              resolved = true
              resolve(msg.result ?? {})
            } else if (msg.type === 'error') {
              resolved = true
              reject(new Error(msg.message ?? 'Unknown error'))
            }
          } catch {
            // Non-JSON stdout line — treat as a log message
            onLog?.(trimmed)
          }
        }
      })

      // stderr is free-form (tracebacks, tqdm bars, pip noise). Stream it live as
      // logs — a run that calls an LLM can take minutes, so waiting for a
      // non-zero exit to show anything leaves the user staring at nothing.
      //
      // \r is a line terminator here, not just \n: tqdm repaints with a bare \r
      // and only emits one \n when it closes, so splitting on \n alone showed
      // NOTHING for the whole download and grew the pending line by every
      // repaint (~100 MB over a long run). Emission is throttled instead, so a
      // 10 Hz progress bar costs 5 IPC messages/s rather than thousands.
      const LOG_THROTTLE_MS = 200
      let stderrBuf  = ''
      let stderrLine = ''
      let lastLogAt  = 0
      // Throttling by dropping lines was wrong for anything that is not a
      // progress bar: every line of a traceback arrives in the same chunk, so
      // all but `Traceback (most recent call last):` was discarded and the live
      // log showed nothing exactly when it mattered. Real lines are queued and
      // flushed as one message instead, which keeps the IPC rate bounded
      // without losing any of them.
      let pending: string[] = []
      let flushTimer: NodeJS.Timeout | null = null
      const flushPending = () => {
        flushTimer = null
        if (pending.length === 0) return
        lastLogAt = Date.now()
        onLog?.(pending.join('\n'))
        pending = []
      }
      const stopFlushing = () => {
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
      }

      proc.stderr.on('data', (chunk: Buffer) => {
        const s = chunk.toString()
        // Only the tail is needed for the failure message; a chatty run would
        // otherwise grow this unbounded for the whole duration.
        stderrBuf = (stderrBuf + s).slice(-8192)
        stderrLine = (stderrLine + s).slice(-8192)
        // Keep the terminator: a \r-terminated fragment is a tqdm repaint that
        // the next one supersedes and may be dropped, a \n-terminated one is a
        // real line that may not.
        const parts = stderrLine.split(/(\r\n|\n|\r)/)
        stderrLine = parts.pop() ?? ''
        for (let i = 0; i < parts.length; i += 2) {
          const trimmed = parts[i].trim()
          if (!trimmed) continue
          const now = Date.now()

          if (parts[i + 1] === '\r') {
            if (now - lastLogAt < LOG_THROTTLE_MS) continue
            stopFlushing()
            flushPending()
            lastLogAt = now
            onLog?.(trimmed)
            continue
          }

          pending.push(trimmed)
          if (now - lastLogAt >= LOG_THROTTLE_MS) {
            stopFlushing()
            flushPending()
          } else if (!flushTimer) {
            flushTimer = setTimeout(flushPending, LOG_THROTTLE_MS - (now - lastLogAt))
          }
        }
      })

      proc.on('close', (code) => {
        this.proc = null
        // The queue and the last unterminated fragment would otherwise be lost,
        // and a pending timer would fire after the run is over.
        stopFlushing()
        if (stderrLine.trim()) { pending.push(stderrLine.trim()); stderrLine = '' }
        flushPending()
        if (!resolved) {
          if (code === 0) {
            resolve({})
          } else if (this.cancelled) {
            reject(new Error('Cancelled'))
          } else {
            reject(new Error(stderrBuf.trim() || `Python process exited with code ${code}`))
          }
        }
      })

      proc.on('error', (err) => {
        this.proc = null
        stopFlushing()
        if (!resolved) {
          resolved = true
          reject(err)
        }
      })
    })
  }

  /** Kills the in-flight run. The extension side treats the broken stdout pipe
   *  as a host cancellation, but it may be blocked in a 10-minute HTTP call to
   *  /llm/chat, so the process tree is killed outright. */
  terminate(): void {
    // Set first, unconditionally: a cancel that lands before spawn has no
    // process to kill but must still stop the run from starting.
    this.cancelled = true
    const proc = this.proc
    if (!proc?.pid) return
    if (process.platform === 'win32') {
      // A venv python spawns further children (CadQuery code execution); /T kills the tree.
      spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      proc.kill('SIGKILL')
    }
    this.proc = null
  }
}

// ─── Helper: find Python executable for an extension ─────────────────────────

export function getExtPythonExe(extDir: string): string | null {
  const candidates = process.platform === 'win32'
    ? [join(extDir, 'venv', 'Scripts', 'python.exe')]
    : [join(extDir, 'venv', 'bin', 'python'), join(extDir, 'venv', 'bin', 'python3')]

  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}

// ─── Registry (one runner per extension id, reused across calls) ──────────────

const registry = new Map<string, IProcessRunner>()

/** Cached runner of the expected class, or undefined. Both getters share one
 *  registry keyed by extension id, so an extension that switches its manifest
 *  `entry` from .js to .py (or back) would otherwise hand a blindly-cast runner
 *  of the wrong class to the caller — Python spawning on a .js path, or
 *  `existing.configure is not a function`. */
function cachedRunner<T extends IProcessRunner>(
  extensionId: string,
  ctor: new (...args: never[]) => T,
): T | undefined {
  const existing = registry.get(extensionId)
  if (!existing) return undefined
  if (existing instanceof ctor) return existing
  existing.terminate()
  registry.delete(extensionId)
  return undefined
}

export function getProcessRunner(
  extensionId:  string,
  extDir:       string,
  entry:        string,
  workspaceDir: string,
  tempDir:      string,
): ProcessRunner {
  const existing = cachedRunner(extensionId, ProcessRunner)
  if (existing) {
    existing.configure(extDir, entry, workspaceDir, tempDir)
    return existing
  }
  const runner = new ProcessRunner(extDir, entry, workspaceDir, tempDir)
  registry.set(extensionId, runner)
  return runner
}

export function getPythonProcessRunner(
  extensionId:  string,
  pythonExe:    string,
  extDir:       string,
  entry:        string,
  workspaceDir: string,
  tempDir:      string,
  modelsDir:    string,
): PythonProcessRunner {
  const existing = cachedRunner(extensionId, PythonProcessRunner)
  if (existing) {
    existing.configure(pythonExe, extDir, entry, workspaceDir, tempDir, modelsDir)
    return existing
  }
  const runner = new PythonProcessRunner(pythonExe, extDir, entry, workspaceDir, tempDir, modelsDir)
  registry.set(extensionId, runner)
  return runner
}

export function terminateProcessRunner(extensionId: string): void {
  registry.get(extensionId)?.terminate()
  registry.delete(extensionId)
}

export function terminateAllProcessRunners(): void {
  for (const runner of registry.values()) runner.terminate()
  registry.clear()
}
