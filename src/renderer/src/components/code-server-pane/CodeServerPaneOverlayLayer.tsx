import { memo, useCallback, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../store'
import type { CodeServerTab } from '../../../../shared/code-server-tab'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import CodeServerPane from './CodeServerPane'
import { RetainedPaneHost } from '../tab-group/RetainedPaneHost'

// Why: the embedded VS Code `<webview>` destroys its guest contents whenever
// its DOM parent changes, and CodeServerPane ties acquire/release + webview
// create/destroy to its own mount/unmount. Rendering the pane once per code-server
// tab at the worktree level (keyed by the tab id) means switching tabs or moving
// a tab between split groups only updates the overlay's CSS `position-anchor`;
// the pane is never reparented or unmounted, so the shared server stays up and
// the editor never reloads.

type CodeServerOverlayAssignment = {
  groupId: string
  isActiveInGroup: boolean
}

const EMPTY_CODE_SERVER_TABS: readonly CodeServerTab[] = []
const EMPTY_UNIFIED_TABS: readonly Tab[] = []
const EMPTY_GROUPS: readonly TabGroup[] = []

type CodeServerOverlaySlotProps = {
  codeServerTab: CodeServerTab
  // Why: `undefined` means this code-server tab has no owning group (an "orphan";
  // present in `codeServerTabs` but not referenced by any group's unified-tab
  // list). See the fallback branch below for why these slots stay hidden.
  groupId: string | undefined
  isActive: boolean
  // Why: the overlay is a SIBLING of TabGroupSplitLayout, so React events from
  // the pane no longer reach TabGroupPanel's focus sync. In split view, clicking
  // the editor would leave `activeGroupIdByWorktree` stale, so the slot
  // re-implements that focus sync directly, targeting the owning group.
  onFocusOwningGroup: ((groupId: string) => void) | undefined
}

// Why: each overlay slot is memoized so its CodeServerPane subtree only
// re-renders when its own assignment or active state changes. Without this,
// unrelated worktree mutations (terminal keystrokes, editor updates, etc.)
// would cascade into every CodeServerPane.
const CodeServerOverlaySlot = memo(function CodeServerOverlaySlot({
  codeServerTab,
  groupId,
  isActive,
  onFocusOwningGroup
}: CodeServerOverlaySlotProps): React.JSX.Element {
  return (
    <RetainedPaneHost
      groupId={groupId}
      isVisible={isActive}
      data-code-server-overlay-tab-id={codeServerTab.id}
      onFocusOwningGroup={onFocusOwningGroup}
    >
      {/* Why: mount unconditionally for every open vscode tab. Unmounting would
          call CodeServerPane's release() and destroy the editor guest; a hidden
          worktree already display:none's the whole surface, so the mounted pane
          simply isn't painted and the guest survives. Mount == tab open. */}
      <CodeServerPane codeServerTabId={codeServerTab.id} worktreeId={codeServerTab.worktreeId} />
    </RetainedPaneHost>
  )
})

// Why: memoize so parent re-renders (e.g. `WorktreeSplitSurface` re-rendering
// because `focusedGroupId` changed; a prop this component doesn't consume)
// don't rerun the overlay's zustand selector or the assignments mapping.
const CodeServerPaneOverlayLayer = memo(function CodeServerPaneOverlayLayer({
  worktreeId,
  isWorktreeActive
}: {
  worktreeId: string
  isWorktreeActive: boolean
}): React.JSX.Element {
  const { codeServerTabs, unifiedTabs, groups } = useAppStore(
    useShallow((state) => ({
      codeServerTabs: state.codeServerTabsByWorktree[worktreeId] ?? EMPTY_CODE_SERVER_TABS,
      unifiedTabs: state.unifiedTabsByWorktree[worktreeId] ?? EMPTY_UNIFIED_TABS,
      groups: state.groupsByWorktree[worktreeId] ?? EMPTY_GROUPS
    }))
  )
  const focusGroup = useAppStore((state) => state.focusGroup)

  // Why: stable callback identity so CodeServerOverlaySlot's memo isn't broken
  // by a fresh function reference every render. The group id is passed in at
  // call time so the same callback serves every slot.
  const focusOwningGroup = useCallback(
    (groupId: string) => focusGroup(worktreeId, groupId),
    [focusGroup, worktreeId]
  )

  // Why: derive the lookup OUTSIDE the zustand selector so shallow equality
  // holds across unrelated store mutations; otherwise the overlay would
  // re-render on every keystroke in an unrelated terminal.
  const groupActiveTabById = useMemo(() => {
    const lookup: Record<string, string | null | undefined> = {}
    for (const group of groups) {
      lookup[group.id] = group.activeTabId
    }
    return lookup
  }, [groups])

  const assignments = useMemo(() => {
    const entries = new Map<string, CodeServerOverlayAssignment>()
    for (const tab of unifiedTabs) {
      if (tab.contentType !== 'vscode') {
        continue
      }
      entries.set(tab.entityId, {
        groupId: tab.groupId,
        isActiveInGroup: groupActiveTabById[tab.groupId] === tab.id
      })
    }
    return entries
  }, [groupActiveTabById, unifiedTabs])

  return (
    <>
      {codeServerTabs.map((codeServerTab) => {
        const assignment = assignments.get(codeServerTab.id)
        const isActive = Boolean(isWorktreeActive && assignment && assignment.isActiveInGroup)
        return (
          <CodeServerOverlaySlot
            key={codeServerTab.id}
            codeServerTab={codeServerTab}
            groupId={assignment?.groupId}
            isActive={isActive}
            onFocusOwningGroup={focusOwningGroup}
          />
        )
      })}
    </>
  )
})

export default CodeServerPaneOverlayLayer
