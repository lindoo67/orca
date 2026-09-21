import { ORCA_BROWSER_GUEST_WEB_PREFERENCES_ATTRIBUTE } from '../../../../shared/browser-guest-web-preferences'
import { ORCA_VSCODE_PARTITION } from '../../../../shared/code-server-tab'

// Keyed by code-server tab id, so the pane can re-attach the same guest
// element across re-renders. The guest is destroyed when the tab's pane
// unmounts (tab close); persistence across tab switches instead depends on
// the pane staying mounted while its tab is open (a mount-strategy concern
// owned by the tab host, not this registry).
const codeServerWebviewRegistry = new Map<string, Electron.WebviewTag>()

// When the repo pins a `.code-workspace` file, open the multi-root workspace via
// code-server's `?workspace=` param; otherwise open the worktree folder as before.
export function buildCodeServerUrl(
  port: number,
  folderPath: string,
  workspaceFilePath?: string
): string {
  if (workspaceFilePath) {
    return `http://127.0.0.1:${port}/?workspace=${encodeURIComponent(normalizeCodeServerPath(workspaceFilePath))}`
  }
  return `http://127.0.0.1:${port}/?folder=${encodeURIComponent(normalizeCodeServerPath(folderPath))}`
}

function normalizeCodeServerPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  if (/^[A-Za-z]:\//.test(normalized)) {
    return `/${normalized}`
  }
  if (normalized.startsWith('//')) {
    return normalized
  }
  return normalized
}

// Resolve a repo's relative `.code-workspace` setting against a worktree's
// absolute folder path. Returns undefined when unset (folder open). The path
// separator is inferred from the folder path so it works on any host (code-server
// is local-only, but this stays correct if that ever changes).
export function resolveWorkspaceFilePath(
  folderPath: string,
  relativeWorkspaceFile: string | undefined
): string | undefined {
  const relative = relativeWorkspaceFile?.trim().replace(/^[/\\]+/, '')
  if (!relative) {
    return undefined
  }
  const usesBackslash = folderPath.includes('\\') && !folderPath.includes('/')
  const sep = usesBackslash ? '\\' : '/'
  const base = folderPath.replace(/[/\\]+$/, '')
  const normalizedRelative = usesBackslash ? relative.replace(/\//g, '\\') : relative
  return `${base}${sep}${normalizedRelative}`
}

export function ensureCodeServerWebview({
  codeServerTabId,
  container
}: {
  codeServerTabId: string
  container: HTMLDivElement
}): { webview: Electron.WebviewTag; created: boolean } | null {
  const existing = codeServerWebviewRegistry.get(codeServerTabId)
  if (existing && existing.parentElement === container) {
    return { webview: existing, created: false }
  }
  if (existing) {
    existing.remove()
    codeServerWebviewRegistry.delete(codeServerTabId)
  }
  const webview: Electron.WebviewTag = document.createElement('webview')
  webview.setAttribute('partition', ORCA_VSCODE_PARTITION)
  webview.setAttribute('allowpopups', '')
  webview.setAttribute(
    'webpreferences',
    `${ORCA_BROWSER_GUEST_WEB_PREFERENCES_ATTRIBUTE},transparent=false`
  )
  webview.style.display = 'flex'
  webview.style.flex = '1'
  webview.style.width = '100%'
  webview.style.height = '100%'
  webview.style.border = 'none'
  webview.style.background = 'var(--editor-surface)'
  codeServerWebviewRegistry.set(codeServerTabId, webview)
  container.appendChild(webview)
  return { webview, created: true }
}

export function destroyCodeServerWebview(codeServerTabId: string): void {
  const webview = codeServerWebviewRegistry.get(codeServerTabId)
  if (webview) {
    webview.remove()
    codeServerWebviewRegistry.delete(codeServerTabId)
  }
}
