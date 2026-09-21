import { parseExecutionHostId } from '../../shared/execution-host'
import type { CodeServerWorkspaceRequest } from '../../shared/code-server-types'
import type { SshConnection } from '../ssh/ssh-connection'
import { shellEscape } from '../ssh/ssh-connection-utils'
import { joinRemotePath, type RemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { activeSessions } from '../ipc/ssh-active-relay-sessions'
import { connectionManager, portForwardManager } from '../ipc/ssh-ipc-context'
import {
  getCodeServerVendorDirectoryName,
  resolveBundledCodeServerArchive,
  resolveBundledCodeServerDirectory
} from './code-server-paths'
import {
  execSsh,
  getRemoteHome,
  pickFreePort,
  randomRemotePort,
  startRemoteCodeServer,
  stopRemoteCodeServer,
  waitForLocalHealthz
} from './remote-code-server-ssh'

const REMOTE_START_ATTEMPTS = 5

type RemoteCodeServerEntry = {
  targetId: string
  localPort: number
  remotePort: number
  forwardId: string
  pid: string | null
  refCount: number
  starting: Promise<{ port: number }> | null
}

export class RemoteCodeServerManager {
  private readonly entries = new Map<string, RemoteCodeServerEntry>()
  private readonly admissiblePorts = new Set<number>()

  async acquire(request: CodeServerWorkspaceRequest): Promise<{ port: number }> {
    const targetId = this.requireSshTargetId(request)
    let entry = this.entries.get(targetId)
    if (entry && this.admissiblePorts.has(entry.localPort)) {
      entry.refCount += 1
      return { port: entry.localPort }
    }
    if (!entry) {
      entry = {
        targetId,
        localPort: 0,
        remotePort: 0,
        forwardId: '',
        pid: null,
        refCount: 0,
        starting: null
      }
      this.entries.set(targetId, entry)
    }
    entry.refCount += 1
    if (!entry.starting) {
      entry.starting = this.start(targetId, entry).finally(() => {
        entry.starting = null
      })
    }
    try {
      return await entry.starting
    } catch (error) {
      entry.refCount = Math.max(0, entry.refCount - 1)
      if (entry.refCount === 0) {
        await this.disposeEntry(entry)
      }
      throw error
    }
  }

  async retry(request: CodeServerWorkspaceRequest): Promise<{ port: number }> {
    const targetId = this.requireSshTargetId(request)
    const entry = this.entries.get(targetId)
    if (entry && this.admissiblePorts.has(entry.localPort)) {
      return { port: entry.localPort }
    }
    return this.acquire(request)
  }

  async release(request: CodeServerWorkspaceRequest): Promise<void> {
    const targetId = this.requireSshTargetId(request)
    const entry = this.entries.get(targetId)
    if (!entry) {
      return
    }
    entry.refCount = Math.max(0, entry.refCount - 1)
    if (entry.refCount === 0) {
      await this.disposeEntry(entry)
    }
  }

  isAdmissiblePort(port: number): boolean {
    return this.admissiblePorts.has(port)
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.entries.values()].map((entry) => this.disposeEntry(entry)))
  }

  private async start(targetId: string, entry: RemoteCodeServerEntry): Promise<{ port: number }> {
    console.log(`[code-server:ssh] starting target=${targetId}`)
    const conn = connectionManager?.getConnection(targetId)
    const platform = activeSessions.get(targetId)?.getHostPlatform()
    if (!conn) {
      throw new Error(`SSH connection "${targetId}" is not connected`)
    }
    if (!platform) {
      throw new Error(`SSH host "${targetId}" has not reported its platform yet`)
    }
    if (platform.os !== 'linux') {
      throw new Error('Embedded VS Code over SSH currently supports Linux hosts only.')
    }
    console.log(`[code-server:ssh] target=${targetId} platform=${platform.relayPlatform}`)
    const remoteRoot = await this.ensureRemoteBundle(conn, platform)
    const localPort = await pickFreePort()
    for (let attempt = 0; attempt < REMOTE_START_ATTEMPTS; attempt += 1) {
      const remotePort = randomRemotePort()
      console.log(
        `[code-server:ssh] target=${targetId} forward local=${localPort} remote=${remotePort}`
      )
      const forward = await portForwardManager?.addForward(
        targetId,
        conn,
        localPort,
        '127.0.0.1',
        remotePort,
        'Orca VS Code'
      )
      if (!forward) {
        throw new Error('SSH port forwarding is not available')
      }
      try {
        const pid = await startRemoteCodeServer(conn, platform, remoteRoot, remotePort)
        console.log(`[code-server:ssh] target=${targetId} remote pid=${pid}`)
        const ready = await waitForLocalHealthz(localPort)
        if (ready) {
          entry.localPort = localPort
          entry.remotePort = remotePort
          entry.forwardId = forward.id
          entry.pid = pid
          this.admissiblePorts.add(localPort)
          console.log(`[code-server:ssh] ready target=${targetId} local=${localPort}`)
          return { port: localPort }
        }
        console.warn(`[code-server:ssh] health check timed out target=${targetId}`)
        await stopRemoteCodeServer(conn, pid)
      } catch (error) {
        console.warn(
          `[code-server:ssh] start attempt failed target=${targetId}: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
        if (attempt + 1 >= REMOTE_START_ATTEMPTS) {
          throw error
        }
      } finally {
        if (!this.admissiblePorts.has(localPort)) {
          await portForwardManager?.removeForwardAndWait(forward.id)
        }
      }
    }
    throw new Error('Remote code-server did not become ready in time')
  }

  private async ensureRemoteBundle(
    conn: SshConnection,
    platform: RemoteHostPlatform
  ): Promise<string> {
    const localBundle = resolveBundledCodeServerDirectory(platform.os, platform.arch)
    const localArchive = resolveBundledCodeServerArchive(platform.os, platform.arch)
    if (!localBundle && !localArchive) {
      throw new Error(
        `Missing bundled code-server for ${platform.relayPlatform}. Run pnpm prepare:code-server -- --target=${platform.relayPlatform}.`
      )
    }
    const home = await getRemoteHome(conn)
    const remoteRoot = joinRemotePath(
      platform,
      home,
      '.orca',
      'code-server',
      'vendor',
      platform.relayPlatform,
      getCodeServerVendorDirectoryName(platform.os, platform.arch)
    )
    const executable = joinRemotePath(platform, remoteRoot, 'bin', 'code-server')
    const present = await execSsh(conn, `test -x ${shellEscape(executable)}`)
    if (present.exitCode === 0) {
      console.log(`[code-server:ssh] remote bundle already present at ${remoteRoot}`)
      return remoteRoot
    }
    console.log(`[code-server:ssh] uploading bundled code-server to ${remoteRoot}`)
    await execSsh(conn, `mkdir -p ${shellEscape(remoteRoot)}`)
    if (localArchive) {
      const remoteArchive = joinRemotePath(
        platform,
        dirnameRemotePath(remoteRoot),
        `${getCodeServerVendorDirectoryName(platform.os, platform.arch)}.tar.gz`
      )
      const uploadSession = await conn.openFileUploadSession({ hostPlatform: platform })
      try {
        await uploadSession.uploadFile(localArchive, remoteArchive)
      } finally {
        uploadSession.close()
      }
      const extract = await execSsh(
        conn,
        `tar -xzf ${shellEscape(remoteArchive)} -C ${shellEscape(dirnameRemotePath(remoteRoot))} && rm -f ${shellEscape(remoteArchive)}`
      )
      if (extract.exitCode !== 0) {
        throw new Error(
          `Failed to extract bundled code-server on ${platform.relayPlatform}: ${
            extract.stderr || extract.stdout
          }`.trim()
        )
      }
    } else if (localBundle) {
      await conn.uploadDirectory(localBundle, remoteRoot, { hostPlatform: platform })
    }
    await execSsh(conn, `chmod -R u+rx ${shellEscape(remoteRoot)}`)
    console.log(`[code-server:ssh] uploaded bundled code-server to ${remoteRoot}`)
    return remoteRoot
  }

  private requireSshTargetId(request: CodeServerWorkspaceRequest): string {
    const parsed = parseExecutionHostId(request.executionHostId)
    if (parsed?.kind !== 'ssh') {
      throw new Error('Remote code-server requires an SSH execution host')
    }
    return parsed.targetId
  }

  private async disposeEntry(entry: RemoteCodeServerEntry): Promise<void> {
    this.entries.delete(entry.targetId)
    this.admissiblePorts.delete(entry.localPort)
    if (entry.forwardId) {
      await portForwardManager?.removeForwardAndWait(entry.forwardId)
    }
    const conn = connectionManager?.getConnection(entry.targetId)
    if (conn && entry.pid) {
      await stopRemoteCodeServer(conn, entry.pid).catch(() => undefined)
    }
  }
}

function dirnameRemotePath(remotePath: string): string {
  const separator = remotePath.lastIndexOf('/')
  return separator > 0 ? remotePath.slice(0, separator) : remotePath
}
