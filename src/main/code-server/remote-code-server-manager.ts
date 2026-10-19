import { parseExecutionHostId, toSshExecutionHostId } from '../../shared/execution-host'
import type {
  CodeServerStatusEvent,
  CodeServerWorkspaceRequest
} from '../../shared/code-server-types'
import { connectionManager, portForwardManager } from '../ipc/ssh-ipc-context'
import { detectRemoteHostPlatform } from '../ssh/ssh-remote-platform-detection'
import { RemoteCodeServerDeployment } from './remote-code-server-deployment'
import {
  pickFreePort,
  randomRemotePort,
  startRemoteCodeServer,
  stopRemoteCodeServer,
  waitForLocalHealthz
} from './remote-code-server-ssh'

const REMOTE_START_ATTEMPTS = 5

type RemoteCodeServerEntry = {
  targetId: string
  localPort: number
  remotePort: number
  forwardId: string
  pid: string | null
  refCount: number
  starting: Promise<{ port: number }> | null
}

export class RemoteCodeServerManager {
  private readonly entries = new Map<string, RemoteCodeServerEntry>()
  private readonly admissiblePorts = new Set<number>()
  private readonly listeners = new Set<(event: CodeServerStatusEvent) => void>()

  onStatusChanged(listener: (event: CodeServerStatusEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async acquire(request: CodeServerWorkspaceRequest): Promise<{ port: number }> {
    const targetId = this.requireSshTargetId(request)
    let entry = this.entries.get(targetId)
    if (entry && this.admissiblePorts.has(entry.localPort)) {
      entry.refCount += 1
      return { port: entry.localPort }
    }
    if (!entry) {
      entry = {
        targetId,
        localPort: 0,
        remotePort: 0,
        forwardId: '',
        pid: null,
        refCount: 0,
        starting: null
      }
      this.entries.set(targetId, entry)
    }
    entry.refCount += 1
    if (!entry.starting) {
      entry.starting = this.start(targetId, entry).finally(() => {
        entry.starting = null
      })
    }
    try {
      return await entry.starting
    } catch (error) {
      entry.refCount = Math.max(0, entry.refCount - 1)
      this.emit(targetId, {
        status: 'error',
        port: null,
        error: error instanceof Error ? error.message : String(error)
      })
      if (entry.refCount === 0) {
        await this.disposeEntry(entry)
      }
      throw error
    }
  }

  async retry(request: CodeServerWorkspaceRequest): Promise<{ port: number }> {
    const targetId = this.requireSshTargetId(request)
    const entry = this.entries.get(targetId)
    if (entry && this.admissiblePorts.has(entry.localPort)) {
      return { port: entry.localPort }
    }
    return this.acquire(request)
  }

  async release(request: CodeServerWorkspaceRequest): Promise<void> {
    const targetId = this.requireSshTargetId(request)
    const entry = this.entries.get(targetId)
    if (!entry) {
      return
    }
    entry.refCount = Math.max(0, entry.refCount - 1)
    if (entry.refCount === 0) {
      await this.disposeEntry(entry)
      this.emit(targetId, { status: 'stopped', port: null })
    }
  }

  isAdmissiblePort(port: number): boolean {
    return this.admissiblePorts.has(port)
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.entries.values()].map((entry) => this.disposeEntry(entry)))
  }

  private async start(targetId: string, entry: RemoteCodeServerEntry): Promise<{ port: number }> {
    console.log(`[code-server:ssh] starting target=${targetId}`)
    const conn = connectionManager?.getConnection(targetId)
    if (!conn) {
      throw new Error(`SSH connection "${targetId}" is not connected`)
    }
    const platform = await detectRemoteHostPlatform(conn)
    if (!platform) {
      throw new Error(`SSH host "${targetId}" has not reported its platform yet`)
    }
    if (platform.os !== 'linux') {
      throw new Error('Embedded VS Code over SSH currently supports Linux hosts only.')
    }
    console.log(`[code-server:ssh] target=${targetId} platform=${platform.relayPlatform}`)
    const deployment = new RemoteCodeServerDeployment((event) => this.emit(targetId, event))
    const bundle = await deployment.ensure(conn, platform)
    const localPort = await pickFreePort()
    for (let attempt = 0; attempt < REMOTE_START_ATTEMPTS; attempt += 1) {
      const remotePort = randomRemotePort()
      console.log(
        `[code-server:ssh] target=${targetId} forward local=${localPort} remote=${remotePort}`
      )
      const forward = await portForwardManager?.addForward(
        targetId,
        conn,
        localPort,
        '127.0.0.1',
        remotePort,
        'Orca VS Code'
      )
      if (!forward) {
        throw new Error('SSH port forwarding is not available')
      }
      try {
        this.emit(targetId, { status: 'starting', port: null })
        const pid = await startRemoteCodeServer(conn, platform, bundle.remoteRoot, remotePort)
        console.log(`[code-server:ssh] target=${targetId} remote pid=${pid}`)
        const ready = await waitForLocalHealthz(localPort)
        if (ready) {
          entry.localPort = localPort
          entry.remotePort = remotePort
          entry.forwardId = forward.id
          entry.pid = pid
          this.admissiblePorts.add(localPort)
          console.log(`[code-server:ssh] ready target=${targetId} local=${localPort}`)
          this.emit(targetId, { status: 'ready', port: localPort })
          void deployment.markHealthy(conn, bundle).catch(() => undefined)
          return { port: localPort }
        }
        console.warn(`[code-server:ssh] health check timed out target=${targetId}`)
        await stopRemoteCodeServer(conn, pid)
      } catch (error) {
        console.warn(
          `[code-server:ssh] start attempt failed target=${targetId}: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
        if (attempt + 1 >= REMOTE_START_ATTEMPTS) {
          if (await deployment.rollBackFailedStart(conn, bundle)) {
            attempt = -1
            continue
          }
          throw error
        }
      } finally {
        if (!this.admissiblePorts.has(localPort)) {
          await portForwardManager?.removeForwardAndWait(forward.id)
        }
      }
    }
    throw new Error('Remote code-server did not become ready in time')
  }

  private emit(targetId: string, event: CodeServerStatusEvent): void {
    const scoped = { ...event, executionHostId: toSshExecutionHostId(targetId) }
    for (const listener of this.listeners) {
      listener(scoped)
    }
  }

  private requireSshTargetId(request: CodeServerWorkspaceRequest): string {
    const parsed = parseExecutionHostId(request.executionHostId)
    if (parsed?.kind !== 'ssh') {
      throw new Error('Remote code-server requires an SSH execution host')
    }
    return parsed.targetId
  }

  private async disposeEntry(entry: RemoteCodeServerEntry): Promise<void> {
    this.entries.delete(entry.targetId)
    this.admissiblePorts.delete(entry.localPort)
    if (entry.forwardId) {
      await portForwardManager?.removeForwardAndWait(entry.forwardId)
    }
    const conn = connectionManager?.getConnection(entry.targetId)
    if (conn && entry.pid) {
      await stopRemoteCodeServer(conn, entry.pid).catch(() => undefined)
    }
  }
}
