import { CodeServerManager, type CodeServerProvider } from './code-server-manager'
import { parseExecutionHostId } from '../../shared/execution-host'
import type { CodeServerWorkspaceRequest } from '../../shared/code-server-types'
import { RemoteCodeServerManager } from './remote-code-server-manager'

type CodeServerService = CodeServerProvider & {
  acquire(request?: CodeServerWorkspaceRequest): Promise<{ port: number }>
  retry(request?: CodeServerWorkspaceRequest): Promise<{ port: number }>
  release(request?: CodeServerWorkspaceRequest): void | Promise<void>
  isAdmissiblePort(port: number): boolean
}

class WorkspaceCodeServerService implements CodeServerService {
  private readonly local = new CodeServerManager()
  private readonly remote = new RemoteCodeServerManager()

  onStatusChanged(cb: Parameters<CodeServerProvider['onStatusChanged']>[0]): () => void {
    return this.local.onStatusChanged(cb)
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
    throw new Error('Embedded VS Code is not available for runtime workspaces yet.')
  }

  retry(request?: CodeServerWorkspaceRequest): Promise<{ port: number }> {
    const parsed = parseExecutionHostId(request?.executionHostId)
    if (!parsed || parsed.kind === 'local') {
      return this.local.retry()
    }
    if (parsed.kind === 'ssh') {
      return this.remote.retry({ executionHostId: parsed.id })
    }
    throw new Error('Embedded VS Code is not available for runtime workspaces yet.')
  }

  release(request?: CodeServerWorkspaceRequest): void | Promise<void> {
    const parsed = parseExecutionHostId(request?.executionHostId)
    if (!parsed || parsed.kind === 'local') {
      return this.local.release()
    }
    if (parsed.kind === 'ssh') {
      return this.remote.release({ executionHostId: parsed.id })
    }
  }

  isAdmissiblePort(port: number): boolean {
    const localStatus = this.local.getStatus()
    return (
      (localStatus.status === 'ready' && localStatus.port === port) ||
      this.remote.isAdmissiblePort(port)
    )
  }

  async shutdown(): Promise<void> {
    await Promise.all([this.local.shutdown(), this.remote.shutdown()])
  }
}

let manager: CodeServerService | null = null

export function getCodeServerService(): CodeServerService {
  if (!manager) {
    manager = new WorkspaceCodeServerService()
  }
  return manager
}
