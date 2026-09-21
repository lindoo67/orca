import { beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'

const { spawnMock, resolveExeMock, resolveScriptMock, cacheRootMock, renameMock, mkdirMock } =
  vi.hoisted(() => ({
    spawnMock: vi.fn(),
    resolveExeMock: vi.fn(),
    resolveScriptMock: vi.fn(),
    cacheRootMock: vi.fn(() => '/userData/code-server'),
    renameMock: vi.fn(() => Promise.resolve()),
    mkdirMock: vi.fn(() => Promise.resolve())
  }))

vi.mock('../../shared/child-process/run-process', () => ({
  spawnProcess: spawnMock,
  runProcess: vi.fn(() => Promise.resolve({ code: 0, stdout: '', stderr: '', timedOut: false }))
}))
vi.mock('node:os', () => ({ tmpdir: () => '/tmp' }))
vi.mock('node:fs/promises', () => ({
  mkdir: mkdirMock,
  rename: renameMock,
  rm: vi.fn(() => Promise.resolve())
}))
vi.mock('./code-server-paths', () => ({
  CODE_SERVER_VERSION: '4.138.0',
  getCodeServerCacheRoot: cacheRootMock,
  resolveCodeServerExecutable: resolveExeMock,
  resolveCodeServerInstallScript: resolveScriptMock
}))

// Run all tests on POSIX (Linux) so the installer uses the `sh` path.
// The tests mock spawnProcess; they can't mock the fetch/unzipper network path.
Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })

// Drives spawn's 'close' listener with the given exit code (and optional stderr).
function mockSpawnExit(code: number, stderr?: string): void {
  spawnMock.mockImplementation(() => ({
    stdout: { on: vi.fn() },
    stderr: {
      on: (event: string, cb: (chunk: Buffer) => void) => {
        if (event === 'data' && stderr) {
          setTimeout(() => cb(Buffer.from(stderr)), 0)
        }
      }
    },
    on: (event: string, cb: (arg: number) => void) => {
      if (event === 'close') {
        setTimeout(() => cb(code), stderr ? 10 : 0)
      }
    }
  }))
}

import { ensureCodeServerInstalled, CodeServerInstallError } from './code-server-installer'

describe('ensureCodeServerInstalled', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    resolveExeMock.mockReset()
    resolveScriptMock.mockReset()
    cacheRootMock.mockReset()
    cacheRootMock.mockReturnValue('/userData/code-server')
    renameMock.mockReset()
    renameMock.mockResolvedValue(undefined)
    mkdirMock.mockReset()
    mkdirMock.mockResolvedValue(undefined)
  })

  it('is idempotent: skips install when the executable already resolves', async () => {
    resolveExeMock.mockReturnValue('/userData/code-server/bin/code-server')
    const exe = await ensureCodeServerInstalled()
    expect(exe).toBe('/userData/code-server/bin/code-server')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('throws no-install-script when the vendored script is missing', async () => {
    resolveExeMock.mockReturnValue(null)
    resolveScriptMock.mockReturnValue(null)
    await expect(ensureCodeServerInstalled()).rejects.toMatchObject({
      code: 'no-install-script'
    })
    expect(CodeServerInstallError).toBeDefined()
  })

  it('spawns sh install.sh with standalone/prefix/version flags', async () => {
    // First resolve null (not installed), then the path after install.
    resolveExeMock
      .mockReturnValueOnce(null)
      .mockReturnValue('/userData/code-server/bin/code-server')
    resolveScriptMock.mockReturnValue('/res/code-server/install.sh')
    spawnMock.mockImplementation(() => {
      const listeners: Record<string, (arg: number) => void> = {}
      return {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: (event: string, cb: (arg: number) => void) => {
          listeners[event] = cb
          if (event === 'close') {
            setTimeout(() => cb(0), 0)
          }
        }
      }
    })
    await ensureCodeServerInstalled()
    expect(spawnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        program: 'sh',
        args: [
          '/res/code-server/install.sh',
          '--method',
          'standalone',
          '--prefix',
          '/userData/code-server',
          '--version',
          '4.138.0'
        ],
        stdio: ['ignore', 'pipe', 'pipe']
      })
    )
  })

  it('classifies unsupported-arch by the install.sh sentinel message', async () => {
    resolveExeMock.mockReturnValue(null)
    resolveScriptMock.mockReturnValue('/res/code-server/install.sh')
    mockSpawnExit(1, 'There are no standalone releases for riscv64')
    await expect(ensureCodeServerInstalled()).rejects.toMatchObject({
      code: 'unsupported-arch'
    })
  })

  it('installs to a space-free staging prefix and relocates when userData has a space', async () => {
    // macOS userData lives under "Application Support", a space that install.sh's
    // sh_c would re-split, escalating to sudo. The installer must instead point
    // --prefix at a space-free staging dir and relocate the result itself.
    const spaceRoot = '/Users/x/Library/Application Support/orca/code-server'
    cacheRootMock.mockReturnValue(spaceRoot)
    resolveExeMock.mockReturnValueOnce(null).mockReturnValue(`${spaceRoot}/bin/code-server`)
    resolveScriptMock.mockReturnValue('/res/code-server/install.sh')
    mockSpawnExit(0)

    await ensureCodeServerInstalled()

    // install.sh got a whitespace-free prefix (the staging dir), never the real one.
    const [{ args }] = spawnMock.mock.calls[0]
    const prefixIndex = args.indexOf('--prefix')
    const passedPrefix = args[prefixIndex + 1]
    expect(passedPrefix).toBe(join('/tmp', 'orca-code-server-install'))
    expect(passedPrefix).not.toMatch(/\s/)

    // the versioned tree was relocated into the real (spaced) location via fs.rename.
    expect(renameMock).toHaveBeenCalledWith(
      join('/tmp', 'orca-code-server-install', 'lib', 'code-server-4.138.0'),
      join(spaceRoot, 'lib', 'code-server-4.138.0')
    )
  })

  it('installs directly (no staging) when the real prefix has no spaces', async () => {
    resolveExeMock
      .mockReturnValueOnce(null)
      .mockReturnValue('/userData/code-server/bin/code-server')
    resolveScriptMock.mockReturnValue('/res/code-server/install.sh')
    mockSpawnExit(0)

    await ensureCodeServerInstalled()

    const [{ args }] = spawnMock.mock.calls[0]
    const prefixIndex = args.indexOf('--prefix')
    expect(args[prefixIndex + 1]).toBe('/userData/code-server')
    expect(renameMock).not.toHaveBeenCalled()
  })
})
