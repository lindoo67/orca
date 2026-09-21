import { BrowserWindow, ipcMain } from 'electron'
import type {
  CodeServerStatusEvent,
  CodeServerWorkspaceRequest
} from '../../shared/code-server-types'
import { getCodeServerService } from '../code-server/code-server-service'

export function registerCodeServerHandlers(): void {
  const service = getCodeServerService()

  // Broadcast lifecycle changes to every open window's renderer.
  service.onStatusChanged((event: CodeServerStatusEvent) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('codeServer:statusChanged', event)
      }
    }
  })

  ipcMain.removeHandler('codeServer:ensureRunning')
  ipcMain.handle(
    'codeServer:ensureRunning',
    async (_event, request?: CodeServerWorkspaceRequest) => {
      try {
        return await service.acquire(request)
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  // Non-refcounting re-drive for the pane's Retry button; acquire already ran on
  // mount, so retrying must not take a second ref (see CodeServerManager.retry).
  ipcMain.removeHandler('codeServer:retry')
  ipcMain.handle('codeServer:retry', async (_event, request?: CodeServerWorkspaceRequest) => {
    try {
      return await service.retry(request)
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.removeHandler('codeServer:release')
  ipcMain.handle('codeServer:release', (_event, request?: CodeServerWorkspaceRequest) => {
    return service.release(request)
  })

  ipcMain.removeHandler('codeServer:getStatus')
  ipcMain.handle('codeServer:getStatus', () => service.getStatus())
}
