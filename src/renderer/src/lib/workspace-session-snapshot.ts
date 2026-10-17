import type { AppState } from '../store'

export type WorkspaceSessionSnapshot = Pick<
  AppState,
  | 'activeRepoId'
  | 'activeWorkspaceKey'
  | 'activeWorktreeId'
  | 'activeTabId'
  | 'tabsByWorktree'
  | 'ptyIdsByTabId'
  | 'terminalLayoutsByTabId'
  | 'localOnlyScrollbackByTabId'
  | 'activeTabIdByWorktree'
  | 'openFiles'
  | 'editorDrafts'
  | 'markdownFrontmatterVisible'
  | 'activeFileIdByWorktree'
  | 'activeTabTypeByWorktree'
  | 'browserTabsByWorktree'
  | 'browserPagesByWorkspace'
  | 'activeBrowserTabIdByWorktree'
  | 'codeServerTabsByWorktree'
  | 'activeCodeServerTabIdByWorktree'
  | 'browserUrlHistory'
  | 'workspaceDocHistory'
  | 'remoteBrowserPageHandlesByPageId'
  | 'unifiedTabsByWorktree'
  | 'groupsByWorktree'
  | 'layoutByWorktree'
  | 'activeGroupIdByWorktree'
  | 'sshConnectionStates'
  | 'repos'
  | 'worktreesByRepo'
  | 'lastKnownRelayPtyIdByTabId'
  | 'lastVisitedAtByWorktreeId'
  | 'defaultTerminalTabsAppliedByWorktreeId'
> & {
  activeWorkspaceExecutionHostId?: AppState['activeWorkspaceExecutionHostId']
  sleepingAgentSessionsByPaneKey?: AppState['sleepingAgentSessionsByPaneKey']
  clientHostedBrowserCloseIntentsByEnvironment?: AppState['clientHostedBrowserCloseIntentsByEnvironment']
  /** Optional so the many partial snapshot fixtures keep type-checking; see buildTerminalSessionData. */
  pendingReconnectPtyIdByTabId?: AppState['pendingReconnectPtyIdByTabId']
  deferredSshSessionIdsByTabId?: AppState['deferredSshSessionIdsByTabId']
}

// Why: shallow-equality gate for the debounced session writer; _exhaustive below keeps it in sync with the snapshot type.
export const SESSION_RELEVANT_FIELDS = [
  'activeRepoId',
  'activeWorkspaceKey',
  'activeWorkspaceExecutionHostId',
  'activeWorktreeId',
  'activeTabId',
  'tabsByWorktree',
  'ptyIdsByTabId',
  'terminalLayoutsByTabId',
  'localOnlyScrollbackByTabId',
  'activeTabIdByWorktree',
  'openFiles',
  'editorDrafts',
  'markdownFrontmatterVisible',
  'activeFileIdByWorktree',
  'activeTabTypeByWorktree',
  'browserTabsByWorktree',
  'browserPagesByWorkspace',
  'activeBrowserTabIdByWorktree',
  'codeServerTabsByWorktree',
  'activeCodeServerTabIdByWorktree',
  'browserUrlHistory',
  'workspaceDocHistory',
  'remoteBrowserPageHandlesByPageId',
  'unifiedTabsByWorktree',
  'groupsByWorktree',
  'layoutByWorktree',
  'activeGroupIdByWorktree',
  'sshConnectionStates',
  'repos',
  'worktreesByRepo',
  'lastKnownRelayPtyIdByTabId',
  'lastVisitedAtByWorktreeId',
  'defaultTerminalTabsAppliedByWorktreeId',
  'sleepingAgentSessionsByPaneKey',
  'clientHostedBrowserCloseIntentsByEnvironment',
  'pendingReconnectPtyIdByTabId',
  'deferredSshSessionIdsByTabId'
] as const satisfies readonly (keyof WorkspaceSessionSnapshot)[]

type MissingSessionField = Exclude<
  keyof WorkspaceSessionSnapshot,
  (typeof SESSION_RELEVANT_FIELDS)[number]
>
void (true satisfies [MissingSessionField] extends [never] ? true : never)
