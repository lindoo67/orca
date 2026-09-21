import { beforeEach, describe, expect, it, vi } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'

const { existsSyncMock, lstatMock, readlinkMock, symlinkMock, mkdirMock, rmMock } = vi.hoisted(
  () => ({
    existsSyncMock: vi.fn(),
    lstatMock: vi.fn(),
    readlinkMock: vi.fn(),
    symlinkMock: vi.fn(),
    mkdirMock: vi.fn(),
    rmMock: vi.fn()
  })
)

vi.mock('node:fs', () => ({ existsSync: existsSyncMock }))
vi.mock('node:fs/promises', () => ({
  lstat: lstatMock,
  readlink: readlinkMock,
  symlink: symlinkMock,
  mkdir: mkdirMock,
  rm: rmMock
}))
vi.mock('./code-server-paths', () => ({
  getCodeServerUserDataDir: () => '/userData/code-server/user-data'
}))

import { mirrorVsCodeUserConfig } from './code-server-vscode-user-config'

const realUserDir =
  process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'Code', 'User')
    : join(homedir(), '.config', 'Code', 'User')
const destUserDir = join('/userData/code-server/user-data', 'User')

describe('mirrorVsCodeUserConfig', () => {
  beforeEach(() => {
    ;[existsSyncMock, lstatMock, readlinkMock, symlinkMock, mkdirMock, rmMock].forEach((m) =>
      m.mockReset()
    )
    mkdirMock.mockResolvedValue(undefined)
    symlinkMock.mockResolvedValue(undefined)
    rmMock.mockResolvedValue(undefined)
    lstatMock.mockRejectedValue(new Error('ENOENT'))
    existsSyncMock.mockReturnValue(true)
  })

  it.skipIf(process.platform === 'win32')(
    'symlinks settings.json, keybindings.json and snippets to the real VS Code config',
    async () => {
      await mirrorVsCodeUserConfig()
      for (const entry of ['settings.json', 'keybindings.json', 'snippets']) {
        expect(symlinkMock).toHaveBeenCalledWith(join(realUserDir, entry), join(destUserDir, entry))
      }
    }
  )

  it('leaves an already-correct symlink untouched', async () => {
    lstatMock.mockResolvedValue({ isSymbolicLink: () => true, isDirectory: () => false })
    readlinkMock.mockImplementation((linkPath: string) =>
      Promise.resolve(join(realUserDir, linkPath.replace(`${destUserDir}/`, '')))
    )
    await mirrorVsCodeUserConfig()
    expect(rmMock).not.toHaveBeenCalled()
    expect(symlinkMock).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform === 'win32')(
    'migrates a legacy settings.json copy by replacing it with a symlink',
    async () => {
      // Earlier Orca versions wrote settings.json as a merged plain-file copy.
      lstatMock.mockImplementation((linkPath: string) =>
        linkPath === join(destUserDir, 'settings.json')
          ? Promise.resolve({ isSymbolicLink: () => false, isDirectory: () => false })
          : Promise.reject(new Error('ENOENT'))
      )
      await mirrorVsCodeUserConfig()
      expect(rmMock).toHaveBeenCalledWith(join(destUserDir, 'settings.json'), { force: true })
      expect(symlinkMock).toHaveBeenCalledWith(
        join(realUserDir, 'settings.json'),
        join(destUserDir, 'settings.json')
      )
      expect(rmMock.mock.invocationCallOrder[0]).toBeLessThan(
        symlinkMock.mock.invocationCallOrder[0]
      )
    }
  )

  it('never clobbers a real directory that already lives at the link path', async () => {
    lstatMock.mockImplementation((linkPath: string) =>
      linkPath === join(destUserDir, 'snippets')
        ? Promise.resolve({ isSymbolicLink: () => false, isDirectory: () => true })
        : Promise.reject(new Error('ENOENT'))
    )
    await mirrorVsCodeUserConfig()
    expect(rmMock).not.toHaveBeenCalledWith(join(destUserDir, 'snippets'), expect.anything())
    expect(symlinkMock).not.toHaveBeenCalledWith(
      join(realUserDir, 'snippets'),
      join(destUserDir, 'snippets')
    )
  })

  it('skips an entry when the real source is absent (no dangling symlink)', async () => {
    existsSyncMock.mockImplementation((p: string) => p !== join(realUserDir, 'settings.json'))
    await mirrorVsCodeUserConfig()
    expect(symlinkMock).not.toHaveBeenCalledWith(
      join(realUserDir, 'settings.json'),
      join(destUserDir, 'settings.json')
    )
  })

  it('never throws when a filesystem operation fails', async () => {
    symlinkMock.mockRejectedValue(new Error('EPERM'))
    await expect(mirrorVsCodeUserConfig()).resolves.toBeUndefined()
  })
})
