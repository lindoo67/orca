import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { appRoot, downloadMock, releaseAssetMock, runProcessMock } = vi.hoisted(() => ({
  appRoot: { value: '' },
  downloadMock: vi.fn(),
  releaseAssetMock: vi.fn(),
  runProcessMock: vi.fn()
}))

vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: () => appRoot.value, getAppPath: () => appRoot.value })
}))
vi.mock('../node-runtime/runtime-archive-download', () => ({
  downloadVerifiedArchive: downloadMock
}))
vi.mock('./code-server-release-resolver', () => ({
  resolveCodeServerReleaseAsset: releaseAssetMock,
  refreshCodeServerRelease: vi.fn()
}))
vi.mock('@orca/process-host', () => ({ runProcess: runProcessMock }))

import { CodeServerResourceManager } from './code-server-resource-manager'
import {
  getCodeServerExecutableInDirectory,
  getLegacyCodeServerDirectory,
  getManagedCodeServerDirectory
} from './code-server-paths'

const latestAsset = {
  target: 'linux-x64' as const,
  version: '4.141.0',
  platform: 'linux' as const,
  arch: 'x64' as const,
  label: 'Linux x64',
  archiveName: 'code-server-4.141.0-linux-amd64.tar.gz',
  url: 'https://github.com/coder/code-server/releases/download/v4.141.0/code-server-4.141.0-linux-amd64.tar.gz',
  archiveSha256: '65bcd20b524d03eb1b5adb7f360244599ef0e5b74089a46a982d32c074b97a29',
  downloadBytes: 239_926_515
}

describe('CodeServerResourceManager', () => {
  beforeEach(async () => {
    appRoot.value = await mkdtemp(join(tmpdir(), 'orca-code-server-resource-'))
    releaseAssetMock.mockResolvedValue(latestAsset)
    downloadMock.mockReset()
    downloadMock.mockImplementation(
      async (_spec, destination: string, _fetch, _signal, _delays, onBytes) => {
        await writeFile(destination, 'verified archive')
        onBytes?.(120_000_000)
      }
    )
    runProcessMock.mockReset()
    runProcessMock.mockImplementation(async ({ args }: { args: string[] }) => {
      const archive = args[1]
      const staging = args[3]
      const extracted = join(staging, basename(archive, '.tar.gz'))
      const executable = getCodeServerExecutableInDirectory(extracted, 'linux')
      await mkdir(dirname(executable), { recursive: true })
      await writeFile(executable, 'executable')
      return { code: 0, stdout: '', stderr: '', timedOut: false }
    })
  })

  afterEach(async () => {
    await rm(appRoot.value, { recursive: true, force: true })
  })

  it('downloads the latest compatible release and reports progress', async () => {
    const manager = new CodeServerResourceManager()
    const progress = vi.fn()
    manager.onProgress(progress)

    const installed = await manager.materializeFor('linux', 'x64')

    expect(installed).toMatchObject({
      directory: getManagedCodeServerDirectory('linux', 'x64', '4.141.0'),
      version: '4.141.0'
    })
    expect(downloadMock).toHaveBeenCalledWith(
      expect.objectContaining({ archiveSha256: latestAsset.archiveSha256 }),
      expect.stringContaining(latestAsset.archiveName),
      expect.any(Function),
      undefined,
      undefined,
      expect.any(Function)
    )
    expect(progress).toHaveBeenLastCalledWith({
      target: 'linux-x64',
      version: '4.141.0',
      phase: 'extracting',
      progress: 1
    })
  })

  it('reuses an installed current release', async () => {
    const manager = new CodeServerResourceManager()
    await manager.materializeFor('linux', 'x64')
    downloadMock.mockClear()
    runProcessMock.mockClear()

    await manager.materializeFor('linux', 'x64')

    expect(downloadMock).not.toHaveBeenCalled()
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it('keeps the healthy release and one rollback version', async () => {
    for (const version of ['4.139.0', '4.140.0', '4.141.0']) {
      const executable = getCodeServerExecutableInDirectory(
        getManagedCodeServerDirectory('linux', 'x64', version),
        'linux'
      )
      await mkdir(dirname(executable), { recursive: true })
      await writeFile(executable, version)
    }
    const manager = new CodeServerResourceManager()

    await manager.markHealthy('linux', 'x64', '4.141.0')

    expect(existsSync(getManagedCodeServerDirectory('linux', 'x64', '4.141.0'))).toBe(true)
    expect(existsSync(getManagedCodeServerDirectory('linux', 'x64', '4.140.0'))).toBe(true)
    expect(existsSync(getManagedCodeServerDirectory('linux', 'x64', '4.139.0'))).toBe(false)
  })

  it('removes the install.sh layout after a managed release is healthy', async () => {
    const legacyExecutable = getCodeServerExecutableInDirectory(
      getLegacyCodeServerDirectory(),
      process.platform
    )
    await mkdir(dirname(legacyExecutable), { recursive: true })
    await writeFile(legacyExecutable, 'legacy')
    const manager = new CodeServerResourceManager()

    await manager.markHealthy(process.platform, process.arch, '4.141.0')

    expect(existsSync(legacyExecutable)).toBe(false)
  })
})
