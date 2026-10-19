import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { compareAppVersions } from '../../shared/app-version'
import { getMainHttpClient } from '../network/http-client'
import { fileSha256 } from '../node-runtime/pinned-runtime-materializer'
import { downloadVerifiedArchive } from '../node-runtime/runtime-archive-download'
import type {
  CodeServerResourceAsset,
  CodeServerResourceTarget
} from './code-server-resource-catalog'
import {
  refreshCodeServerRelease,
  resolveCodeServerReleaseAsset
} from './code-server-release-resolver'
import {
  getCodeServerExecutableInDirectory,
  getCodeServerCacheRoot,
  getLegacyCodeServerLaunchers,
  getManagedCodeServerArchive,
  getManagedCodeServerDirectory,
  getManagedCodeServerTargetRoot,
  listManagedCodeServerDirectories
} from './code-server-paths'

export type CodeServerResourceProgress = {
  target: CodeServerResourceTarget
  version: string
  phase: 'downloading' | 'extracting'
  progress: number
}

type ProgressListener = (event: CodeServerResourceProgress) => void

export type MaterializedCodeServer = {
  directory: string
  version: string
  previousDirectory: string | null
  previousVersion: string | null
}

export class CodeServerResourceManager {
  private readonly inFlight = new Map<string, Promise<string>>()
  private readonly listeners = new Set<ProgressListener>()

  onProgress(listener: ProgressListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async materializeFor(
    platform: NodeJS.Platform,
    arch: NodeJS.Architecture
  ): Promise<MaterializedCodeServer> {
    const installed = listManagedCodeServerDirectories(platform, arch)
    const previousDirectory = installed[0]?.directory ?? null
    const asset = await resolveCodeServerReleaseAsset(platform, arch, {
      allowNetwork: installed.length === 0
    })
    if (installed[0] && compareAppVersions(installed[0].version, asset.version) >= 0) {
      return { ...installed[0], previousDirectory: null, previousVersion: null }
    }
    try {
      const directory = await this.materialize(asset)
      return {
        directory,
        version: asset.version,
        previousDirectory,
        previousVersion: installed[0]?.version ?? null
      }
    } catch (error) {
      if (installed[0]) {
        console.warn(
          `[code-server] Could not update to ${asset.version}; continuing with ${installed[0].version}:`,
          error
        )
        return { ...installed[0], previousDirectory: null, previousVersion: null }
      }
      throw error
    }
  }

  async markHealthy(
    platform: NodeJS.Platform,
    arch: NodeJS.Architecture,
    version: string
  ): Promise<void> {
    await this.pruneOldVersions(platform, arch, version)
    await this.pruneLegacyInstall()
    void refreshCodeServerRelease()
  }

  async discardFailed(
    platform: NodeJS.Platform,
    arch: NodeJS.Architecture,
    version: string
  ): Promise<void> {
    await rm(getManagedCodeServerDirectory(platform, arch, version), {
      recursive: true,
      force: true
    })
    await rm(getManagedCodeServerArchive(platform, arch, version), { force: true })
  }

  private materialize(asset: CodeServerResourceAsset): Promise<string> {
    const key = `${asset.target}:${asset.version}`
    const active = this.inFlight.get(key)
    if (active) {
      return active
    }
    const operation = this.materializeOnce(asset).finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, operation)
    return operation
  }

  private emit(event: CodeServerResourceProgress): void {
    for (const listener of this.listeners) {
      listener(event)
    }
  }

  private async materializeOnce(asset: CodeServerResourceAsset): Promise<string> {
    const targetRoot = getManagedCodeServerTargetRoot(asset.platform, asset.arch)
    const destination = getManagedCodeServerDirectory(asset.platform, asset.arch, asset.version)
    const executable = getCodeServerExecutableInDirectory(destination, asset.platform)
    if (existsSync(executable)) {
      return destination
    }
    await mkdir(targetRoot, { recursive: true })
    const archive = getManagedCodeServerArchive(asset.platform, asset.arch, asset.version)
    const archiveValid = (await fileSha256(archive)) === asset.archiveSha256
    if (!archiveValid) {
      await rm(archive, { force: true })
      await downloadVerifiedArchive(
        {
          label: `Embedded VS Code ${asset.version}`,
          url: asset.url,
          archiveSha256: asset.archiveSha256,
          maxArchiveBytes: 300 * 1024 * 1024
        },
        archive,
        getMainHttpClient().fetch,
        undefined,
        undefined,
        (bytes) =>
          this.emit({
            target: asset.target,
            version: asset.version,
            phase: 'downloading',
            progress: Math.min(0.95, bytes / asset.downloadBytes)
          })
      )
    }
    this.emit({
      target: asset.target,
      version: asset.version,
      phase: 'extracting',
      progress: 0.96
    })
    const staging = join(targetRoot, `.extract-${process.pid}-${randomUUID()}`)
    await mkdir(staging, { recursive: true })
    try {
      const result = await runProcess({
        program: 'tar',
        args: ['-xzf', archive, '-C', staging],
        timeoutMs: null
      })
      if (result.code !== 0) {
        throw new Error(result.stderr.trim() || `tar exited with code ${result.code}`)
      }
      const extracted = join(staging, asset.archiveName.slice(0, -'.tar.gz'.length))
      if (!existsSync(getCodeServerExecutableInDirectory(extracted, asset.platform))) {
        throw new Error('Downloaded Embedded VS Code archive is missing its executable.')
      }
      await rm(destination, { recursive: true, force: true })
      await rename(extracted, destination)
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
    this.emit({
      target: asset.target,
      version: asset.version,
      phase: 'extracting',
      progress: 1
    })
    return destination
  }

  private async pruneOldVersions(
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
        .map((entry) =>
          rm(entry.directory, { recursive: true, force: true }).catch(() => undefined)
        )
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

  private async pruneLegacyInstall(): Promise<void> {
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
          rm(join(legacyLib, basename(name)), { recursive: true, force: true }).catch(
            () => undefined
          )
        )
    )
    await Promise.all(
      getLegacyCodeServerLaunchers().map((launcher) =>
        rm(launcher, { force: true }).catch(() => undefined)
      )
    )
  }
}

let resourceManager: CodeServerResourceManager | null = null

export function getCodeServerResourceManager(): CodeServerResourceManager {
  resourceManager ??= new CodeServerResourceManager()
  return resourceManager
}

export function resetCodeServerResourceManagerForTests(): void {
  resourceManager = null
}
