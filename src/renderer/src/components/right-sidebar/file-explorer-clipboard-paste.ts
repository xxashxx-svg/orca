import { toast } from 'sonner'
import { getConnectionId } from '@/lib/connection-context'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { importExternalPathsToRuntime } from '@/runtime/runtime-file-client'
import { translate } from '@/i18n/i18n'
import { getRightSidebarWorktreeRuntimeSettings } from './file-explorer-runtime-owner'

/** File references currently on the OS clipboard, or [] when nothing pastable
 *  (also on any read failure — callers use this to hide the Paste item). */
export async function getPastableClipboardFilePaths(): Promise<string[]> {
  try {
    return await window.api.ui.readClipboardFilePaths()
  } catch {
    return []
  }
}

/** Paste clipboard files into an explorer directory via the same import
 *  pipeline as native drag-drop: copies (or uploads, for runtime worktrees)
 *  each source, auto-deconflicting names, then refreshes and selects. */
export async function pasteFilesIntoExplorerDirectory({
  worktreeId,
  worktreePath,
  destinationDir,
  sourcePaths,
  refreshDir,
  setSelectedPath
}: {
  worktreeId: string
  worktreePath: string
  destinationDir: string
  sourcePaths: string[]
  refreshDir: (dirPath: string) => Promise<void>
  setSelectedPath: (path: string | null) => void
}): Promise<void> {
  if (sourcePaths.length === 0) {
    return
  }
  try {
    const { results } = await importExternalPathsToRuntime(
      {
        settings: getRightSidebarWorktreeRuntimeSettings(worktreeId),
        worktreeId,
        worktreePath,
        connectionId: getConnectionId(worktreeId) ?? undefined
      },
      sourcePaths,
      destinationDir
    )
    await refreshDir(destinationDir)
    const imported = results.filter((result) => result.status === 'imported')
    const skipped = results.filter((result) => result.status === 'skipped')
    const failed = results.filter((result) => result.status === 'failed')
    if (imported.length > 0) {
      setSelectedPath(imported[0].destPath)
    }
    if (failed.length > 0) {
      const noun = failed.length === 1 ? 'file' : 'files'
      toast.error(
        translate(
          'auto.components.right.sidebar.fileExplorerClipboardPaste.failed',
          'Failed to paste {{value0}} {{value1}}.',
          { value0: failed.length, value1: noun }
        )
      )
    } else if (skipped.length > 0 && imported.length === 0) {
      // Why: skips are how the pipeline reports missing sources and symlinks;
      // an all-skipped paste must not look like a silent success.
      const noun = skipped.length === 1 ? 'file' : 'files'
      toast.error(
        translate(
          'auto.components.right.sidebar.fileExplorerClipboardPaste.skipped',
          'Skipped {{value0}} {{value1}}.',
          { value0: skipped.length, value1: noun }
        )
      )
    }
  } catch (error) {
    toast.error(extractIpcErrorMessage(error, 'Failed to paste files.'))
  }
}
