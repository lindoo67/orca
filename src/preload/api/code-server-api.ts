import type {
  CodeServerStatusEvent,
  CodeServerWorkspaceRequest,
  CodeServerWorkspaceResult
} from '../../shared/code-server-types'

export type CodeServerApi = {
  ensureRunning: (request?: CodeServerWorkspaceRequest) => Promise<CodeServerWorkspaceResult>
  retry: (request?: CodeServerWorkspaceRequest) => Promise<CodeServerWorkspaceResult>
  release: (request?: CodeServerWorkspaceRequest) => Promise<void>
  getStatus: () => Promise<CodeServerStatusEvent>
  onStatusChanged: (callback: (event: CodeServerStatusEvent) => void) => () => void
}
