import { basename, join } from 'node:path'
import { readdir, rm } from 'node:fs/promises'
import {
  getCodeServerCacheRoot,
  getLegacyCodeServerLaunchers,
  getManagedCodeServerTargetRoot,
  listManagedCodeServerDirectories
} from './code-server-paths'

export async function pruneOldCodeServerVersions(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
  healthyVersion: string
): Promise<void> {
  const installed = listManagedCodeServerDirectories(platform, arch)
  const rollback = installed.find((entry) => entry.version !== healthyVersion)
  const keep = new Set([healthyVersion, ...(rollback ? [rollback.version] : [])])
  await Promise.all(
    installed
      .filter((entry) => !keep.has(entry.version))
      .map((entry) => rm(entry.directory, { recursive: true, force: true }).catch(() => undefined))
  )
  const root = getManagedCodeServerTargetRoot(platform, arch)
  let names: string[] = []
  try {
    names = await readdir(root)
  } catch {
    return
  }
  await Promise.all(
    names
      .filter((name) => name.endsWith('.tar.gz'))
      .filter((name) => ![...keep].some((version) => name.includes(`-${version}-`)))
      .map((name) => rm(join(root, basename(name)), { force: true }).catch(() => undefined))
  )
  await Promise.all(
    names
      .filter((name) => name.startsWith('.extract-'))
      .map((name) =>
        rm(join(root, basename(name)), { recursive: true, force: true }).catch(() => undefined)
      )
  )
}

export async function pruneLegacyCodeServerInstall(): Promise<void> {
  const legacyLib = join(getCodeServerCacheRoot(), 'lib')
  let names: string[] = []
  try {
    names = await readdir(legacyLib)
  } catch {
    return
  }
  await Promise.all(
    names
      .filter((name) => name.startsWith('code-server-'))
      .map((name) =>
        rm(join(legacyLib, basename(name)), { recursive: true, force: true }).catch(() => undefined)
      )
  )
  await Promise.all(
    getLegacyCodeServerLaunchers().map((launcher) =>
      rm(launcher, { force: true }).catch(() => undefined)
    )
  )
}
