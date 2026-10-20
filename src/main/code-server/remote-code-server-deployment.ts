import { compareAppVersions } from '../../shared/app-version'
import type { CodeServerStatusEvent } from '../../shared/code-server-types'
import type { SshConnection } from '../ssh/connection/ssh-connection'
import { quotePosixShell as shellEscape } from '../../shared/shell-argument-quoting'
import { joinRemotePath, type RemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { getManagedCodeServerArchive, getCodeServerVendorDirectoryName } from './code-server-paths'
import {
  refreshCodeServerRelease,
  resolveCodeServerReleaseAsset
} from './code-server-release-resolver'
import { getCodeServerResourceManager } from './code-server-resource-manager'
import { execSsh, getRemoteHome } from './remote-code-server-ssh'

export type RemoteCodeServerBundle = {
  remoteRoot: string
  version: string
  previousRoot: string | null
}

type StatusEmitter = (event: CodeServerStatusEvent) => void

export class RemoteCodeServerDeployment {
  constructor(private readonly emit: StatusEmitter) {}

  async ensure(conn: SshConnection, platform: RemoteHostPlatform): Promise<RemoteCodeServerBundle> {
    const home = await getRemoteHome(conn)
    const parent = joinRemotePath(
      platform,
      home,
      '.orca',
      'code-server',
      'vendor',
      platform.relayPlatform
    )
    const remoteRoots = await this.listBundles(conn, parent)
    const asset = await resolveCodeServerReleaseAsset(platform.os, platform.arch, {
      allowNetwork: remoteRoots.length === 0
    })
    const remoteRoot = joinRemotePath(
      platform,
      parent,
      getCodeServerVendorDirectoryName(platform.os, platform.arch, asset.version)
    )
    const newestRemote = remoteRoots[0]
    const newestVersion = newestRemote ? remoteVersion(newestRemote) : null
    if (newestRemote && newestVersion && compareAppVersions(newestVersion, asset.version) >= 0) {
      return {
        remoteRoot: newestRemote,
        version: newestVersion,
        previousRoot: remoteRoots[1] ?? null
      }
    }
    const executable = joinRemotePath(platform, remoteRoot, 'bin', 'code-server')
    const previousRoot = remoteRoots.find((root) => root !== remoteRoot) ?? null
    if ((await execSsh(conn, `test -x ${shellEscape(executable)}`)).exitCode === 0) {
      return { remoteRoot, version: asset.version, previousRoot }
    }
    this.emit({ status: 'installing', port: null, progress: 0 })
    if (await this.downloadOnRemote(conn, platform, parent, remoteRoot, asset)) {
      this.emit({ status: 'installing', port: null, progress: 1 })
      return { remoteRoot, version: asset.version, previousRoot }
    }
    return this.uploadFromDesktop(conn, platform, parent, remoteRoot, previousRoot)
  }

  async markHealthy(conn: SshConnection, bundle: RemoteCodeServerBundle): Promise<void> {
    void refreshCodeServerRelease()
    const parent = dirnameRemotePath(bundle.remoteRoot)
    const keep = [bundle.remoteRoot, bundle.previousRoot].filter(
      (value): value is string => !!value
    )
    for (const directory of await this.listBundleDirectories(conn, parent)) {
      if (keep.includes(directory)) {
        continue
      }
      const inUse = await execSsh(
        conn,
        `ps -eo args | grep -F ${shellEscape(directory)} | grep -v '[g]rep' >/dev/null 2>&1`
      )
      if (inUse.exitCode !== 0) {
        await execSsh(conn, `rm -rf -- ${shellEscape(directory)}`)
      }
    }
  }

  async rollBackFailedStart(conn: SshConnection, bundle: RemoteCodeServerBundle): Promise<boolean> {
    if (!bundle.previousRoot || bundle.remoteRoot === bundle.previousRoot) {
      return false
    }
    const failedRoot = bundle.remoteRoot
    bundle.remoteRoot = bundle.previousRoot
    bundle.version = remoteVersion(bundle.previousRoot) ?? bundle.version
    bundle.previousRoot = null
    await execSsh(conn, `rm -rf -- ${shellEscape(failedRoot)}`).catch(() => undefined)
    return true
  }

  private async uploadFromDesktop(
    conn: SshConnection,
    platform: RemoteHostPlatform,
    parent: string,
    remoteRoot: string,
    previousRoot: string | null
  ): Promise<RemoteCodeServerBundle> {
    const materialized = await getCodeServerResourceManager().materializeFor(
      platform.os,
      platform.arch
    )
    const localArchive = getManagedCodeServerArchive(
      platform.os,
      platform.arch,
      materialized.version
    )
    console.log(`[code-server:ssh] uploading code-server ${materialized.version} to ${remoteRoot}`)
    await execSsh(conn, `mkdir -p ${shellEscape(parent)}`)
    const remoteArchive = joinRemotePath(platform, parent, basenameRemotePath(localArchive))
    const uploadSession = await conn.openFileUploadSession({ hostPlatform: platform })
    try {
      await uploadSession.uploadFile(localArchive, remoteArchive)
    } finally {
      uploadSession.close()
    }
    const extract = await execSsh(
      conn,
      `tar -xzf ${shellEscape(remoteArchive)} -C ${shellEscape(parent)} && rm -f ${shellEscape(remoteArchive)}`
    )
    if (extract.exitCode !== 0) {
      throw new Error(
        `Failed to extract code-server on ${platform.relayPlatform}: ${extract.stderr || extract.stdout}`.trim()
      )
    }
    await execSsh(conn, `chmod -R u+rx ${shellEscape(remoteRoot)}`)
    const executable = joinRemotePath(platform, remoteRoot, 'bin', 'code-server')
    if (
      (await execSsh(conn, `${shellEscape(executable)} --version >/dev/null 2>&1`)).exitCode !== 0
    ) {
      await execSsh(conn, `rm -rf -- ${shellEscape(remoteRoot)}`)
      if (previousRoot) {
        return {
          remoteRoot: previousRoot,
          version: remoteVersion(previousRoot) ?? 'unknown',
          previousRoot: null
        }
      }
      throw new Error(`Downloaded code-server ${materialized.version} cannot run on this SSH host.`)
    }
    this.emit({ status: 'installing', port: null, progress: 1 })
    return { remoteRoot, version: materialized.version, previousRoot }
  }

  private async downloadOnRemote(
    conn: SshConnection,
    platform: RemoteHostPlatform,
    parent: string,
    remoteRoot: string,
    asset: Awaited<ReturnType<typeof resolveCodeServerReleaseAsset>>
  ): Promise<boolean> {
    const remoteArchive = joinRemotePath(platform, parent, asset.archiveName)
    const executable = joinRemotePath(platform, remoteRoot, 'bin', 'code-server')
    const command = [
      `command -v curl >/dev/null 2>&1`,
      `command -v sha256sum >/dev/null 2>&1`,
      `mkdir -p ${shellEscape(parent)}`,
      `curl -fL --retry 2 --connect-timeout 15 ${shellEscape(asset.url)} -o ${shellEscape(remoteArchive)}`,
      `printf '%s  %s\\n' ${shellEscape(asset.archiveSha256)} ${shellEscape(remoteArchive)} | sha256sum -c -`,
      `tar -xzf ${shellEscape(remoteArchive)} -C ${shellEscape(parent)}`,
      `rm -f ${shellEscape(remoteArchive)}`,
      `chmod -R u+rx ${shellEscape(remoteRoot)}`,
      `${shellEscape(executable)} --version >/dev/null 2>&1`
    ].join(' && ')
    const result = await execSsh(conn, command)
    if (result.exitCode === 0) {
      return true
    }
    await execSsh(conn, `rm -f ${shellEscape(remoteArchive)}`).catch(() => undefined)
    console.warn('[code-server:ssh] remote download unavailable; falling back to upload')
    return false
  }

  private async listBundles(conn: SshConnection, parent: string): Promise<string[]> {
    const result = await execSsh(
      conn,
      `find ${shellEscape(parent)} -mindepth 3 -maxdepth 3 -type f -path '*/bin/code-server' -print 2>/dev/null`
    )
    if (result.exitCode !== 0) {
      return []
    }
    return result.stdout
      .split(/\r?\n/)
      .map((line) => dirnameRemotePath(dirnameRemotePath(line.trim())))
      .filter((line) => remoteVersion(line) !== null)
      .sort((left, right) =>
        compareAppVersions(remoteVersion(right) ?? '0.0.0', remoteVersion(left) ?? '0.0.0')
      )
  }

  private async listBundleDirectories(conn: SshConnection, parent: string): Promise<string[]> {
    const result = await execSsh(
      conn,
      `find ${shellEscape(parent)} -mindepth 1 -maxdepth 1 -type d -name 'code-server-*' -print 2>/dev/null`
    )
    return result.exitCode === 0
      ? result.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
      : []
  }
}

function basenameRemotePath(filePath: string): string {
  const separator = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  return separator >= 0 ? filePath.slice(separator + 1) : filePath
}

function remoteVersion(directory: string): string | null {
  return /\/code-server-(\d+\.\d+\.\d+)-[^/]+-[^/]+$/.exec(directory)?.[1] ?? null
}

function dirnameRemotePath(remotePath: string): string {
  const separator = remotePath.lastIndexOf('/')
  return separator > 0 ? remotePath.slice(0, separator) : remotePath
}
