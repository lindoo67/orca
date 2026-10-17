import { CodeServerManager, type CodeServerProvider } from './code-server-manager'
import { parseExecutionHostId } from '../../shared/execution-host'
import type { CodeServerWorkspaceRequest } from '../../shared/code-server-types'
import { RemoteCodeServerManager } from './remote-code-server-manager'
import { RuntimeCodeServerManager } from './runtime-code-server-manager'

type CodeServerService = CodeServerProvider & {
  acquire(request?: CodeServerWorkspaceRequest): Promise<{ port: number }>
  retry(request?: CodeServerWorkspaceRequest): Promise<{ port: number }>
  release(request?: CodeServerWorkspaceRequest): void | Promise<void>
  isAdmissiblePort(port: number): boolean
}

class WorkspaceCodeServerService implements CodeServerService {
  private readonly local = new CodeServerManager()
  private readonly remote = new RemoteCodeServerManager()
  private readonly runtime = new RuntimeCodeServerManager()

  onStatusChanged(cb: Parameters<CodeServerProvider['onStatusChanged']>[0]): () => void {
    const unsubscribeLocal = this.local.onStatusChanged(cb)
    const unsubscribeRuntime = this.runtime.onStatusChanged(cb)
    return () => {
      unsubscribeLocal()
      unsubscribeRuntime()
    }
  }

  getStatus(): ReturnType<CodeServerProvider['getStatus']> {
    return this.local.getStatus()
  }

  acquire(request?: CodeServerWorkspaceRequest): Promise<{ port: number }> {
    const parsed = parseExecutionHostId(request?.executionHostId)
    if (!parsed || parsed.kind === 'local') {
      return this.local.acquire()
    }
    if (parsed.kind === 'ssh') {
      return this.remote.acquire({ executionHostId: parsed.id })
    }
    return this.runtime.acquire({ executionHostId: parsed.id })
  }

  retry(request?: CodeServerWorkspaceRequest): Promise<{ port: number }> {
    const parsed = parseExecutionHostId(request?.executionHostId)
    if (!parsed || parsed.kind === 'local') {
      return this.local.retry()
    }
    if (parsed.kind === 'ssh') {
      return this.remote.retry({ executionHostId: parsed.id })
    }
    return this.runtime.retry({ executionHostId: parsed.id })
  }

  release(request?: CodeServerWorkspaceRequest): void | Promise<void> {
    const parsed = parseExecutionHostId(request?.executionHostId)
    if (!parsed || parsed.kind === 'local') {
      return this.local.release()
    }
    if (parsed.kind === 'ssh') {
      return this.remote.release({ executionHostId: parsed.id })
    }
    return this.runtime.release({ executionHostId: parsed.id })
  }

  isAdmissiblePort(port: number): boolean {
    const localStatus = this.local.getStatus()
    return (
      (localStatus.status === 'ready' && localStatus.port === port) ||
      this.remote.isAdmissiblePort(port) ||
      this.runtime.isAdmissiblePort(port)
    )
  }

  async shutdown(): Promise<void> {
    await Promise.all([this.local.shutdown(), this.remote.shutdown(), this.runtime.shutdown()])
  }
}

let manager: CodeServerService | null = null

export function getCodeServerService(): CodeServerService {
  if (!manager) {
    manager = new WorkspaceCodeServerService()
  }
  return manager
}
