import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'
import type * as CodeServerPaths from './code-server-paths'
import { join } from 'node:path'

const { resolveExeMock, spawnMock, netRequestMock, createServerMock } = vi.hoisted(() => ({
  resolveExeMock: vi.fn(),
  spawnMock: vi.fn(),
  netRequestMock: vi.fn(),
  createServerMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/userData' },
  net: { request: netRequestMock }
}))
vi.mock('./code-server-installer', () => ({ ensureCodeServerInstalled: vi.fn() }))
vi.mock('./code-server-vscode-user-config', () => ({ mirrorVsCodeUserConfig: vi.fn() }))
// Hydration spawns the user's login shell through the shared process wrapper,
// so stub it out to keep startProcess() tests hermetic. 'not ok' => no PATH merge.
vi.mock('../startup/hydrate-shell-path', () => ({
  hydrateShellPath: vi.fn(() =>
    Promise.resolve({ ok: false, segments: [], failureReason: 'no_shell' as const })
  ),
  mergePathSegments: vi.fn(() => [])
}))
vi.mock('../../shared/child-process/run-process', () => ({ spawnProcess: spawnMock }))
vi.mock('node:net', () => ({ createServer: createServerMock }))
// Passthrough spread (not a full replacement) so vi.spyOn can patch individual
// fs functions below; a real ES module namespace object isn't spy-able.
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof NodeFs>()
  return { ...original }
})
// Passthrough spread, overriding only resolveCodeServerExecutable so the
// not-installed/single-flight tests can control it while buildCodeServerArgs
// keeps using the real path-joining logic (anchored at the mocked userData dir).
vi.mock('./code-server-paths', async (importOriginal) => {
  const original = await importOriginal<typeof CodeServerPaths>()
  return { ...original, resolveCodeServerExecutable: resolveExeMock }
})

import { buildCodeServerArgs, CodeServerManager } from './code-server-manager'
import { ensureCodeServerInstalled } from './code-server-installer'
import { mirrorVsCodeUserConfig } from './code-server-vscode-user-config'

describe('buildCodeServerArgs', () => {
  it('binds loopback, disables auth+telemetry+workspace-trust, isolates dirs', () => {
    expect(buildCodeServerArgs(12345)).toEqual([
      '--bind-addr',
      '127.0.0.1:12345',
      '--auth',
      'none',
      '--disable-telemetry',
      '--disable-workspace-trust',
      '--user-data-dir',
      join('/userData', 'code-server', 'user-data'),
      '--extensions-dir',
      join('/userData', 'code-server', 'extensions')
    ])
  })
})

describe('reapOrphan', () => {
  it('sends SIGTERM to a stale pid and removes the pidfile', async () => {
    const fs = await import('node:fs')
    vi.spyOn(fs, 'existsSync').mockReturnValue(true)
    vi.spyOn(fs, 'readFileSync').mockReturnValue('4242')
    const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation(() => {})
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    new CodeServerManager().reapOrphan()
    expect(killSpy).toHaveBeenCalledWith(4242, 'SIGTERM')
    expect(rmSpy).toHaveBeenCalled()
    killSpy.mockRestore()
  })
})

describe('initial status', () => {
  afterEach(() => {
    resolveExeMock.mockReset()
  })

  it('is not-installed when the executable does not resolve', () => {
    resolveExeMock.mockReturnValue(null)
    expect(new CodeServerManager().getStatus().status).toBe('not-installed')
  })

  it('is stopped when the executable already resolves', () => {
    resolveExeMock.mockReturnValue('/opt/code-server/bin/code-server')
    expect(new CodeServerManager().getStatus().status).toBe('stopped')
  })
})

// Fakes the full startProcess() dependency chain (net.createServer for the
// free-port pick, electron net.request for the /healthz probe, and spawn for
// the child) so acquire()'s single-flight guard can be exercised end to end.
function primeSuccessfulStart(port: number): void {
  createServerMock.mockImplementation(() => ({
    once: () => {},
    listen: (_port: number, _host: string, cb: () => void) => cb(),
    address: () => ({ port }),
    close: (cb: () => void) => cb()
  }))

  netRequestMock.mockImplementation(() => {
    const handlers: Record<string, (arg?: unknown) => void> = {}
    return {
      on: (event: string, cb: (arg?: unknown) => void) => {
        handlers[event] = cb
      },
      end: () => {
        handlers.response?.({
          statusCode: 200,
          on: (event: string, cb: () => void) => {
            if (event === 'end') {
              cb()
            }
          }
        })
      }
    }
  })

  spawnMock.mockImplementation(() => ({
    pid: 4242,
    killed: false,
    stderr: { on: vi.fn() },
    on: vi.fn(),
    removeAllListeners: vi.fn(),
    kill: vi.fn()
  }))
}

describe('acquire single-flight', () => {
  afterEach(() => {
    resolveExeMock.mockReset()
    spawnMock.mockReset()
    createServerMock.mockReset()
    netRequestMock.mockReset()
    vi.mocked(ensureCodeServerInstalled).mockReset()
    vi.mocked(mirrorVsCodeUserConfig).mockReset()
  })

  it('spawns exactly one child when two acquire() calls overlap before ready', async () => {
    resolveExeMock.mockReturnValue('/opt/code-server/bin/code-server')
    vi.mocked(ensureCodeServerInstalled).mockResolvedValue('/opt/code-server/bin/code-server')
    vi.mocked(mirrorVsCodeUserConfig).mockResolvedValue(undefined)
    primeSuccessfulStart(4999)

    const fs = await import('node:fs')
    vi.spyOn(fs, 'existsSync').mockReturnValue(false)
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {})

    const manager = new CodeServerManager()
    // Both calls fire before either awaits; this is the overlap the fix guards against.
    const [first, second] = await Promise.all([manager.acquire(), manager.acquire()])

    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(first).toEqual({ port: 4999 })
    expect(second).toEqual({ port: 4999 })
  })

  it('creates the code-server state directory before writing the pid file', async () => {
    resolveExeMock.mockReturnValue('/opt/code-server/bin/code-server')
    vi.mocked(ensureCodeServerInstalled).mockResolvedValue('/opt/code-server/bin/code-server')
    vi.mocked(mirrorVsCodeUserConfig).mockResolvedValue(undefined)
    primeSuccessfulStart(4996)

    const fs = await import('node:fs')
    vi.spyOn(fs, 'existsSync').mockReturnValue(false)
    const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined)
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {})

    const manager = new CodeServerManager()
    await manager.acquire()

    expect(mkdirSpy).toHaveBeenCalledWith(join('/userData', 'code-server'), { recursive: true })
  })

  it('retry does not take a ref, so one release after acquire+retry stops the server', async () => {
    resolveExeMock.mockReturnValue('/opt/code-server/bin/code-server')
    vi.mocked(ensureCodeServerInstalled).mockResolvedValue('/opt/code-server/bin/code-server')
    vi.mocked(mirrorVsCodeUserConfig).mockResolvedValue(undefined)
    primeSuccessfulStart(4998)

    const fs = await import('node:fs')
    vi.spyOn(fs, 'existsSync').mockReturnValue(false)
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {})
    vi.spyOn(fs, 'rmSync').mockImplementation(() => {})

    const killMock = vi.fn()
    spawnMock.mockImplementation(() => ({
      pid: 4242,
      killed: false,
      stderr: { on: vi.fn() },
      on: vi.fn(),
      removeAllListeners: vi.fn(),
      kill: killMock
    }))

    const manager = new CodeServerManager()
    await manager.acquire() // pane mount: refCount 0 -> 1
    await manager.retry() // Retry button: must NOT inflate refCount
    manager.release() // pane unmount: refCount 1 -> 0 stops the server

    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(killMock).toHaveBeenCalledTimes(1)
  })

  it('fails the start (no auto-restart) when the child exits before becoming ready', async () => {
    resolveExeMock.mockReturnValue('/opt/code-server/bin/code-server')
    vi.mocked(ensureCodeServerInstalled).mockResolvedValue('/opt/code-server/bin/code-server')
    vi.mocked(mirrorVsCodeUserConfig).mockResolvedValue(undefined)
    // Free-port pick succeeds; healthz never returns 200 for this port.
    createServerMock.mockImplementation(() => ({
      once: () => {},
      listen: (_port: number, _host: string, cb: () => void) => cb(),
      address: () => ({ port: 4997 }),
      close: (cb: () => void) => cb()
    }))
    netRequestMock.mockImplementation(() => {
      const handlers: Record<string, (arg?: unknown) => void> = {}
      return {
        on: (event: string, cb: (arg?: unknown) => void) => {
          handlers[event] = cb
        },
        end: () => handlers.error?.(new Error('ECONNREFUSED'))
      }
    })

    const fs = await import('node:fs')
    vi.spyOn(fs, 'existsSync').mockReturnValue(false)
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {})
    vi.spyOn(fs, 'rmSync').mockImplementation(() => {})

    // The child reports 'exit' right after startup, before healthz ever passes.
    spawnMock.mockImplementation(() => ({
      pid: 4242,
      killed: false,
      stderr: { on: vi.fn() },
      on: (event: string, cb: (code: number) => void) => {
        if (event === 'exit') {
          setTimeout(() => cb(1), 0)
        }
      },
      removeAllListeners: vi.fn(),
      kill: vi.fn()
    }))

    const manager = new CodeServerManager()
    await expect(manager.acquire()).rejects.toThrow(/did not become ready/)
    // startSequence retries the spawn once before surfacing the error, so two
    // spawns are expected. The startup exit must NOT trigger the *crash*
    // auto-restart path (handleUnexpectedExit); that would spawn more than twice.
    expect(spawnMock).toHaveBeenCalledTimes(2)
    expect(manager.getStatus().status).toBe('error')
  })
})
