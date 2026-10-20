import type { AgentDetectionTarget } from '@/hooks/useDetectedAgents'
import type { NewTabAgentMenuModel } from './use-new-tab-agent-menu-rows'
import type { TabAgentLaunchOption } from './tab-agent-launch-options'
import type { useTabAgentMenuLaunch } from './QuickLaunchButton'
import type { TabCreateMenuOption } from './tab-create-menu-options'
import type { WindowsShellMenuEntry } from './tab-bar-windows-shell-options'

export type TabBarCreateMenuController = {
  agentMenu: NewTabAgentMenuModel
  agentLaunchOptions: TabAgentLaunchOption[]
  launchAgentRow: ReturnType<typeof useTabAgentMenuLaunch>
  newTabMenuOpen: boolean
  setNewTabMenuOpen: (open: boolean) => void
  setCreateMenuQuery: (query: string) => void
  createMenuOptions: TabCreateMenuOption[]
  windowsShellEntries: WindowsShellMenuEntry[] | undefined
  handleSelectCreateMenuOption: (option: TabCreateMenuOption) => void
  launchAgentFromNewTabEntry: (option: TabAgentLaunchOption) => void
  runPendingNewTabMenuFocusAfterClose: () => void
  clearPendingNewTabMenuFocusOnUnmount: (node: HTMLDivElement | null) => void
  queueNewActiveTerminalFocusAfterNewTabMenuClose: () => void
  queueTerminalTabFocusAfterNewTabMenuClose: (tabId: string) => void
  queueFocusAfterNewTabMenuClose: (focus: () => void) => void
  showStaticCreateMenuItems: boolean
}
