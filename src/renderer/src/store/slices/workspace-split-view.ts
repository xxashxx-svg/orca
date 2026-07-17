import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { TabGroupSplitDirection, WorkspacePaneNode } from '../../../../shared/types'
import { findWorktreeById } from './worktree-helpers'

/** Hard ceiling on visible worktree panes — each pane streams live PTY bytes
 *  and runs its own git poll, so an unbounded tree would melt slow hosts. */
export const MAX_WORKSPACE_SPLIT_PANES = 6

export const WORKSPACE_SPLIT_MIN_RATIO = 0.2
export const WORKSPACE_SPLIT_MAX_RATIO = 0.8

export type WorkspacePaneOpenEdge = 'left' | 'right' | 'up' | 'down' | 'replace'

export type WorkspaceSplitViewSlice = {
  /** Outer split tree of worktree panes; null = classic single view. */
  workspaceSplitLayout: WorkspacePaneNode | null
  /** Add worktreeId next to (or in place of) targetWorktreeId. Defaults:
   *  target = activeWorktreeId, edge = 'right'. Returns false when gated off,
   *  invalid, already visible, or at the pane cap. */
  openWorkspacePane: (
    worktreeId: string,
    opts?: { targetWorktreeId?: string; edge?: WorkspacePaneOpenEdge }
  ) => boolean
  /** Remove a pane, merging its sibling up. Collapses to null below 2 leaves. */
  closeWorkspacePane: (worktreeId: string) => void
  /** Resize the split that directly contains worktreeId's pane as a child. */
  setWorkspaceSplitRatio: (splitPath: readonly ('first' | 'second')[], ratio: number) => void
  /** Purge-path hook: always runs, flag or not, so disabling the feature can
   *  never strand panes pointing at removed worktrees. */
  removeWorktreesFromSplitView: (worktreeIds: readonly string[]) => void
}

export function isSplitViewActive(state: Pick<AppState, 'workspaceSplitLayout'>): boolean {
  return state.workspaceSplitLayout !== null
}

/** Leaves left→right when split, else just the focused worktree. */
export function selectVisibleWorkspacePaneIds(
  state: Pick<AppState, 'activeWorktreeId' | 'workspaceSplitLayout'>
): string[] {
  if (state.workspaceSplitLayout) {
    return collectPaneIds(state.workspaceSplitLayout)
  }
  return state.activeWorktreeId ? [state.activeWorktreeId] : []
}

export function collectPaneIds(node: WorkspacePaneNode): string[] {
  if (node.type === 'pane') {
    return [node.worktreeId]
  }
  return [...collectPaneIds(node.first), ...collectPaneIds(node.second)]
}

export function workspaceSplitContainsPane(
  node: WorkspacePaneNode | null,
  worktreeId: string
): boolean {
  if (!node) {
    return false
  }
  return collectPaneIds(node).includes(worktreeId)
}

/** Swap one leaf's worktree for another (sidebar-click "replace focused pane"). */
export function replaceWorkspacePaneLeaf(
  node: WorkspacePaneNode,
  fromWorktreeId: string,
  toWorktreeId: string
): WorkspacePaneNode {
  if (node.type === 'pane') {
    return node.worktreeId === fromWorktreeId ? { type: 'pane', worktreeId: toWorktreeId } : node
  }
  return {
    ...node,
    first: replaceWorkspacePaneLeaf(node.first, fromWorktreeId, toWorktreeId),
    second: replaceWorkspacePaneLeaf(node.second, fromWorktreeId, toWorktreeId)
  }
}

function edgeToSplit(edge: Exclude<WorkspacePaneOpenEdge, 'replace'>): {
  direction: TabGroupSplitDirection
  newFirst: boolean
} {
  // horizontal = side-by-side columns, matching TabGroupLayoutNode semantics.
  switch (edge) {
    case 'left':
      return { direction: 'horizontal', newFirst: true }
    case 'right':
      return { direction: 'horizontal', newFirst: false }
    case 'up':
      return { direction: 'vertical', newFirst: true }
    case 'down':
      return { direction: 'vertical', newFirst: false }
  }
}

function splitLeaf(
  node: WorkspacePaneNode,
  targetWorktreeId: string,
  newWorktreeId: string,
  edge: Exclude<WorkspacePaneOpenEdge, 'replace'>
): WorkspacePaneNode {
  if (node.type === 'pane') {
    if (node.worktreeId !== targetWorktreeId) {
      return node
    }
    const { direction, newFirst } = edgeToSplit(edge)
    const newPane: WorkspacePaneNode = { type: 'pane', worktreeId: newWorktreeId }
    return {
      type: 'split',
      direction,
      first: newFirst ? newPane : node,
      second: newFirst ? node : newPane,
      ratio: 0.5
    }
  }
  return {
    ...node,
    first: splitLeaf(node.first, targetWorktreeId, newWorktreeId, edge),
    second: splitLeaf(node.second, targetWorktreeId, newWorktreeId, edge)
  }
}

function removeLeaves(
  node: WorkspacePaneNode,
  worktreeIds: ReadonlySet<string>
): WorkspacePaneNode | null {
  if (node.type === 'pane') {
    return worktreeIds.has(node.worktreeId) ? null : node
  }
  const first = removeLeaves(node.first, worktreeIds)
  const second = removeLeaves(node.second, worktreeIds)
  if (first && second) {
    return first === node.first && second === node.second ? node : { ...node, first, second }
  }
  return first ?? second
}

function clampRatio(ratio: number): number {
  return Math.min(WORKSPACE_SPLIT_MAX_RATIO, Math.max(WORKSPACE_SPLIT_MIN_RATIO, ratio))
}

/** Drop leaves for removed worktrees; collapses to null below 2 leaves.
 *  Returns the same reference when nothing changed (Zustand no-op safe). */
export function pruneWorkspaceSplitLayout(
  layout: WorkspacePaneNode | null,
  removedWorktreeIds: ReadonlySet<string>
): WorkspacePaneNode | null {
  if (!layout || removedWorktreeIds.size === 0) {
    return layout
  }
  if (!collectPaneIds(layout).some((id) => removedWorktreeIds.has(id))) {
    return layout
  }
  const next = removeLeaves(layout, removedWorktreeIds)
  return next && next.type === 'split' ? next : null
}

export const createWorkspaceSplitViewSlice: StateCreator<
  AppState,
  [],
  [],
  WorkspaceSplitViewSlice
> = (set, get) => ({
  workspaceSplitLayout: null,

  openWorkspacePane: (worktreeId, opts) => {
    const s = get()
    if (s.settings?.experimentalSideBySideWorkspaces !== true) {
      return false
    }
    if (!findWorktreeById(s.worktreesByRepo, worktreeId)) {
      return false
    }
    const layout = s.workspaceSplitLayout
    const edge = opts?.edge ?? 'right'
    const target = opts?.targetWorktreeId ?? s.activeWorktreeId
    if (!target) {
      return false
    }
    if (edge === 'replace') {
      if (!layout || !workspaceSplitContainsPane(layout, target) || target === worktreeId) {
        return false
      }
      // Replacing with an already-visible worktree would duplicate its leaf.
      if (workspaceSplitContainsPane(layout, worktreeId)) {
        return false
      }
      set({ workspaceSplitLayout: replaceWorkspacePaneLeaf(layout, target, worktreeId) })
      return true
    }
    if (worktreeId === target && !layout) {
      return false
    }
    if (workspaceSplitContainsPane(layout, worktreeId)) {
      return false
    }
    const base: WorkspacePaneNode = layout ?? { type: 'pane', worktreeId: target }
    if (!workspaceSplitContainsPane(base, target)) {
      return false
    }
    if (collectPaneIds(base).length >= MAX_WORKSPACE_SPLIT_PANES) {
      return false
    }
    set({ workspaceSplitLayout: splitLeaf(base, target, worktreeId, edge) })
    return true
  },

  closeWorkspacePane: (worktreeId) => {
    const layout = get().workspaceSplitLayout
    if (!layout) {
      return
    }
    const next = removeLeaves(layout, new Set([worktreeId]))
    set({ workspaceSplitLayout: next && next.type === 'split' ? next : null })
  },

  setWorkspaceSplitRatio: (splitPath, ratio) => {
    const layout = get().workspaceSplitLayout
    if (!layout) {
      return
    }
    const next = updateRatioAtPath(layout, splitPath, clampRatio(ratio))
    if (next !== layout) {
      set({ workspaceSplitLayout: next })
    }
  },

  removeWorktreesFromSplitView: (worktreeIds) => {
    const layout = get().workspaceSplitLayout
    const next = pruneWorkspaceSplitLayout(layout, new Set(worktreeIds))
    if (next !== layout) {
      set({ workspaceSplitLayout: next })
    }
  }
})

function updateRatioAtPath(
  node: WorkspacePaneNode,
  path: readonly ('first' | 'second')[],
  ratio: number
): WorkspacePaneNode {
  if (node.type !== 'split') {
    return node
  }
  if (path.length === 0) {
    return node.ratio === ratio ? node : { ...node, ratio }
  }
  const [head, ...rest] = path
  const child = updateRatioAtPath(node[head], rest, ratio)
  return child === node[head] ? node : { ...node, [head]: child }
}
