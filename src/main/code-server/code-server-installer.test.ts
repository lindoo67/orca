import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  resolveExecutableMock,
  materializeForMock,
  onProgressMock,
  targetMock,
  executableInDirectoryMock
} = vi.hoisted(() => ({
  resolveExecutableMock: vi.fn(),
  materializeForMock: vi.fn(),
  onProgressMock: vi.fn<
    (
      listener: (event: {
        target: 'linux-x64'
        version: string
        phase: 'downloading' | 'extracting'
        progress: number
      }) => void
    ) => () => void
  >(() => () => {}),
  targetMock: vi.fn(() => 'linux-x64'),
  executableInDirectoryMock: vi.fn(() => '/cache/code-server/bin/code-server')
}))

vi.mock('@orca/process-host', () => ({ runProcess: vi.fn() }))
vi.mock('./code-server-macos-codesign', () => ({ adhocSignBundledBinaries: vi.fn() }))
vi.mock('./code-server-resource-catalog', () => ({
  codeServerResourceTarget: targetMock
}))
vi.mock('./code-server-resource-manager', () => ({
  getCodeServerResourceManager: () => ({
    materializeFor: materializeForMock,
    onProgress: onProgressMock,
    markHealthy: vi.fn(),
    discardFailed: vi.fn()
  })
}))
vi.mock('./code-server-paths', () => ({
  resolveCodeServerExecutable: resolveExecutableMock,
  getCodeServerExecutableInDirectory: executableInDirectoryMock
}))

import { CodeServerInstallError, ensureCodeServerInstalled } from './code-server-installer'

describe('ensureCodeServerInstalled', () => {
  beforeEach(() => {
    resolveExecutableMock.mockReset()
    materializeForMock.mockReset()
    onProgressMock.mockClear()
    targetMock.mockReset()
    targetMock.mockReturnValue('linux-x64')
    executableInDirectoryMock.mockClear()
    delete process.env.ORCA_CODE_SERVER_PATH
  })

  it('keeps an existing executable when the update check fails', async () => {
    resolveExecutableMock.mockReturnValue('/existing/code-server')
    materializeForMock.mockRejectedValue(new Error('offline'))

    await expect(ensureCodeServerInstalled()).resolves.toMatchObject({
      executable: '/existing/code-server'
    })
  })

  it('materializes the current platform resource', async () => {
    resolveExecutableMock.mockReturnValue(null)
    materializeForMock.mockResolvedValue({
      directory: '/cache/code-server',
      version: '4.141.0',
      previousDirectory: null,
      previousVersion: null
    })

    await expect(ensureCodeServerInstalled()).resolves.toMatchObject({
      executable: '/cache/code-server/bin/code-server',
      version: '4.141.0'
    })
    expect(targetMock).toHaveBeenCalledWith(process.platform, process.arch)
    expect(materializeForMock).toHaveBeenCalledWith(process.platform, process.arch)
  })

  it('forwards resource progress to the caller', async () => {
    resolveExecutableMock.mockReturnValue(null)
    materializeForMock.mockImplementation(async () => {
      const listener = onProgressMock.mock.calls[0]?.[0]
      listener?.({ target: 'linux-x64', version: '4.141.0', phase: 'downloading', progress: 0.5 })
      return {
        directory: '/cache/code-server',
        version: '4.141.0',
        previousDirectory: null,
        previousVersion: null
      }
    })
    const progress = vi.fn()

    await ensureCodeServerInstalled(progress)

    expect(progress).toHaveBeenCalledWith(0.5)
  })

  it('classifies unsupported platforms before downloading', async () => {
    resolveExecutableMock.mockReturnValue(null)
    targetMock.mockImplementation(() => {
      throw new Error('unsupported')
    })

    await expect(ensureCodeServerInstalled()).rejects.toMatchObject({
      name: 'CodeServerInstallError',
      code: 'unsupported-arch'
    })
    expect(CodeServerInstallError).toBeDefined()
    expect(materializeForMock).not.toHaveBeenCalled()
  })

  it('wraps materialization failures as download errors', async () => {
    resolveExecutableMock.mockReturnValue(null)
    materializeForMock.mockRejectedValue(new Error('offline'))

    await expect(ensureCodeServerInstalled()).rejects.toMatchObject({
      name: 'CodeServerInstallError',
      code: 'download-failed',
      message: 'Failed to install Embedded VS Code: offline'
    })
  })
})
