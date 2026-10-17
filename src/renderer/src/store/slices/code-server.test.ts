import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'

const mocks = vi.hoisted(() => ({ recordCreatedCodeServerTabInLayoutOwner: vi.fn() }))

vi.mock('./code-server-layout-owner', () => ({
  recordCreatedCodeServerTabInLayoutOwner: mocks.recordCreatedCodeServerTabInLayoutOwner
}))

const WORKTREE_ID = 'repo::/workspace/empty'

describe('code-server tabs', () => {
  beforeEach(() => mocks.recordCreatedCodeServerTabInLayoutOwner.mockReset())

  it('surfaces the first VS Code tab immediately in an empty active workspace', () => {
    const store = createTestStore()
    store.setState({ activeWorktreeId: WORKTREE_ID, activeTabType: 'terminal' })

    const codeServerTab = store
      .getState()
      .createCodeServerTab(WORKTREE_ID, '/workspace/empty', 'VS Code')
    const state = store.getState()
    const unifiedTab = state.unifiedTabsByWorktree[WORKTREE_ID]?.[0]

    expect(unifiedTab).toMatchObject({
      entityId: codeServerTab.id,
      contentType: 'vscode'
    })
    expect(state.groupsByWorktree[WORKTREE_ID]?.[0]?.activeTabId).toBe(unifiedTab?.id)
    expect(state.activeCodeServerTabIdByWorktree[WORKTREE_ID]).toBe(codeServerTab.id)
    expect(state.activeTabType).toBe('vscode')
    expect(mocks.recordCreatedCodeServerTabInLayoutOwner).toHaveBeenCalledWith(
      state,
      codeServerTab,
      unifiedTab
    )
  })

  it('repairs an existing code-server tab that lost its unified tab', () => {
    const store = createTestStore()
    const codeServerTab = {
      id: 'code-server-existing',
      worktreeId: WORKTREE_ID,
      folderPath: '/workspace/empty',
      label: 'VS Code'
    }
    store.setState({
      activeWorktreeId: WORKTREE_ID,
      activeTabType: 'terminal',
      codeServerTabsByWorktree: { [WORKTREE_ID]: [codeServerTab] }
    })

    store.getState().createCodeServerTab(WORKTREE_ID)

    const state = store.getState()
    const unifiedTab = state.unifiedTabsByWorktree[WORKTREE_ID]?.[0]
    expect(unifiedTab).toMatchObject({
      entityId: codeServerTab.id,
      contentType: 'vscode'
    })
    expect(state.groupsByWorktree[WORKTREE_ID]?.[0]?.activeTabId).toBe(unifiedTab?.id)
    expect(state.activeTabType).toBe('vscode')
    expect(mocks.recordCreatedCodeServerTabInLayoutOwner).toHaveBeenCalledWith(
      state,
      codeServerTab,
      unifiedTab
    )
  })
})
