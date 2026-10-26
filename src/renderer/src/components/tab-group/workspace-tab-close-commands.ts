import type { Tab } from '../../../../shared/tab-types'
import { useAppStore } from '../../store'
import { needsSavePromptOnClose } from '@/store/slices/editor/buffers/editor-buffer-close-rule'
import { requestEditorFileClose } from '../editor/editor-autosave'
import { closeTerminalTab } from '../terminal/terminal-tab-actions'
import { closeWorkspaceBrowserTab } from '@/lib/workspace-browser-tab-close'
import { isEditorTabContentType } from '@/store/slices/editor/tabs/editor-tab-content-type'

export function createWorkspaceTabCloseCommands({
  worktreeId,
  groupTabs
}: {
  worktreeId: string
  groupTabs: Tab[]
}) {
  const { closeUnifiedTab, closeFile, closeCodeServerTab, setActiveWorktree } =
    useAppStore.getState()

  const closeEditorIfUnreferenced = (entityId: string, closingTabId: string) => {
    const otherReference = (useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? []).some(
      (item) =>
        item.id !== closingTabId &&
        item.entityId === entityId &&
        isEditorTabContentType(item.contentType)
    )
    if (!otherReference) {
      if (needsSavePromptOnClose(useAppStore.getState(), entityId)) {
        // Why: route through Terminal.tsx so the unsaved-confirmation save/discard queue stays centralized across all close paths.
        requestEditorFileClose(entityId)
        return false
      }
      closeFile(entityId)
    }
    return true
  }

  const leaveWorktreeIfEmpty = () => {
    const state = useAppStore.getState()
    if (state.activeWorktreeId !== worktreeId) {
      return
    }
    // Why: split-group closes bypass legacy Terminal.tsx; deselect the emptied worktree here or the window goes blank instead of landing.
    const { renderableTabCount } = state.reconcileWorktreeTabModel(worktreeId)
    if (renderableTabCount === 0) {
      setActiveWorktree(null)
    }
  }

  const closeItem = (
    itemId: string,
    opts?: { skipEmptyCheck?: boolean; skipRunningProcessConfirm?: boolean }
  ) => {
    const item = groupTabs.find((candidate) => candidate.id === itemId)
    if (!item) {
      return
    }
    if (item.contentType === 'agent-session') {
      closeUnifiedTab(item.id)
      if (!opts?.skipEmptyCheck) {
        leaveWorktreeIfEmpty()
      }
      return
    }
    if (item.contentType === 'terminal') {
      // Run the empty check only after deferred pin/process confirmations actually close the tab.
      closeTerminalTab(item.entityId, {
        ...(opts?.skipRunningProcessConfirm ? { skipRunningProcessConfirm: true } : {}),
        ...(!opts?.skipEmptyCheck ? { onClosed: leaveWorktreeIfEmpty } : {})
      })
      return
    }
    if (item.contentType === 'browser') {
      const plan = closeWorkspaceBrowserTab(worktreeId, item.entityId, item.id)
      // Unwinding an unfinished create must preserve selection rather than count as emptying the workspace.
      if (!plan.closesLocally || plan.localCloseReason === 'cleanup') {
        return
      }
    } else if (item.contentType === 'vscode') {
      closeCodeServerTab(item.entityId)
    } else if (item.contentType === 'simulator') {
      closeUnifiedTab(item.id)
    } else {
      const canCloseTab = closeEditorIfUnreferenced(item.entityId, item.id)
      if (!canCloseTab) {
        return
      }
      closeUnifiedTab(item.id)
    }
    if (!opts?.skipEmptyCheck) {
      leaveWorktreeIfEmpty()
    }
  }

  return { closeItem, leaveWorktreeIfEmpty }
}
