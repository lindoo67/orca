import { existsSync } from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  appRoot,
  downloadMock,
  recordFailedMock,
  releaseAssetMock,
  renameFailures,
  retryDelayMock,
  runProcessMock
} = vi.hoisted(() => ({
  appRoot: { value: '' },
  downloadMock: vi.fn(),
  recordFailedMock: vi.fn().mockResolvedValue(undefined),
  releaseAssetMock: vi.fn(),
  renameFailures: { remaining: 0 },
  retryDelayMock: vi.fn(),
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
  refreshCodeServerRelease: vi.fn(),
  recordFailedCodeServerRelease: recordFailedMock,
  clearFailedCodeServerRelease: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('@orca/process-host', () => ({ runProcess: runProcessMock }))
vi.mock('node:timers/promises', () => ({ setTimeout: retryDelayMock }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  const rename: typeof actual.rename = async (from, to) => {
    if (renameFailures.remaining > 0) {
      renameFailures.remaining -= 1
      throw Object.assign(
        new Error(`EPERM: operation not permitted, rename '${String(from)}' -> '${String(to)}'`),
        {
          code: 'EPERM'
        }
      )
    }
    await actual.rename(from, to)
  }
  return { ...actual, rename, default: { ...actual, rename } }
})

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
    renameFailures.remaining = 0
    retryDelayMock.mockReset()
    retryDelayMock.mockResolvedValue(undefined)
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
      const executable = getCodeServerExecutableInDirectory(
        extracted,
        archive.includes('-windows-') ? 'win32' : 'linux'
      )
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

  it('waits for Windows security scanning to release the extracted directory', async () => {
    const windowsAsset = {
      ...latestAsset,
      target: 'win32-x64' as const,
      platform: 'win32' as const,
      archiveName: 'code-server-4.141.0-windows-amd64.tar.gz'
    }
    releaseAssetMock.mockResolvedValue(windowsAsset)
    renameFailures.remaining = 2
    const manager = new CodeServerResourceManager()

    const installed = await manager.materializeFor('win32', 'x64')

    expect(installed.directory).toBe(getManagedCodeServerDirectory('win32', 'x64', '4.141.0'))
    expect(retryDelayMock).toHaveBeenNthCalledWith(1, 250)
    expect(retryDelayMock).toHaveBeenNthCalledWith(2, 500)
    expect(downloadMock).toHaveBeenCalledTimes(1)
    expect(runProcessMock).toHaveBeenCalledTimes(1)
    expect(runProcessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        program: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
      })
    )
  })

  it('reports a Windows publication timeout without downloading the archive again', async () => {
    const windowsAsset = {
      ...latestAsset,
      target: 'win32-x64' as const,
      platform: 'win32' as const,
      archiveName: 'code-server-4.141.0-windows-amd64.tar.gz'
    }
    releaseAssetMock.mockResolvedValue(windowsAsset)
    renameFailures.remaining = 20
    const manager = new CodeServerResourceManager()

    await expect(manager.materializeFor('win32', 'x64')).rejects.toThrow(
      'Windows prevented Embedded VS Code from being installed after waiting 56 seconds (EPERM).'
    )

    expect(retryDelayMock).toHaveBeenCalledTimes(8)
    expect(downloadMock).toHaveBeenCalledTimes(1)
    expect(runProcessMock).toHaveBeenCalledTimes(1)
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

  it('records a discarded release as failed and removes its directory', async () => {
    const failedDir = getManagedCodeServerDirectory('linux', 'x64', '4.142.0')
    const executable = getCodeServerExecutableInDirectory(failedDir, 'linux')
    await mkdir(dirname(executable), { recursive: true })
    await writeFile(executable, 'failed')

    const manager = new CodeServerResourceManager()
    await manager.discardFailed('linux', 'x64', '4.142.0')

    expect(recordFailedMock).toHaveBeenCalledWith('linux-x64', '4.142.0')
    expect(existsSync(failedDir)).toBe(false)
  })
})
