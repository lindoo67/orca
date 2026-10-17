import { getAppEnvironment } from '../../shared/app-environment'
import {
  CODE_SERVER_ATTACH_METHOD,
  CODE_SERVER_RUNTIME_CAPABILITY,
  CodeServerAttachEvent
} from '../../shared/code-server-runtime-contract'
import type {
  CodeServerStatusEvent,
  CodeServerWorkspaceRequest
} from '../../shared/code-server-types'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../shared/electron-remote-runtime-client-capabilities'
import { parseExecutionHostId } from '../../shared/execution-host'
import { resolveEnvironment } from '../../shared/runtime-environment-store'
import { getPreferredPairedRuntimeConnection } from '../../shared/runtime-environments'
import {
  sendRemoteRuntimeRequestWithStatusPreflight,
  subscribeRemoteRuntimeRequest,
  type RemoteRuntimeSubscription
} from '../../shared/remote-runtime-client'
import { BrowserNetworkTunnelClient } from '../browser/browser-network-tunnel-client'
import { CodeServerTcpTunnel } from './code-server-tcp-tunnel'

type RuntimeCodeServerResource = {
  subscription: RemoteRuntimeSubscription
  tunnel: BrowserNetworkTunnelClient
  listener: CodeServerTcpTunnel
  localPort: number
}

type RuntimeCodeServerEntry = {
  environmentId: string
  executionHostId: string
  refCount: number
  starting: Promise<{ port: number }> | null
  resource: RuntimeCodeServerResource | null
  disposed: boolean
}

export class RuntimeCodeServerManager {
  private readonly entries = new Map<string, RuntimeCodeServerEntry>()
  private readonly admissiblePorts = new Set<number>()
  private readonly listeners = new Set<(event: CodeServerStatusEvent) => void>()

  onStatusChanged(listener: (event: CodeServerStatusEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async acquire(request: CodeServerWorkspaceRequest): Promise<{ port: number }> {
    const identity = this.requireRuntime(request)
    let entry = this.entries.get(identity.environmentId)
    if (!entry) {
      entry = {
        ...identity,
        refCount: 0,
        starting: null,
        resource: null,
        disposed: false
      }
      this.entries.set(identity.environmentId, entry)
    }
    entry.refCount += 1
    if (entry.resource) {
      return { port: entry.resource.localPort }
    }
    try {
      return await this.ensureStarted(entry)
    } catch (error) {
      entry.refCount = Math.max(0, entry.refCount - 1)
      if (entry.refCount === 0) {
        await this.disposeEntry(entry)
      }
      throw error
    }
  }

  async retry(request: CodeServerWorkspaceRequest): Promise<{ port: number }> {
    const identity = this.requireRuntime(request)
    const entry = this.entries.get(identity.environmentId)
    if (entry?.resource) {
      return { port: entry.resource.localPort }
    }
    if (entry) {
      return this.ensureStarted(entry)
    }
    const created: RuntimeCodeServerEntry = {
      ...identity,
      refCount: 1,
      starting: null,
      resource: null,
      disposed: false
    }
    this.entries.set(identity.environmentId, created)
    return this.ensureStarted(created)
  }

  async release(request: CodeServerWorkspaceRequest): Promise<void> {
    const { environmentId } = this.requireRuntime(request)
    const entry = this.entries.get(environmentId)
    if (!entry) {
      return
    }
    entry.refCount = Math.max(0, entry.refCount - 1)
    if (entry.refCount === 0) {
      await this.disposeEntry(entry)
    }
  }

  isAdmissiblePort(port: number): boolean {
    return this.admissiblePorts.has(port)
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.entries.values()].map((entry) => this.disposeEntry(entry)))
  }

  private ensureStarted(entry: RuntimeCodeServerEntry): Promise<{ port: number }> {
    entry.disposed = false
    entry.starting ??= this.start(entry).finally(() => {
      entry.starting = null
    })
    return entry.starting
  }

  private async start(entry: RuntimeCodeServerEntry): Promise<{ port: number }> {
    this.emit(entry, { status: 'starting', port: null })
    const userDataPath = getAppEnvironment().getPath('userData')
    const environment = resolveEnvironment(userDataPath, entry.environmentId)
    const connection = getPreferredPairedRuntimeConnection(environment)
    await sendRemoteRuntimeRequestWithStatusPreflight(
      connection,
      'status.get',
      undefined,
      15_000,
      (status) => {
        if (!status.ok || !status.result.capabilities?.includes(CODE_SERVER_RUNTIME_CAPABILITY)) {
          throw new Error('The remote Orca server must be updated to use embedded VS Code.')
        }
      },
      undefined,
      ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
    )

    const active: {
      subscription: RemoteRuntimeSubscription | null
      tunnel: BrowserNetworkTunnelClient | null
      listener: CodeServerTcpTunnel | null
    } = { subscription: null, tunnel: null, listener: null }
    let settled = false
    let resolveReady = (_value: { port: number }): void => {}
    let rejectReady = (_error: Error): void => {}
    const ready = new Promise<{ port: number }>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    const fail = (error: Error): void => {
      if (!settled) {
        settled = true
        rejectReady(error)
      } else if (!entry.disposed) {
        this.emit(entry, { status: 'error', port: null, error: error.message })
      }
    }
    active.subscription = await subscribeRemoteRuntimeRequest(
      connection,
      CODE_SERVER_ATTACH_METHOD,
      {},
      60_000,
      {
        onResponse: (response) => {
          if (!response.ok) {
            fail(new Error(response.error.message))
            return
          }
          const event = CodeServerAttachEvent.safeParse(response.result)
          if (!event.success) {
            fail(new Error('The remote Orca server returned an invalid VS Code response.'))
            return
          }
          if (event.data.type === 'closed') {
            fail(new Error('The remote VS Code tunnel closed.'))
            return
          }
          if (active.tunnel) {
            return
          }
          const remotePort = event.data.port
          active.tunnel = new BrowserNetworkTunnelClient({
            tunnelGeneration: event.data.tunnelGeneration,
            sendBinary: (bytes) => active.subscription?.sendBinary(bytes) ?? false,
            onClosed: (error) => fail(error)
          })
          active.listener = new CodeServerTcpTunnel(() =>
            active.tunnel!.open({ host: '127.0.0.1', port: remotePort })
          )
          void active.listener.listen().then(
            (port) => {
              if (!settled) {
                settled = true
                resolveReady({ port })
              }
            },
            (error: unknown) => fail(asError(error))
          )
        },
        onBinary: (bytes) => active.tunnel?.handleBinary(bytes),
        onError: (error) => fail(error),
        onClose: () => fail(new Error('The remote VS Code connection closed.'))
      },
      {
        perMessageDeflate: false,
        clientCapabilities: ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
      }
    )
    try {
      const result = await ready
      if (!active.subscription || !active.tunnel || !active.listener || entry.disposed) {
        throw new Error('The remote VS Code connection closed during startup.')
      }
      entry.resource = {
        subscription: active.subscription,
        tunnel: active.tunnel,
        listener: active.listener,
        localPort: result.port
      }
      this.admissiblePorts.add(result.port)
      this.emit(entry, { status: 'ready', port: result.port })
      return result
    } catch (error) {
      active.subscription?.close()
      active.tunnel?.close()
      await active.listener?.close().catch(() => {})
      const failure = asError(error)
      this.emit(entry, { status: 'error', port: null, error: failure.message })
      throw failure
    }
  }

  private async disposeEntry(entry: RuntimeCodeServerEntry): Promise<void> {
    entry.disposed = true
    this.entries.delete(entry.environmentId)
    const resource = entry.resource
    entry.resource = null
    if (resource) {
      this.admissiblePorts.delete(resource.localPort)
      resource.subscription.close()
      resource.tunnel.close()
      await resource.listener.close().catch(() => {})
    }
    this.emit(entry, { status: 'stopped', port: null })
  }

  private requireRuntime(request: CodeServerWorkspaceRequest): {
    environmentId: string
    executionHostId: string
  } {
    const parsed = parseExecutionHostId(request.executionHostId)
    if (parsed?.kind !== 'runtime') {
      throw new Error('Runtime code-server requires a paired runtime execution host.')
    }
    return { environmentId: parsed.environmentId, executionHostId: parsed.id }
  }

  private emit(entry: RuntimeCodeServerEntry, event: CodeServerStatusEvent): void {
    const scoped = { ...event, executionHostId: entry.executionHostId }
    for (const listener of this.listeners) {
      listener(scoped)
    }
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
