import { X } from 'lucide-react'
import { useAppStore } from '../../store'
import { translate } from '@/i18n/i18n'
import type { WorkspacePaneFrame } from './workspace-split-frames'

/** One small "send this pane back" chip per visible pane, pinned to the
 *  pane's top-right just below its tab strip. Closing a pane only removes it
 *  from the split — the project and its terminals stay untouched. */
export default function WorkspaceSplitPaneCloseButtons({
  frameByWorktreeId
}: {
  frameByWorktreeId: Map<string, WorkspacePaneFrame>
}): React.JSX.Element {
  const closeWorkspacePane = useAppStore((s) => s.closeWorkspacePane)
  return (
    <>
      {Array.from(frameByWorktreeId.entries()).map(([worktreeId, frame]) => (
        <button
          key={`workspace-pane-close-${worktreeId}`}
          type="button"
          data-workspace-pane-close={worktreeId}
          title={translate(
            'auto.components.workspaceSplit.paneClose.title',
            'Remove from split (keeps the project and its terminals)'
          )}
          onClick={() => closeWorkspacePane(worktreeId)}
          className="absolute z-20 flex size-5 items-center justify-center rounded-sm border border-border bg-background/85 text-muted-foreground opacity-60 transition-opacity hover:opacity-100 hover:text-foreground"
          style={{
            left: `calc(${frame.left + frame.width}% - 26px)`,
            // Why: below the 36px tab-strip band so the strip's own right-side
            // controls stay clickable.
            top: `calc(${frame.top}% + 42px)`
          }}
        >
          <X className="size-3" />
        </button>
      ))}
    </>
  )
}
