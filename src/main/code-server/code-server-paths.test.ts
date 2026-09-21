import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'
import { join } from 'node:path'

// Run tests on POSIX (Linux) so path expectations use '/' separators and no `.exe` suffix.
Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })

const { existsSyncMock } = vi.hoisted(() => ({ existsSyncMock: vi.fn() }))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/userData') }
}))
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof NodeFs>()
  return {
    ...original,
    existsSync: existsSyncMock
  }
})

import {
  CODE_SERVER_VERSION,
  getCodeServerCacheRoot,
  resolveCodeServerExecutable,
  resolveBundledCodeServerArchive,
  getCodeServerUserDataDir,
  getCodeServerExtensionsDir
} from './code-server-paths'

describe('code-server-paths', () => {
  beforeEach(() => {
    existsSyncMock.mockReset()
    delete process.env.ORCA_CODE_SERVER_PATH
  })
  afterEach(() => vi.restoreAllMocks())

  it('roots the cache under userData', () => {
    expect(getCodeServerCacheRoot()).toBe(join('/userData', 'code-server'))
    expect(getCodeServerUserDataDir()).toBe(join('/userData', 'code-server', 'user-data'))
    expect(getCodeServerExtensionsDir()).toBe(join('/userData', 'code-server', 'extensions'))
  })

  it('prefers the env override when it exists on disk', () => {
    process.env.ORCA_CODE_SERVER_PATH = '/custom/code-server'
    existsSyncMock.mockImplementation((p: string) => p === '/custom/code-server')
    expect(resolveCodeServerExecutable()).toBe('/custom/code-server')
  })

  it('falls back to the prefix bin when installed', () => {
    const fallback = join('/userData', 'code-server', 'bin', 'code-server')
    existsSyncMock.mockImplementation((p: string) => p === fallback)
    expect(resolveCodeServerExecutable()).toBe(fallback)
  })

  it('resolves the vendored Windows code-server cmd from packaged resources', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    Object.defineProperty(process, 'arch', { value: 'x64', configurable: true })
    Object.defineProperty(process, 'resourcesPath', {
      value: join('C:', 'Orca', 'resources'),
      configurable: true
    })
    const expected = join(
      process.resourcesPath,
      'code-server',
      'vendor',
      'win32-x64',
      `code-server-${CODE_SERVER_VERSION}-windows-amd64`,
      'bin',
      'code-server.cmd'
    )
    existsSyncMock.mockImplementation((p: string) => p === expected)
    expect(resolveCodeServerExecutable()).toBe(expected)
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  })

  it('returns null when nothing resolves', () => {
    existsSyncMock.mockReturnValue(false)
    expect(resolveCodeServerExecutable()).toBeNull()
  })

  it('resolves the vendored Linux archive for SSH hosts', () => {
    Object.defineProperty(process, 'resourcesPath', {
      value: join('C:', 'Orca', 'resources'),
      configurable: true
    })
    const expected = join(
      process.resourcesPath,
      'code-server',
      'vendor',
      'linux-x64',
      'code-server-4.138.0-linux-amd64.tar.gz'
    )
    existsSyncMock.mockImplementation((p: string) => p === expected)
    expect(resolveBundledCodeServerArchive('linux', 'x64')).toBe(expected)
  })
})
