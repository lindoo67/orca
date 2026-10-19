import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TabBarItem } from './tab-bar-item-model'
import type { TabBarItemActions } from './use-tab-bar-item-actions'
import TabBarItemRow from './TabBarItemRow'

const { confirmMock } = vi.hoisted(() => ({ confirmMock: vi.fn() }))

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({})
}))
vi.mock('@/runtime/structured-conversation-name', () => ({
  useStructuredChatTabConversationName: () => null
}))
vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => confirmMock
}))
vi.mock('./SortableTab', () => ({
  default: function SortableTab(props: {
    onClose: (tabId: string) => void
    tab: { id: string; title: string }
  }) {
    return (
      <button type="button" onClick={() => props.onClose(props.tab.id)}>
        close {props.tab.title}
      </button>
    )
  }
}))
vi.mock('./EditorFileTab', () => ({
  default: function EditorFileTab() {
    return null
  }
}))
vi.mock('./BrowserTab', () => ({
  default: function BrowserTab() {
    return null
  }
}))

function makeActions(): TabBarItemActions {
  return {
    activateTerminal: vi.fn(),
    activateFile: vi.fn(),
    activateBrowserTab: vi.fn(),
    activateCodeServerTab: vi.fn(),
    activateAgentSession: vi.fn(),
    close: vi.fn(),
    closeFile: vi.fn(),
    closeBrowserTab: vi.fn(),
    closeCodeServerTab: vi.fn(),
    closeOthers: vi.fn(),
    closeToRight: vi.fn(),
    closeToLeft: vi.fn(),
    closeAllFiles: vi.fn(),
    setCustomTitle: vi.fn(),
    setTabColor: vi.fn(),
    togglePaneExpand: vi.fn(),
    duplicateBrowserTab: vi.fn(),
    makePreviewFilePermanent: vi.fn(),
    togglePinned: vi.fn(),
    toggleViewMode: vi.fn()
  }
}

const codeServerItem: TabBarItem = {
  type: 'vscode',
  id: 'code-server-tab-1',
  unifiedTabId: 'unified-vscode-1',
  isPinned: false,
  data: {
    id: 'code-server-tab-1',
    tabId: 'unified-vscode-1',
    worktreeId: 'wt-1',
    folderPath: 'D:\\repo',
    label: 'VS Code'
  }
}

describe('TabBarItemRow VS Code tab actions', () => {
  beforeEach(() => {
    confirmMock.mockReset()
  })

  it('closes the backing code-server tab only after confirmation', async () => {
    const actions = makeActions()
    confirmMock.mockResolvedValue(true)

    const rendered = TabBarItemRow.type({
      item: codeServerItem,
      actions,
      worktreeId: 'wt-1',
      groupId: 'group-1',
      generatedTabTitlesEnabled: false,
      tabCount: 1,
      hasTabsToLeft: false,
      hasTabsToRight: false,
      isActive: true,
      isExpanded: false,
      dropIndicator: null,
      includeTopTabBorder: false,
      canToggleViewMode: false,
      isChatView: false,
      viewModeTabId: undefined,
      canDuplicate: false,
      gitStatus: null,
      onActivateCodeServerTab: vi.fn()
    })

    if (!React.isValidElement<{ onClose: (tabId: string) => void }>(rendered)) {
      throw new Error('Expected TabBarItemRow to render a SortableTab element.')
    }
    rendered.props.onClose('code-server-tab-1')

    expect(confirmMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Close VS Code?',
        confirmLabel: 'Close VS Code'
      })
    )
    expect(actions.closeCodeServerTab).not.toHaveBeenCalled()
    await Promise.resolve()

    expect(actions.closeCodeServerTab).toHaveBeenCalledWith('code-server-tab-1')
    expect(actions.close).not.toHaveBeenCalled()
  })

  it('keeps the backing code-server tab open when confirmation is cancelled', async () => {
    const actions = makeActions()
    confirmMock.mockResolvedValue(false)

    const rendered = TabBarItemRow.type({
      item: codeServerItem,
      actions,
      worktreeId: 'wt-1',
      groupId: 'group-1',
      generatedTabTitlesEnabled: false,
      tabCount: 1,
      hasTabsToLeft: false,
      hasTabsToRight: false,
      isActive: true,
      isExpanded: false,
      dropIndicator: null,
      includeTopTabBorder: false,
      canToggleViewMode: false,
      isChatView: false,
      viewModeTabId: undefined,
      canDuplicate: false,
      gitStatus: null,
      onActivateCodeServerTab: vi.fn()
    })

    if (!React.isValidElement<{ onClose: (tabId: string) => void }>(rendered)) {
      throw new Error('Expected TabBarItemRow to render a SortableTab element.')
    }
    rendered.props.onClose('code-server-tab-1')
    await Promise.resolve()

    expect(actions.closeCodeServerTab).not.toHaveBeenCalled()
  })
})
