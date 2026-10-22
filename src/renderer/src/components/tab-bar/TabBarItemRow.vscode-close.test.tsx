import { readFileSync } from 'node:fs'
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
  useStructuredChatTabConversationName: () => null,
  useStructuredChatTabNamingFailure: () => null
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
    closeSplitPane: vi.fn(),
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
      canCloseSplitPane: false,
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
      canCloseSplitPane: false,
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

const LOCALES = ['en', 'es', 'fr', 'ja', 'ko', 'pt', 'zh'] as const
const CATALOG_PATH = ['auto', 'components', 'tab', 'bar', 'TabBarItemRow'] as const
const TAB_ITEM_ROW_KEYS = [
  'closeVSCodeTitle',
  'closeVSCodeDescription',
  'closeVSCodeConfirm'
] as const

const ENGLISH_FALLBACKS = {
  closeVSCodeTitle: 'Close VS Code?',
  closeVSCodeDescription:
    'This closes the embedded VS Code tab. Your files and workspace stay available.',
  closeVSCodeConfirm: 'Close VS Code'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function countSectionKeys(catalog: unknown): Record<string, unknown> | null {
  let node: unknown = catalog
  for (const seg of CATALOG_PATH) {
    if (!isRecord(node)) {
      return null
    }
    if (!(seg in node)) {
      return null
    }
    node = node[seg]
  }
  if (!isRecord(node)) {
    return null
  }
  return node
}

describe('TabBarItemRow VS Code close dialog locale coverage', () => {
  const tabItemRowKeys = TAB_ITEM_ROW_KEYS

  for (const locale of LOCALES) {
    it(`${locale} catalog has exactly one TabBarItemRow with 3 non-empty string keys`, () => {
      const raw = readFileSync(`src/renderer/src/i18n/locales/${locale}.json`, 'utf8')
      const sectionRegex = /"TabBarItemRow"\s*:/g
      const occurrences = (raw.match(sectionRegex) ?? []).length
      expect(occurrences).toBe(1)

      const catalog: unknown = JSON.parse(raw)
      const section = countSectionKeys(catalog)
      expect(section).not.toBeNull()

      if (isRecord(section)) {
        const keys = Object.keys(section)
        expect(keys.sort()).toEqual([...tabItemRowKeys].sort())

        for (const key of tabItemRowKeys) {
          expect(section[key]).toBeDefined()
          expect(typeof section[key]).toBe('string')
          expect(String(section[key])).not.toEqual('')
        }
      }
    })
  }

  it('zh TabBarItemRow values match expected Chinese translations, not English fallback', () => {
    const raw = readFileSync('src/renderer/src/i18n/locales/zh.json', 'utf8')
    const catalog: unknown = JSON.parse(raw)
    const section = countSectionKeys(catalog)
    expect(section).not.toBeNull()

    if (isRecord(section)) {
      expect(section.closeVSCodeTitle).toBe('关闭 VS Code？')
      expect(section.closeVSCodeDescription).toBe(
        '关闭嵌入式 VS Code 标签页。您的文件和工作区仍然可用。'
      )
      expect(section.closeVSCodeConfirm).toBe('关闭 VS Code')

      for (const key of tabItemRowKeys) {
        expect(section[key]).not.toBe(ENGLISH_FALLBACKS[key])
      }
    }
  })
})
