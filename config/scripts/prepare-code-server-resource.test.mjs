import { describe, expect, it } from 'vitest'

import {
  codeServerReleaseAssetName,
  codeServerVendorDirectoryName
} from './prepare-code-server-resource.mjs'

describe('prepare-code-server-resource', () => {
  it('uses the official Windows release asset naming', () => {
    expect(codeServerReleaseAssetName('win32', 'x64')).toBe(
      'code-server-4.138.0-windows-amd64.tar.gz'
    )
  })

  it('uses the extracted top-level directory as the vendored directory name', () => {
    expect(codeServerVendorDirectoryName('win32', 'x64')).toBe('code-server-4.138.0-windows-amd64')
  })
})
