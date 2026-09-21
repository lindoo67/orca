import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stubHeadlessReact } from '../tab-bar/tab-bar-windows-shell-launch-render-stubs'

const mocks = vi.hoisted(() => ({
  createTab: vi.fn(),
  setActiveTab: vi.fn(),
  setActiveTabType: vi.fn(),
  setActiveWorktree: vi.fn(),
  focusGroup: vi.fn(),
  createBrowserTab: vi.fn(),
  createEmptySplitGroup: vi.fn(),
  openNewBrowserTabInActiveWorkspace: vi.fn(),
  openNewMarkdownInActiveWorkspace: vi.fn(),
  openNewTerminalTabInActiveWorkspace: vi.fn(),
  createCodeServerTab: vi.fn(),
  getRuntimeEnvironmentIdForWorktree: vi.fn(),
  focusTerminalTabSurface: vi.fn(),
  createWebRuntimeSessionTerminal: vi.fn(),
  createWebRuntimeSessionBrowserTab: vi.fn(),
  isWebRuntimeSessionActive: vi.fn(),
  runtimeCall: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('react', async () => await stubHeadlessReact())

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: (_state: typeof storeState, worktreeId: string) =>
    worktreeId === SSH_WORKTREE_ID ? 'ssh:172.16.12.230' : 'local',
  getRuntimeEnvironmentIdForWorktree: mocks.getRuntimeEnvironmentIdForWorktree,
  getRuntimeSessionMirrorEnvironmentIds: () => []
}))

vi.mock('../../lib/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: mocks.focusTerminalTabSurface
}))

vi.mock('../../runtime/web-runtime-session', () => ({
  createWebRuntimeSessionTerminal: mocks.createWebRuntimeSessionTerminal,
  createWebRuntimeSessionBrowserTab: mocks.createWebRuntimeSessionBrowserTab,
  isWebRuntimeSessionActive: mocks.isWebRuntimeSessionActive
}))

vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError
  }
}))

const WORKTREE_ID = 'repo::C:/Users/neil/orca/workspaces/orca/aug23-triage'
const SSH_WORKTREE_ID = 'repo::/home/ubuntu/workspace/kcve'
const GROUP_ID = 'group-1'
const FOCUSED_ENVIRONMENT_ID = 'arch-dev'

const storeState = {
  settings: { activeRuntimeEnvironmentId: FOCUSED_ENVIRONMENT_ID },
  activeWorktreeId: WORKTREE_ID,
  activeWorkspaceExecutionHostId: 'local' as string | null,
  repos: [{ id: 'repo', connectionId: null, executionHostId: null }],
  worktreesByRepo: {
    repo: [
      {
        id: WORKTREE_ID,
        repoId: 'repo',
        path: 'C:/Users/neil/orca/workspaces/orca/aug23-triage'
      },
      {
        id: SSH_WORKTREE_ID,
        repoId: 'repo',
        path: '/home/ubuntu/workspace/kcve',
        hostId: 'ssh:172.16.12.230'
      }
    ]
  },
  detectedWorktreesByRepo: {},
  folderWorkspaces: [],
  browserTabsByWorktree: {},
  browserPagesByWorkspace: {},
  remoteBrowserPageHandlesByPageId: {},
  createTab: mocks.createTab,
  setActiveTab: mocks.setActiveTab,
  setActiveTabType: mocks.setActiveTabType,
  setActiveWorktree: mocks.setActiveWorktree,
  focusGroup: mocks.focusGroup,
  createBrowserTab: mocks.createBrowserTab,
  createEmptySplitGroup: mocks.createEmptySplitGroup,
  createCodeServerTab: mocks.createCodeServerTab,
  openNewBrowserTabInActiveWorkspace: mocks.openNewBrowserTabInActiveWorkspace,
  openNewMarkdownInActiveWorkspace: mocks.openNewMarkdownInActiveWorkspace,
  openNewTerminalTabInActiveWorkspace: mocks.openNewTerminalTabInActiveWorkspace,
  getKnownWorktreeById: (worktreeId: string) =>
    storeState.worktreesByRepo.repo.find((worktree) => worktree.id === worktreeId)
}

const useAppStore = Object.assign(
  (selector?: (state: typeof storeState) => unknown) =>
    selector ? selector(storeState) : storeState,
  {
    getState: () => storeState,
    setState: vi.fn(),
    subscribe: vi.fn()
  }
)

vi.mock('../../store', () => ({ useAppStore }))

/**
 * The "+" menu's shell rows on a workspace that no runtime environment owns. The remote
 * runtime is connected and focused, which is the whole trap: an unowned workspace must
 * still open its shell locally instead of asking that runtime to resolve a selector it
 * has never heard of (#16444).
 */
describe('tab group "+" menu shell launch on a locally-owned workspace', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeState.activeWorkspaceExecutionHostId = 'local'
    storeState.activeWorktreeId = WORKTREE_ID
    mocks.getRuntimeEnvironmentIdForWorktree.mockReturnValue(null)
    mocks.createWebRuntimeSessionTerminal.mockResolvedValue({ status: 'failed' })
    mocks.isWebRuntimeSessionActive.mockReturnValue(false)
    mocks.createTab.mockReturnValue({ id: 'local-tab-1' })
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call: mocks.runtimeCall } } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('opens the shell locally without consulting the focused runtime environment', async () => {
    const { useTabGroupCreationCommands } = await import('./useTabGroupCreationCommands')
    const commands = useTabGroupCreationCommands({
      groupId: GROUP_ID,
      worktreeId: WORKTREE_ID,
      worktreeState: { mobileEmulatorEnabled: false } as never
    })

    commands.newTerminalWithShell('powershell.exe')
    await vi.waitFor(() => expect(mocks.createTab).toHaveBeenCalled())

    expect(mocks.runtimeCall).not.toHaveBeenCalled()
    expect(mocks.createTab).toHaveBeenCalledWith(WORKTREE_ID, GROUP_ID, 'powershell.exe')
    expect(mocks.setActiveTab).toHaveBeenCalledWith('local-tab-1')
  })

  it('leaves the workspace on its own execution host', async () => {
    const { useTabGroupCreationCommands } = await import('./useTabGroupCreationCommands')
    const commands = useTabGroupCreationCommands({
      groupId: GROUP_ID,
      worktreeId: WORKTREE_ID,
      worktreeState: { mobileEmulatorEnabled: false } as never
    })

    commands.newTerminalWithShell('powershell.exe')
    await vi.waitFor(() => expect(mocks.createTab).toHaveBeenCalled())

    // Latching the workspace onto the focused runtime is what silently broke the next Ctrl+T.
    expect(mocks.setActiveWorktree).not.toHaveBeenCalled()
    expect(storeState.activeWorkspaceExecutionHostId).toBe('local')
  })

  it('opens embedded VS Code for local workspaces', async () => {
    const { useTabGroupCreationCommands } = await import('./useTabGroupCreationCommands')
    const commands = useTabGroupCreationCommands({
      groupId: GROUP_ID,
      worktreeId: WORKTREE_ID,
      worktreeState: { mobileEmulatorEnabled: false } as never
    })

    commands.newCodeServerTab?.()

    expect(mocks.createCodeServerTab).toHaveBeenCalledWith(
      WORKTREE_ID,
      'C:/Users/neil/orca/workspaces/orca/aug23-triage',
      'VS Code'
    )
  })

  it('opens embedded VS Code for SSH workspaces with the remote folder path', async () => {
    storeState.activeWorktreeId = SSH_WORKTREE_ID
    storeState.activeWorkspaceExecutionHostId = 'ssh:172.16.12.230'
    const { useTabGroupCreationCommands } = await import('./useTabGroupCreationCommands')
    const commands = useTabGroupCreationCommands({
      groupId: GROUP_ID,
      worktreeId: SSH_WORKTREE_ID,
      worktreeState: { mobileEmulatorEnabled: false } as never
    })

    commands.newCodeServerTab?.()

    expect(mocks.createCodeServerTab).toHaveBeenCalledWith(
      SSH_WORKTREE_ID,
      '/home/ubuntu/workspace/kcve',
      'VS Code'
    )
  })
})
