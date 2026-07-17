import { useEffect, useMemo } from 'react'
import { useAppStore } from '@/store'
import { useAllWorktrees, useRepoMap } from '@/store/selectors'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import type { GitPushTarget } from '../../../../shared/types'
import { getConnectionId } from '@/lib/connection-context'
import { installWindowVisibilityInterval, isWindowVisible } from '@/lib/window-visibility-interval'
import { collectPaneIds } from '@/store/slices/workspace-split-view'
import { refreshGitStatusForWorktree } from './git-status-refresh'
import { createCoalescedPollRunner } from './coalesced-poll-runner'
import { getRightSidebarWorktreeRuntimeSettings } from './file-explorer-runtime-owner'
import { SLOW_GIT_POLL_BACKOFF } from './useGitStatusPolling'

// Why: side panes are a visibility backstop, not the focused pane's
// evidence-driven scheduler — a slow fixed cadence with the shared slow-task
// backoff is enough; focusing a pane upgrades it to the full machinery.
const SIDE_PANE_STATUS_POLL_INTERVAL_MS = 30_000
const SIDE_PANE_STATUS_MIN_GAP_MS = 3000

type SidePaneGitStatusTarget = {
  id: string
  path: string
  pushTarget: GitPushTarget | undefined
}

/**
 * Full git-status polling for visible side-by-side panes that are NOT the
 * focused worktree. The focused pane keeps the rich lanes (file watch, push
 * signals, interactive cadence) in useGitStatusPolling; side panes get one
 * backstop runner each at the terminal-only cadence — focusing a pane
 * immediately upgrades it to the full machinery. Bounded by the pane cap.
 */
export function useSideWorkspacePaneGitStatusPoll(options: { enabled?: boolean } = {}): void {
  const enabled = options.enabled ?? true
  const workspaceSplitLayout = useAppStore((s) => s.workspaceSplitLayout)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const gitStatusHugeByWorktree = useAppStore((s) => s.gitStatusHugeByWorktree)
  const sshConnectionStates = useAppStore((s) => s.sshConnectionStates)
  const updateWorktreeGitIdentity = useAppStore((s) => s.updateWorktreeGitIdentity)
  const setGitStatus = useAppStore((s) => s.setGitStatus)
  const fetchUpstreamStatus = useAppStore((s) => s.fetchUpstreamStatus)
  const setUpstreamStatus = useAppStore((s) => s.setUpstreamStatus)
  const allWorktrees = useAllWorktrees()
  const repoMap = useRepoMap()

  const sidePaneTargets = useMemo((): SidePaneGitStatusTarget[] => {
    if (!workspaceSplitLayout) {
      return []
    }
    const targets: SidePaneGitStatusTarget[] = []
    for (const paneId of collectPaneIds(workspaceSplitLayout)) {
      if (paneId === activeWorktreeId || gitStatusHugeByWorktree?.[paneId]) {
        continue
      }
      const worktree = allWorktrees.find((entry) => entry.id === paneId)
      if (!worktree) {
        continue
      }
      const repo = repoMap.get(worktree.repoId)
      if (!repo || !isGitRepoKind(repo)) {
        continue
      }
      // Why: after explicit SSH disconnect the provider is intentionally gone;
      // keep remote polling quiet until the target reconnects.
      if (repo.connectionId && sshConnectionStates.get(repo.connectionId)?.status !== 'connected') {
        continue
      }
      targets.push({ id: worktree.id, path: worktree.path, pushTarget: worktree.pushTarget })
    }
    return targets
  }, [
    activeWorktreeId,
    allWorktrees,
    gitStatusHugeByWorktree,
    repoMap,
    sshConnectionStates,
    workspaceSplitLayout
  ])

  useEffect(() => {
    if (!enabled || sidePaneTargets.length === 0) {
      return
    }
    const runners = sidePaneTargets.map((target) =>
      createCoalescedPollRunner(
        async () => {
          if (!isWindowVisible()) {
            return
          }
          try {
            await refreshGitStatusForWorktree({
              settings: getRightSidebarWorktreeRuntimeSettings(target.id),
              worktreeId: target.id,
              worktreePath: target.path,
              connectionId: getConnectionId(target.id) ?? undefined,
              pushTarget: target.pushTarget,
              deps: {
                setGitStatus,
                updateWorktreeGitIdentity,
                setUpstreamStatus,
                fetchUpstreamStatus
              }
            })
          } catch {
            // ignore — pane may have been removed mid-poll
          }
        },
        {
          minIntervalMs: SIDE_PANE_STATUS_MIN_GAP_MS,
          slowTaskBackoff: SLOW_GIT_POLL_BACKOFF
        }
      )
    )
    const stopVisiblePoll = installWindowVisibilityInterval({
      run: () => runners.forEach((runner) => runner.run()),
      runOnVisible: () => runners.forEach((runner) => runner.run({ changeSignal: true })),
      intervalMs: SIDE_PANE_STATUS_POLL_INTERVAL_MS
    })
    return () => {
      stopVisiblePoll()
      for (const runner of runners) {
        runner.dispose()
      }
    }
  }, [
    enabled,
    fetchUpstreamStatus,
    setGitStatus,
    setUpstreamStatus,
    sidePaneTargets,
    updateWorktreeGitIdentity
  ])
}
