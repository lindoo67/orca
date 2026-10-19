import { describe, expect, it } from 'vitest'
import { codeServerFallbackAsset, codeServerResourceTarget } from './code-server-resource-catalog'

describe('code-server resource catalog', () => {
  it('provides a checksum-verified fallback release', () => {
    expect(codeServerFallbackAsset('linux-x64')).toMatchObject({
      target: 'linux-x64',
      version: '4.138.0',
      archiveName: 'code-server-4.138.0-linux-amd64.tar.gz',
      archiveSha256: '5d63f26c5dabc2acd29610b9b27f413b016aa67019e2cfcdf54031625e18f535'
    })
  })

  it('maps supported host platforms to release targets', () => {
    expect(codeServerResourceTarget('win32', 'x64')).toBe('win32-x64')
    expect(codeServerResourceTarget('darwin', 'arm64')).toBe('darwin-arm64')
    expect(codeServerResourceTarget('linux', 'x64')).toBe('linux-x64')
  })

  it('rejects unsupported host platforms', () => {
    expect(() => codeServerResourceTarget('linux', 'arm')).toThrow('not available')
  })
})
