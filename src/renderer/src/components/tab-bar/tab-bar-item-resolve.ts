import type { GitFileStatus } from '../../../../shared/git-status-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { resolveTerminalTabTitle } from '../../../../shared/tab-title-resolution'
import { normalizeRelativePath } from '@/lib/path'

export function resolveTerminalItemTab(
  tab: TerminalTab & { unifiedTabId?: string },
  generatedTitlesEnabled: boolean
): TerminalTab & { unifiedTabId?: string } {
  return { ...tab, title: resolveTerminalTabTitle(tab, generatedTitlesEnabled, tab.title) }
}

export function resolveEditorTabGitStatus(
  relativePath: string | undefined,
  statusByRelativePath: Map<string, GitFileStatus>
): GitFileStatus | null {
  if (relativePath === undefined || relativePath === 'All Changes') {
    return null
  }
  return statusByRelativePath.get(normalizeRelativePath(relativePath)) ?? null
}
