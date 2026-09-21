import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'
import type { CodeServerStatusEvent } from '../../shared/code-server-types'

export const codeServerApi = {
  ensureRunning: (request) => ipcRenderer.invoke('codeServer:ensureRunning', request),
  retry: (request) => ipcRenderer.invoke('codeServer:retry', request),
  release: (request) => ipcRenderer.invoke('codeServer:release', request),
  getStatus: () => ipcRenderer.invoke('codeServer:getStatus'),
  onStatusChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, status: CodeServerStatusEvent) =>
      callback(status)
    ipcRenderer.on('codeServer:statusChanged', listener)
    return () => ipcRenderer.removeListener('codeServer:statusChanged', listener)
  }
} satisfies PreloadApi['codeServer']
