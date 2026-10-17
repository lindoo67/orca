import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/runtime-client-target'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { CodeServerTab } from '../../../../shared/code-server-tab'
import type { Tab } from '../../../../shared/tab-types'
import type { LayoutApplyReply } from '../../../../shared/workspace-layout/workspace-layout-command-types'
import type { AppState } from '../types'

export function recordCreatedCodeServerTabInLayoutOwner(
  state: AppState,
  codeServerTab: CodeServerTab,
  unifiedTab: Tab
): void {
  const environmentId = getRuntimeEnvironmentIdForWorktree(state, codeServerTab.worktreeId)
  void callRuntimeRpc<LayoutApplyReply>(
    runtimeTargetForOwnerEnvironment(environmentId),
    'layout.apply',
    {
      command: {
        type: 'openCodeServerTab',
        workspace: codeServerTab.worktreeId,
        tabId: unifiedTab.id,
        entityId: codeServerTab.id,
        groupId: unifiedTab.groupId
      }
    }
  )
    .then((reply) => {
      if (!reply.ok && reply.code !== 'host_not_owned') {
        console.warn('[layout-owner] openCodeServerTab refused:', reply.code)
      }
    })
    .catch((error: unknown) => {
      console.warn(
        '[layout-owner] openCodeServerTab failed:',
        error instanceof Error ? error.message : error
      )
    })
}
