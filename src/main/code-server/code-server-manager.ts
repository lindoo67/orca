import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import type {
  CodeServerStatus,
  CodeServerStatusEvent,
  CodeServerUpdateDecision
} from '../../shared/code-server-types'
import { spawnProcess } from '@orca/process-host'
import { forceTerminateProcessTree } from '@orca/process-host/process-tree-termination'
import {
  discardFailedCodeServer,
  ensureCodeServerInstalled,
  markCodeServerHealthy
} from './code-server-installer'
import { getCodeServerResourceManager } from './code-server-resource-manager'
import { codeServerResourceTarget } from './code-server-resource-catalog'
import { recordIgnoredCodeServerRelease } from './code-server-release-resolver'
import { mirrorVsCodeUserConfig } from './code-server-vscode-user-config'
import { disableExtensionSignatureVerification } from './code-server-signature-verification'
import { reapOrphanCodeServerProcess, setCodeServerPid } from './code-server-process-registry'
import { resolveCodeServerSpawnEnv } from './code-server-toolchain-path'
import {
  getCodeServerCacheRoot,
  getCodeServerPidFilePath,
  resolveCodeServerExecutable
} from './code-server-paths'

import { buildCodeServerArgs } from './code-server-args'
import { pickFreePort } from './code-server-free-port'
import { waitForHealthz } from './code-server-health-probe'

export { buildCodeServerArgs }

// Cap retained stderr so a chatty code-server can't grow this unbounded while running.
const STDERR_TAIL_MAX_BYTES = 8 * 1024

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
  private currentVersion: string | undefined
  private availableVersion: string | undefined
  private pendingUpdateDecision: {
    resolve: (decision: CodeServerUpdateDecision) => void
    reject: (error: Error) => void
  } | null = null
  private readonly listeners = new Set<(e: CodeServerStatusEvent) => void>()
  // Single-flight guard: overlapping acquire() calls before the first reaches 'ready'
  // must share one start sequence, or each spawns its own untracked child process.
  private starting: Promise<{ port: number }> | null = null

  onStatusChanged(cb: (e: CodeServerStatusEvent) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  getStatus(): CodeServerStatusEvent {
    return {
      status: this.status,
      port: this.port,
      error: this.errorMessage,
      currentVersion: this.currentVersion,
      availableVersion: this.availableVersion
    }
  }

  private emit(
    status: CodeServerStatus,
    extra?: {
      progress?: number
      error?: string
      currentVersion?: string
      availableVersion?: string
    }
  ): void {
    this.status = status
    this.errorMessage = extra?.error
    this.currentVersion = extra?.currentVersion ?? this.currentVersion
    this.availableVersion = extra?.availableVersion ?? this.availableVersion
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

  async decideUpdate(decision: CodeServerUpdateDecision): Promise<void> {
    if (this.pendingUpdateDecision) {
      const pending = this.pendingUpdateDecision
      this.pendingUpdateDecision = null
      pending.resolve(decision)
    }
  }

  private async startSequence(): Promise<{ port: number }> {
    try {
      this.reapOrphan()
      const update = await getCodeServerResourceManager().checkForUpdate(
        process.platform,
        process.arch
      )
      let skipUpdate = false
      if (update) {
        this.emit('update-available', {
          currentVersion: update.currentVersion,
          availableVersion: update.availableVersion
        })
        const decision = await new Promise<CodeServerUpdateDecision>((resolve, reject) => {
          this.pendingUpdateDecision = { resolve, reject }
        })
        this.pendingUpdateDecision = null
        if (!decision.proceed) {
          skipUpdate = true
          if (decision.ignoreVersion) {
            await recordIgnoredCodeServerRelease(
              codeServerResourceTarget(process.platform, process.arch),
              update.availableVersion
            )
          }
        }
      }
      const installed = await ensureCodeServerInstalled(
        (fraction) => this.emit('installing', { progress: fraction }),
        { skipUpdate }
      )
      await mirrorVsCodeUserConfig()
      // Open VSX + macOS standalone can't verify extension signatures; default
      // the check off for the embedded editor so extension installs work.
      await disableExtensionSignatureVerification()
      let port: number
      try {
        port = await this.startProcessWithOneRetry(installed.executable)
        await markCodeServerHealthy(installed.version)
      } catch (error) {
        if (!installed.previousExecutable) {
          throw error
        }
        console.warn(
          `[code-server] Failed to start Embedded VS Code ${installed.version}; falling back to ${installed.previousVersion}:`,
          error
        )
        await discardFailedCodeServer(installed.version)
        port = await this.startProcessWithOneRetry(installed.previousExecutable)
        await markCodeServerHealthy(installed.previousVersion)
      }
      return { port }
    } catch (error) {
      if (
        this.status === 'stopped' ||
        (error instanceof Error && error.message === 'Code-server launch cancelled')
      ) {
        throw error
      }
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
  private async startProcessWithOneRetry(executable?: string): Promise<number> {
    try {
      return await this.startProcess(executable)
    } catch {
      return await this.startProcess(executable)
    }
  }

  private async startProcess(executable?: string): Promise<number> {
    const exe = executable ?? (await ensureCodeServerInstalled()).executable
    const port = await pickFreePort()
    this.emit('starting')
    const spawnEnv = await resolveCodeServerSpawnEnv()
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
      const childToKill = this.child
      this.killChild()
      if (childToKill) {
        await forceTerminateProcessTree(childToKill).catch(() => undefined)
      }
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
      if (this.pendingUpdateDecision) {
        const pending = this.pendingUpdateDecision
        this.pendingUpdateDecision = null
        pending.reject(new Error('Code-server launch cancelled'))
      }
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
      void forceTerminateProcessTree(child).catch(() => undefined)
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
    reapOrphanCodeServerProcess()
  }
}
