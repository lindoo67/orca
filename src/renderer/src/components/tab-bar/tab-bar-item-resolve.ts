import type { GitFileStatus } from '../../../../shared/git-status-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { resolveTerminalTabTitle } from '../../../../shared/tab-title-resolution'
import { normalizeRelativePath } from '@/lib/path'
import type { OpenFile } from '../../store/slices/editor'
import { isVirtualEditorFile } from '@/store/slices/editor/tabs/editor-tab-content-type'

export function resolveTerminalItemTab(
  tab: TerminalTab & { unifiedTabId?: string },
  generatedTitlesEnabled: boolean
): TerminalTab & { unifiedTabId?: string } {
  return { ...tab, title: resolveTerminalTabTitle(tab, generatedTitlesEnabled, tab.title) }
}

export function resolveEditorTabGitStatus(
  file: Pick<OpenFile, 'mode' | 'relativePath'>,
  statusByRelativePath: Map<string, GitFileStatus>
): GitFileStatus | null {
  if (file.relativePath === 'All Changes' || isVirtualEditorFile(file)) {
    return null
  }
  return statusByRelativePath.get(normalizeRelativePath(file.relativePath)) ?? null
}
