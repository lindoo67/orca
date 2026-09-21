import { net } from 'electron'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import type { CodeServerStatus, CodeServerStatusEvent } from '../../shared/code-server-types'
import { spawnProcess } from '../../shared/child-process/run-process'
import { ensureCodeServerInstalled } from './code-server-installer'
import { mirrorVsCodeUserConfig } from './code-server-vscode-user-config'
import { disableExtensionSignatureVerification } from './code-server-signature-verification'
import { setCodeServerPid } from './code-server-process-registry'
import { hydrateShellPath, mergePathSegments } from '../startup/hydrate-shell-path'
import { promoteVersionManagerShims } from './code-server-toolchain-path'
import {
  getCodeServerExtensionsDir,
  getCodeServerCacheRoot,
  getCodeServerPidFilePath,
  getCodeServerUserDataDir,
  resolveCodeServerExecutable
} from './code-server-paths'

// Per-attempt readiness cap. Warm starts are near-instant; a cold start
// (unsigned binary + bundled Node incurring one-time macOS Gatekeeper scanning
// and first-run cache building) is slower but the OS caches that work, so a
// force-killed slow first attempt is re-spawned once (see startProcessWithOneRetry)
// and the retry hits the warm cache. Kept short so a genuinely stuck start
// surfaces to the user quickly instead of hanging.
const READY_TIMEOUT_MS = 10_000
const READY_POLL_MS = 200
// Cap retained stderr so a chatty code-server can't grow this unbounded while running.
const STDERR_TAIL_MAX_BYTES = 8 * 1024

export function buildCodeServerArgs(port: number): string[] {
  return [
    '--bind-addr',
    `127.0.0.1:${port}`,
    '--auth',
    'none',
    '--disable-telemetry',
    // The embedded editor only ever opens worktrees the user set up in Orca, so
    // Workspace Trust prompts are pure friction. Use code-server's native CLI
    // flag rather than product.json's configurationDefaults, which code-server's
    // server-side does not honor (verified: verifySignature=false there had no
    // effect). The flag applies per session, and we spawn fresh every time.
    '--disable-workspace-trust',
    '--user-data-dir',
    getCodeServerUserDataDir(),
    '--extensions-dir',
    getCodeServerExtensionsDir()
  ]
}

async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to allocate a port'))
        return
      }
      const { port } = address
      server.close(() => resolve(port))
    })
  })
}

async function waitForHealthz(port: number, isChildAlive: () => boolean): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() <= deadline) {
    // Stop immediately if the process died during startup; the wait would
    // otherwise burn the full cap polling a port nothing is listening on.
    if (!isChildAlive()) {
      return false
    }
    const ok = await probeHealthz(port)
    if (ok) {
      return true
    }
    await new Promise((r) => setTimeout(r, READY_POLL_MS))
  }
  return false
}

function probeHealthz(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const request = net.request(`http://127.0.0.1:${port}/healthz`)
    request.on('response', (response) => {
      response.on('data', () => {})
      response.on('end', () => resolve(response.statusCode === 200))
    })
    request.on('error', () => resolve(false))
    request.end()
  })
}

export type CodeServerProvider = {
  acquire(): Promise<{ port: number }>
  retry(): Promise<{ port: number }>
  release(): void
  getStatus(): CodeServerStatusEvent
  onStatusChanged(cb: (e: CodeServerStatusEvent) => void): () => void
  shutdown(): Promise<void>
}

export class CodeServerManager implements CodeServerProvider {
  private child: ReturnType<typeof spawnProcess> | null = null
  private port: number | null = null
  private refCount = 0
  private quitting = false
  // Reachable 'not-installed' start state (fix: was hardcoded 'stopped', hiding the
  // real state machine's entry point from callers that check status before acquire()).
  private status: CodeServerStatus = resolveCodeServerExecutable() ? 'stopped' : 'not-installed'
  private errorMessage: string | undefined
  private readonly listeners = new Set<(e: CodeServerStatusEvent) => void>()
  // Single-flight guard: overlapping acquire() calls before the first reaches 'ready'
  // must share one start sequence, or each spawns its own untracked child process.
  private starting: Promise<{ port: number }> | null = null

  onStatusChanged(cb: (e: CodeServerStatusEvent) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  getStatus(): CodeServerStatusEvent {
    return { status: this.status, port: this.port, error: this.errorMessage }
  }

  private emit(status: CodeServerStatus, extra?: { progress?: number; error?: string }): void {
    this.status = status
    this.errorMessage = extra?.error
    const event: CodeServerStatusEvent = {
      status,
      port: this.port,
      executionHostId: 'local',
      ...extra
    }
    for (const listener of this.listeners) {
      listener(event)
    }
  }

  async acquire(): Promise<{ port: number }> {
    this.refCount += 1
    if (this.child && this.port && this.status === 'ready') {
      return { port: this.port }
    }
    // Overlapping callers (e.g. session restore reopening several tabs) share this one
    // in-flight start instead of each racing startProcess() and leaking a child.
    if (!this.starting) {
      this.starting = this.startSequence().finally(() => {
        this.starting = null
      })
    }
    try {
      return await this.starting
    } catch (error) {
      this.refCount = Math.max(0, this.refCount - 1)
      throw error
    }
  }

  // Re-drive a start after a failure WITHOUT taking a ref. The pane already
  // holds exactly one ref from mount; a second acquire here would inflate
  // refCount so release() never reaches 0 and the shared server would never
  // stop when the last vscode tab closes. Shares the single-flight guard so a
  // concurrent acquire and retry don't spawn two children.
  async retry(): Promise<{ port: number }> {
    if (this.child && this.port && this.status === 'ready') {
      return { port: this.port }
    }
    if (!this.starting) {
      this.starting = this.startSequence().finally(() => {
        this.starting = null
      })
    }
    return this.starting
  }

  private async startSequence(): Promise<{ port: number }> {
    try {
      this.reapOrphan()
      // Only pass through 'installing' when an install will actually happen;
      // otherwise a normal start flashes "installing 0%" for an already-installed binary.
      if (!resolveCodeServerExecutable()) {
        this.emit('installing', { progress: 0 })
        await ensureCodeServerInstalled((fraction) =>
          this.emit('installing', { progress: fraction })
        )
      }
      await mirrorVsCodeUserConfig()
      // Open VSX + macOS standalone can't verify extension signatures; default
      // the check off for the embedded editor so extension installs work.
      await disableExtensionSignatureVerification()
      const port = await this.startProcessWithOneRetry()
      return { port }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.emit('error', { error: message })
      throw error
    }
  }

  // One automatic retry before surfacing an error. A slow first start is
  // force-killed at the shorter READY_TIMEOUT_MS; a fresh spawn then hits the
  // now-warm binary cache (macOS Gatekeeper scan, first-run cache) and usually
  // succeeds. This mirrors the manual Retry button's re-drive, so the user only
  // lands on the error state after two failed attempts. startProcess re-emits
  // 'starting' on the retry, so the UI stays on the loader rather than flashing.
  private async startProcessWithOneRetry(): Promise<number> {
    try {
      return await this.startProcess()
    } catch {
      return await this.startProcess()
    }
  }

  private async startProcess(): Promise<number> {
    const exe = await ensureCodeServerInstalled()
    const port = await pickFreePort()
    this.emit('starting')
    // Extensions in the embedded editor shell out to the user's toolchain
    // (e.g. rubocop runs `bundle list`), which needs the login-shell PATH so
    // version-manager tools resolve the same way the user's terminal does. A
    // GUI-launched Orca inherits launchd's sparse PATH, so hydrate it (memoized)
    // first. Windows has no POSIX login shell; hydrateShellPath no-ops there.
    const hydration = await hydrateShellPath()
    if (hydration.ok) {
      mergePathSegments(hydration.segments)
    }
    // The shared extension host serves every worktree and never re-runs the
    // shell's per-directory hook, so promote version-manager shims ahead of the
    // shell-activated resolved-version dirs, otherwise a worktree pinning a
    // non-default Ruby/Node runs the wrong one. POSIX-only concern.
    //
    // VSCODE_CLI=1 stops the server from re-probing the user's login shell to
    // build the extension host's environment; that probe would otherwise
    // overwrite our shims-promoted PATH with the mise/asdf-activated one
    // (installs/<tool>/latest ahead of shims), re-breaking per-worktree tool
    // resolution. code-server's CLI rejects the equivalent --force-disable-user-env
    // flag, but the server honors this env var. Windows already skips the probe.
    const spawnEnv =
      process.platform === 'win32'
        ? process.env
        : { ...process.env, VSCODE_CLI: '1', PATH: promoteVersionManagerShims(process.env.PATH) }
    const child = spawnProcess({
      program: exe,
      args: buildCodeServerArgs(port),
      stdio: ['ignore', 'ignore', 'pipe'],
      env: spawnEnv
    })
    this.child = child
    this.port = port
    mkdirSync(getCodeServerCacheRoot(), { recursive: true })
    writeFileSync(getCodeServerPidFilePath(), String(child.pid ?? ''))
    // Publish the pid so the memory collector can attribute the editor's whole
    // process subtree (extension host, LSPs, ripgrep) to Orca's footprint.
    setCodeServerPid(child.pid ?? null)
    let exited = false
    child.on('exit', () => {
      exited = true
      this.handleUnexpectedExit()
    })

    let stderrTail = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_MAX_BYTES)
    })

    const ready = await waitForHealthz(port, () => !exited)
    if (!ready) {
      this.killChild()
      const detail = stderrTail.trim()
      throw new Error(
        detail
          ? `code-server did not become ready in time: ${detail}`
          : 'code-server did not become ready in time'
      )
    }
    this.emit('ready')
    return port
  }

  private handleUnexpectedExit(): void {
    this.child = null
    this.port = null
    setCodeServerPid(null)
    // An exit before the server ever reached 'ready' is a failed start: the
    // awaiting startProcess() reports it as an error, so don't auto-restart
    // here (which would race that caller and can loop). Only a server that
    // had gone healthy and later crashed should be revived.
    if (this.status !== 'ready') {
      return
    }
    if (this.quitting || this.refCount <= 0) {
      this.emit('stopped')
      return
    }
    // Crash while tabs are open; auto-restart.
    void this.startProcess().catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      this.emit('error', { error: message })
    })
  }

  release(): void {
    this.refCount = Math.max(0, this.refCount - 1)
    if (this.refCount === 0) {
      this.killChild()
      this.emit('stopped')
    }
  }

  private killChild(): void {
    const child = this.child
    this.child = null
    this.port = null
    setCodeServerPid(null)
    if (child && !child.killed) {
      child.removeAllListeners('exit')
      child.kill('SIGTERM')
    }
    try {
      rmSync(getCodeServerPidFilePath(), { force: true })
    } catch {
      // best effort
    }
  }

  async shutdown(): Promise<void> {
    this.quitting = true
    this.killChild()
  }

  // Kill a stale process from a prior Orca run recorded in the pidfile.
  reapOrphan(): void {
    const pidFile = getCodeServerPidFilePath()
    if (!existsSync(pidFile)) {
      return
    }
    try {
      const pid = Number(readFileSync(pidFile, 'utf8').trim())
      if (Number.isInteger(pid) && pid > 0) {
        process.kill(pid, 'SIGTERM')
      }
    } catch {
      // process already gone or not ours; ignore
    } finally {
      try {
        rmSync(pidFile, { force: true })
      } catch {
        // best effort
      }
    }
  }
}
