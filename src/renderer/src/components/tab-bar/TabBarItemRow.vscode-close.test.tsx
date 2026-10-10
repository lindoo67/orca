import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { TabBarItem } from './tab-bar-item-model'
import type { TabBarItemActions } from './use-tab-bar-item-actions'
import TabBarItemRow from './TabBarItemRow'

vi.mock('react-i18next', () => ({ useTranslation: () => ({}) }))
vi.mock('@/runtime/structured-conversation-name', () => ({
  useStructuredChatTabConversationName: () => null
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
  it('closes the backing code-server tab instead of only closing the unified row', () => {
    const actions = makeActions()

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

    expect(actions.closeCodeServerTab).toHaveBeenCalledWith('code-server-tab-1')
    expect(actions.close).not.toHaveBeenCalled()
  })
})
