import type {
  CodeServerStatusEvent,
  CodeServerUpdateDecision,
  CodeServerWorkspaceRequest,
  CodeServerWorkspaceResult
} from '../../shared/code-server-types'

export type CodeServerApi = {
  ensureRunning: (request?: CodeServerWorkspaceRequest) => Promise<CodeServerWorkspaceResult>
  retry: (request?: CodeServerWorkspaceRequest) => Promise<CodeServerWorkspaceResult>
  release: (request?: CodeServerWorkspaceRequest) => Promise<void>
  getStatus: () => Promise<CodeServerStatusEvent>
  onStatusChanged: (callback: (event: CodeServerStatusEvent) => void) => () => void
  decideUpdate: (
    request: CodeServerWorkspaceRequest,
    decision: CodeServerUpdateDecision
  ) => Promise<{ ok: boolean } | { error: string }>
}
