import { dirname } from 'node:path'
import { runProcess } from '@orca/process-host'
import { adhocSignBundledBinaries } from './code-server-macos-codesign'
import { codeServerResourceTarget } from './code-server-resource-catalog'
import { getCodeServerResourceManager } from './code-server-resource-manager'
import {
  getCodeServerExecutableInDirectory,
  resolveCodeServerExecutable
} from './code-server-paths'

export type InstallProgress = (fraction: number) => void

export type InstalledCodeServer = {
  executable: string
  version: string | null
  previousExecutable: string | null
  previousVersion: string | null
}

type InstallErrorCode = 'unsupported-arch' | 'download-failed'

export class CodeServerInstallError extends Error {
  readonly code: InstallErrorCode

  constructor(code: InstallErrorCode, message: string) {
    super(message)
    this.name = 'CodeServerInstallError'
    this.code = code
  }
}

let inFlight: Promise<InstalledCodeServer> | null = null

export function ensureCodeServerInstalled(
  onProgress?: InstallProgress
): Promise<InstalledCodeServer> {
  const existing = resolveCodeServerExecutable()
  if (process.env.ORCA_CODE_SERVER_PATH && existing) {
    void prepareMacosExecutable(existing)
    return Promise.resolve({
      executable: existing,
      version: null,
      previousExecutable: null,
      previousVersion: null
    })
  }
  if (inFlight) {
    return inFlight
  }
  inFlight = installManagedResource(existing, onProgress).finally(() => {
    inFlight = null
  })
  return inFlight
}

async function installManagedResource(
  fallbackExecutable: string | null,
  onProgress?: InstallProgress
): Promise<InstalledCodeServer> {
  let target: ReturnType<typeof codeServerResourceTarget>
  try {
    target = codeServerResourceTarget(process.platform, process.arch)
  } catch (error) {
    if (fallbackExecutable) {
      return unmanagedInstall(fallbackExecutable)
    }
    throw new CodeServerInstallError(
      'unsupported-arch',
      error instanceof Error ? error.message : String(error)
    )
  }
  const manager = getCodeServerResourceManager()
  const unsubscribe = manager.onProgress((event) => {
    if (event.target === target) {
      onProgress?.(event.progress)
    }
  })
  try {
    const materialized = await manager.materializeFor(process.platform, process.arch)
    const executable = getCodeServerExecutableInDirectory(materialized.directory, process.platform)
    await prepareMacosExecutable(executable)
    return {
      executable,
      version: materialized.version,
      previousExecutable: materialized.previousDirectory
        ? getCodeServerExecutableInDirectory(materialized.previousDirectory, process.platform)
        : null,
      previousVersion: materialized.previousVersion
    }
  } catch (error) {
    if (fallbackExecutable) {
      await prepareMacosExecutable(fallbackExecutable)
      return unmanagedInstall(fallbackExecutable)
    }
    throw new CodeServerInstallError(
      'download-failed',
      `Failed to install Embedded VS Code: ${error instanceof Error ? error.message : String(error)}`
    )
  } finally {
    unsubscribe()
  }
}

function unmanagedInstall(executable: string): InstalledCodeServer {
  return { executable, version: null, previousExecutable: null, previousVersion: null }
}

export async function markCodeServerHealthy(version: string | null): Promise<void> {
  if (version) {
    await getCodeServerResourceManager().markHealthy(process.platform, process.arch, version)
  }
}

export async function discardFailedCodeServer(version: string | null): Promise<void> {
  if (version) {
    await getCodeServerResourceManager().discardFailed(process.platform, process.arch, version)
  }
}

async function prepareMacosExecutable(executable: string): Promise<void> {
  if (process.platform !== 'darwin') {
    return
  }
  await runProcess({
    program: 'xattr',
    args: ['-dr', 'com.apple.quarantine', executable],
    timeoutMs: 30_000
  }).catch(() => undefined)
  await adhocSignBundledBinaries(dirname(executable)).catch(() => undefined)
}
