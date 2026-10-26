import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { appRoot, fetchMock } = vi.hoisted(() => ({
  appRoot: { value: '' },
  fetchMock: vi.fn()
}))

vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: () => appRoot.value })
}))
vi.mock('../network/http-client', () => ({
  getMainHttpClient: () => ({ fetch: fetchMock })
}))

import {
  clearFailedCodeServerRelease,
  recordFailedCodeServerRelease,
  resetCodeServerReleaseResolverForTests,
  resolveCodeServerReleaseAsset
} from './code-server-release-resolver'

describe('code-server release resolver', () => {
  beforeEach(async () => {
    appRoot.value = await mkdtemp(join(tmpdir(), 'orca-code-server-release-'))
    fetchMock.mockReset()
    resetCodeServerReleaseResolverForTests()
  })

  afterEach(async () => {
    await rm(appRoot.value, { recursive: true, force: true })
  })

  it('uses the latest stable compatible GitHub asset and its digest', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          tag_name: 'v4.141.0',
          draft: false,
          prerelease: false,
          assets: [
            {
              name: 'code-server-4.141.0-linux-amd64.tar.gz',
              size: 239_926_515,
              digest: 'sha256:65bcd20b524d03eb1b5adb7f360244599ef0e5b74089a46a982d32c074b97a29',
              browser_download_url:
                'https://github.com/coder/code-server/releases/download/v4.141.0/code-server-4.141.0-linux-amd64.tar.gz'
            }
          ]
        }),
        { status: 200 }
      )
    )

    await expect(resolveCodeServerReleaseAsset('linux', 'x64')).resolves.toMatchObject({
      version: '4.141.0',
      archiveSha256: '65bcd20b524d03eb1b5adb7f360244599ef0e5b74089a46a982d32c074b97a29'
    })
  })

  it("falls back to Orca's verified release when discovery is unavailable", async () => {
    fetchMock.mockRejectedValue(new Error('offline'))

    await expect(resolveCodeServerReleaseAsset('linux', 'x64')).resolves.toMatchObject({
      version: '4.138.0',
      archiveSha256: '5d63f26c5dabc2acd29610b9b27f413b016aa67019e2cfcdf54031625e18f535'
    })
  })

  it('bypasses a discovered release that previously failed on the target', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          tag_name: 'v4.141.0',
          draft: false,
          prerelease: false,
          assets: [
            {
              name: 'code-server-4.141.0-windows-amd64.tar.gz',
              size: 218_475_701,
              digest: 'sha256:8b41915d25547e2edd553bab03ea4cbd621f98c565bcd20b524d03eb1b5adb7f',
              browser_download_url:
                'https://github.com/coder/code-server/releases/download/v4.141.0/code-server-4.141.0-windows-amd64.tar.gz'
            }
          ]
        }),
        { status: 200 }
      )
    )

    await recordFailedCodeServerRelease('win32-x64', '4.141.0')

    await expect(resolveCodeServerReleaseAsset('win32', 'x64')).resolves.toMatchObject({
      version: '4.138.0'
    })

    await clearFailedCodeServerRelease('win32-x64', '4.141.0')

    await expect(resolveCodeServerReleaseAsset('win32', 'x64')).resolves.toMatchObject({
      version: '4.141.0'
    })
  })
})
