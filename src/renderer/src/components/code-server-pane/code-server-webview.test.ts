import { describe, expect, it } from 'vitest'
import {
  buildCodeServerUrl,
  type CodeServerWebviewVisibilityElement,
  hideCodeServerWebview,
  isCodeServerWebviewReadyForUrl,
  revealCodeServerWebview
} from './code-server-webview'

describe('buildCodeServerUrl', () => {
  it('uses slash-prefixed drive paths for Windows folder routes', () => {
    expect(buildCodeServerUrl(62711, 'D:\\orca-workspaces\\orca')).toBe(
      'http://127.0.0.1:62711/?folder=%2FD%3A%2Forca-workspaces%2Forca'
    )
  })

  it('uses slash-prefixed drive paths for Windows workspace routes', () => {
    expect(
      buildCodeServerUrl(
        62711,
        'D:\\orca-workspaces\\orca',
        'D:\\orca-workspaces\\orca\\orca.code-workspace'
      )
    ).toBe(
      'http://127.0.0.1:62711/?workspace=%2FD%3A%2Forca-workspaces%2Forca%2Forca.code-workspace'
    )
  })

  it('keeps the guest hidden until the loaded URL is revealed', () => {
    const attributes = new Map<string, string>()
    const webview = {
      style: { opacity: '', pointerEvents: '', transition: '' },
      getAttribute: (name: string) => attributes.get(name) ?? null,
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      removeAttribute: (name: string) => attributes.delete(name)
    } satisfies CodeServerWebviewVisibilityElement

    revealCodeServerWebview(webview, 'http://127.0.0.1:1234/?folder=%2Ftmp')
    expect(isCodeServerWebviewReadyForUrl(webview, 'http://127.0.0.1:1234/?folder=%2Ftmp')).toBe(
      true
    )
    expect(webview.style.opacity).toBe('1')
    expect(webview.style.pointerEvents).toBe('')

    hideCodeServerWebview(webview)
    expect(isCodeServerWebviewReadyForUrl(webview, 'http://127.0.0.1:1234/?folder=%2Ftmp')).toBe(
      false
    )
    expect(webview.style.opacity).toBe('0')
    expect(webview.style.pointerEvents).toBe('none')
  })
})
