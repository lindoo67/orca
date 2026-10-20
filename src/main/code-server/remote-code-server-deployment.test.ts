import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnection } from '../ssh/connection/ssh-connection'

const { execSshMock, releaseAssetMock, resourceManagerMock } = vi.hoisted(() => ({
  execSshMock: vi.fn(),
  releaseAssetMock: vi.fn(),
  resourceManagerMock: { materializeFor: vi.fn() }
}))

vi.mock('./remote-code-server-ssh', () => ({
  execSsh: execSshMock,
  getRemoteHome: vi.fn(() => Promise.resolve('/home/test'))
}))
vi.mock('./code-server-release-resolver', () => ({
  resolveCodeServerReleaseAsset: releaseAssetMock,
  refreshCodeServerRelease: vi.fn()
}))
vi.mock('./code-server-resource-manager', () => ({
  getCodeServerResourceManager: () => resourceManagerMock
}))

import { RemoteCodeServerDeployment } from './remote-code-server-deployment'

const platform = {
  os: 'linux' as const,
  arch: 'x64' as const,
  relayPlatform: 'linux-x64' as const,
  pathFlavor: 'posix' as const,
  commandDialect: 'posix' as const,
  pathSeparator: '/' as const,
  pathDelimiter: ':' as const
}
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

function connection(): SshConnection {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Remote download succeeds before upload APIs are reached in these tests.
  return {} as SshConnection
}

describe('RemoteCodeServerDeployment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    releaseAssetMock.mockResolvedValue(latestAsset)
  })

  it('downloads and verifies the latest release directly on a new SSH host', async () => {
    execSshMock.mockImplementation(async (_conn, command: string) => {
      if (command.startsWith('find ')) {
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      if (command.startsWith('test -x ')) {
        return { exitCode: 1, stdout: '', stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    })
    const events = vi.fn()
    const deployment = new RemoteCodeServerDeployment(events)

    const bundle = await deployment.ensure(connection(), platform)

    expect(bundle.version).toBe('4.141.0')
    expect(releaseAssetMock).toHaveBeenCalledWith('linux', 'x64', { allowNetwork: true })
    expect(execSshMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('sha256sum -c -')
    )
    expect(events).toHaveBeenNthCalledWith(1, { status: 'installing', port: null, progress: 0 })
    expect(events).toHaveBeenNthCalledWith(2, { status: 'installing', port: null, progress: 1 })
  })

  it('never downgrades an already newer SSH installation while offline', async () => {
    execSshMock.mockResolvedValue({
      exitCode: 0,
      stdout: [
        '/home/test/.orca/code-server/vendor/linux-x64/code-server-4.141.0-linux-amd64/bin/code-server',
        '/home/test/.orca/code-server/vendor/linux-x64/code-server-4.140.0-linux-amd64/bin/code-server'
      ].join('\n'),
      stderr: ''
    })
    releaseAssetMock.mockResolvedValue({ ...latestAsset, version: '4.138.0' })
    const deployment = new RemoteCodeServerDeployment(vi.fn())

    const bundle = await deployment.ensure(connection(), platform)

    expect(bundle.version).toBe('4.141.0')
    expect(bundle.previousRoot).toContain('4.140.0')
    expect(releaseAssetMock).toHaveBeenCalledWith('linux', 'x64', { allowNetwork: false })
  })

  it('removes only unused versions older than the rollback release', async () => {
    execSshMock.mockImplementation(async (_conn, command: string) => {
      if (command.startsWith('find ')) {
        return {
          exitCode: 0,
          stdout: [
            '/remote/code-server-4.141.0-linux-amd64',
            '/remote/code-server-4.140.0-linux-amd64',
            '/remote/code-server-4.139.0-linux-amd64'
          ].join('\n'),
          stderr: ''
        }
      }
      if (command.startsWith('ps ')) {
        return { exitCode: 1, stdout: '', stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    })
    const deployment = new RemoteCodeServerDeployment(vi.fn())

    await deployment.markHealthy(connection(), {
      remoteRoot: '/remote/code-server-4.141.0-linux-amd64',
      version: '4.141.0',
      previousRoot: '/remote/code-server-4.140.0-linux-amd64'
    })

    expect(execSshMock).toHaveBeenCalledWith(
      expect.anything(),
      "rm -rf -- '/remote/code-server-4.139.0-linux-amd64'"
    )
  })
})
