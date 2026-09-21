import { net } from 'electron'
import { createServer } from 'node:net'
import type { ClientChannel } from 'ssh2'
import type { SshConnection } from '../ssh/ssh-connection'
import { shellEscape } from '../ssh/ssh-connection-utils'
import { joinRemotePath, type RemoteHostPlatform } from '../ssh/ssh-remote-platform'

const READY_TIMEOUT_MS = 15_000
const READY_POLL_MS = 250
const OUTPUT_TAIL_MAX_BYTES = 8 * 1024

export type SshExecResult = {
  stdout: string
  stderr: string
  exitCode: number | null
}

export async function startRemoteCodeServer(
  conn: SshConnection,
  platform: RemoteHostPlatform,
  remoteRoot: string,
  port: number
): Promise<string> {
  const home = await getRemoteHome(conn)
  const executable = joinRemotePath(platform, remoteRoot, 'bin', 'code-server')
  const userData = joinRemotePath(platform, home, '.orca', 'code-server', 'user-data')
  const extensions = joinRemotePath(platform, home, '.orca', 'code-server', 'extensions')
  const logs = joinRemotePath(platform, home, '.orca', 'code-server', 'logs')
  const logFile = joinRemotePath(platform, logs, `code-server-${port}.log`)
  const command = [
    `mkdir -p ${shellEscape(userData)} ${shellEscape(extensions)} ${shellEscape(logs)}`,
    [
      'nohup',
      shellEscape(executable),
      '--bind-addr',
      shellEscape(`127.0.0.1:${port}`),
      '--auth',
      'none',
      '--disable-telemetry',
      '--disable-workspace-trust',
      '--user-data-dir',
      shellEscape(userData),
      '--extensions-dir',
      shellEscape(extensions),
      '>',
      shellEscape(logFile),
      '2>&1',
      '</dev/null',
      '&',
      'echo $!'
    ].join(' ')
  ].join(' && ')
  const result = await execSsh(conn, command)
  const pid = result.stdout.trim().split(/\s+/u)[0] ?? ''
  if (result.exitCode !== 0 || !/^\d+$/u.test(pid)) {
    const detail = tailError(result.stderr || result.stdout)
    throw new Error(
      detail
        ? `Failed to start remote code-server: ${detail}`
        : 'Failed to start remote code-server'
    )
  }
  return pid
}

export async function stopRemoteCodeServer(conn: SshConnection, pid: string): Promise<void> {
  if (!/^\d+$/u.test(pid)) {
    return
  }
  await execSsh(conn, `kill ${shellEscape(pid)} 2>/dev/null || true`)
}

export async function getRemoteHome(conn: SshConnection): Promise<string> {
  const result = await execSsh(conn, 'printf %s "$HOME"')
  const home = result.stdout.trim()
  if (result.exitCode !== 0 || !home.startsWith('/')) {
    throw new Error('Unable to resolve SSH home directory for code-server')
  }
  return home
}

export async function execSsh(conn: SshConnection, command: string): Promise<SshExecResult> {
  const channel = await conn.exec(command)
  return collectChannel(channel)
}

export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to allocate a port'))
        return
      }
      server.close(() => resolve(address.port))
    })
  })
}

export function randomRemotePort(): number {
  return 49152 + Math.floor(Math.random() * 16_000)
}

export async function waitForLocalHealthz(port: number): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() <= deadline) {
    if (await probeHealthz(port)) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS))
  }
  return false
}

function collectChannel(channel: ClientChannel): Promise<SshExecResult> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (exitCode: number | null): void => {
      if (settled) {
        return
      }
      settled = true
      resolve({ stdout, stderr, exitCode })
    }
    channel.on('data', (chunk: Buffer) => {
      stdout = (stdout + chunk.toString('utf8')).slice(-OUTPUT_TAIL_MAX_BYTES)
    })
    channel.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-OUTPUT_TAIL_MAX_BYTES)
    })
    channel.once('exit', (code: number | null) => finish(code))
    channel.once('close', () => finish(null))
    channel.once('error', reject)
  })
}

function probeHealthz(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const request = net.request(`http://127.0.0.1:${port}/healthz`)
    request.on('response', (response) => {
      response.on('data', () => {})
      response.on('end', () => resolve(response.statusCode === 200))
    })
    request.on('error', () => resolve(false))
    request.end()
  })
}

function tailError(value: string): string {
  return value.trim().slice(-OUTPUT_TAIL_MAX_BYTES)
}
