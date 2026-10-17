import type { HoveredTabInsertion } from './useTabDragSplit'

/** Who renders this group's tab strip: the panel itself ('attached', the main surface), or the
 *  host shell ('external', the floating panel's titlebar strip). */
export type TabGroupPanelTabStrip = 'attached' | 'external'

export type TabGroupPanelProps = {
  groupId: string
  worktreeId: string
  isVisible: boolean
  isFocused: boolean
  hasSplitGroups: boolean
  tabStrip?: TabGroupPanelTabStrip
  /** Off for scratch workspaces (the floating panel) whose markdown is not a review surface. */
  markdownAnnotationsEnabled?: boolean
  touchesRightEdge: boolean
  touchesLeftEdge: boolean
  touchesBottomEdge?: boolean
  suppressLeftBorder?: boolean
  suppressRightBorder?: boolean
  suppressBottomBorder?: boolean
  reserveClosedExplorerToggleSpace: boolean
  reserveCollapsedSidebarHeaderSpace: boolean
  isTabDragActive?: boolean
  hoveredTabInsertion?: HoveredTabInsertion | null
}
