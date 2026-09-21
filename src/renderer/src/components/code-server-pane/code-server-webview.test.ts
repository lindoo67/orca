import { describe, expect, it } from 'vitest'
import { buildCodeServerUrl } from './code-server-webview'

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
})
