import type { StateCreator } from 'zustand'
import type { CodeServerStatus, CodeServerStatusEvent } from '../../../../shared/code-server-types'
import type { CodeServerTab } from '../../../../shared/code-server-tab'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { createBrowserUuid } from '@/lib/browser-uuid'
import type { AppState } from '../types'

export type CodeServerSlice = {
  codeServerTabsByWorktree: Record<string, CodeServerTab[]>
  activeCodeServerTabIdByWorktree: Record<string, string | null>
  codeServerStatus: CodeServerStatus
  codeServerPort: number | null
  createCodeServerTab: (worktreeId: string, folderPath?: string, label?: string) => CodeServerTab
  closeCodeServerTab: (id: string) => void
  setActiveCodeServerTab: (id: string) => void
  setCodeServerStatus: (event: CodeServerStatusEvent) => void
  hydrateCodeServerSession: (session: WorkspaceSessionState) => void
}

function findWorktreeTab(
  tabsByWorktree: Record<string, CodeServerTab[]>,
  tabId: string
): { worktreeId: string; tab: CodeServerTab } | null {
  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    const tab = tabs.find((candidate) => candidate.id === tabId)
    if (tab) {
      return { worktreeId, tab }
    }
  }
  return null
}

export const createCodeServerSlice: StateCreator<AppState, [], [], CodeServerSlice> = (
  set,
  get
) => ({
  codeServerTabsByWorktree: {},
  activeCodeServerTabIdByWorktree: {},
  codeServerStatus: 'stopped',
  codeServerPort: null,

  createCodeServerTab: (worktreeId, folderPath, label) => {
    const existing = (get().codeServerTabsByWorktree[worktreeId] ?? [])[0]
    if (existing) {
      get().setActiveCodeServerTab(existing.id)
      return existing
    }

    const worktree = get().getKnownWorktreeById(worktreeId)
    const resolvedFolderPath = folderPath ?? worktree?.path ?? ''
    const resolvedLabel = label ?? 'VS Code'
    const tab: CodeServerTab = {
      id: createBrowserUuid(),
      worktreeId,
      folderPath: resolvedFolderPath,
      label: resolvedLabel
    }
    set((state) => ({
      codeServerTabsByWorktree: {
        ...state.codeServerTabsByWorktree,
        [worktreeId]: [tab]
      },
      activeCodeServerTabIdByWorktree: {
        ...state.activeCodeServerTabIdByWorktree,
        [worktreeId]: tab.id
      }
    }))
    get().createUnifiedTab(worktreeId, 'vscode', {
      entityId: tab.id,
      label: tab.label,
      activate: true
    })
    return tab
  },

  closeCodeServerTab: (id) => {
    const match = findWorktreeTab(get().codeServerTabsByWorktree, id)
    if (!match) {
      return
    }
    set((state) => {
      const remaining = (state.codeServerTabsByWorktree[match.worktreeId] ?? []).filter(
        (tab) => tab.id !== id
      )
      return {
        codeServerTabsByWorktree: {
          ...state.codeServerTabsByWorktree,
          [match.worktreeId]: remaining
        },
        activeCodeServerTabIdByWorktree: {
          ...state.activeCodeServerTabIdByWorktree,
          [match.worktreeId]: remaining[0]?.id ?? null
        }
      }
    })
    const unified = (get().unifiedTabsByWorktree[match.worktreeId] ?? []).find(
      (tab) => tab.contentType === 'vscode' && tab.entityId === id
    )
    if (unified) {
      get().closeUnifiedTab(unified.id)
    }
  },

  setActiveCodeServerTab: (id) => {
    const match = findWorktreeTab(get().codeServerTabsByWorktree, id)
    if (!match) {
      return
    }
    set((state) => ({
      activeCodeServerTabIdByWorktree: {
        ...state.activeCodeServerTabIdByWorktree,
        [match.worktreeId]: id
      }
    }))
    const unified = (get().unifiedTabsByWorktree[match.worktreeId] ?? []).find(
      (tab) => tab.contentType === 'vscode' && tab.entityId === id
    )
    if (unified) {
      get().activateTab(unified.id)
    }
  },

  setCodeServerStatus: (event) =>
    set({ codeServerStatus: event.status, codeServerPort: event.port }),

  hydrateCodeServerSession: (session) => {
    set({
      codeServerTabsByWorktree: session.codeServerTabsByWorktree ?? {},
      activeCodeServerTabIdByWorktree: session.activeCodeServerTabIdByWorktree ?? {}
    })
  }
})
