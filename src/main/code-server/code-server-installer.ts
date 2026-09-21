import { mkdir, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runProcess, spawnProcess } from '../../shared/child-process/run-process'
import {
  CODE_SERVER_VERSION,
  getCodeServerCacheRoot,
  resolveCodeServerExecutable,
  resolveCodeServerInstallScript
} from './code-server-paths'
import { adhocSignBundledBinaries } from './code-server-macos-codesign'

export type InstallProgress = (fraction: number) => void

type InstallErrorCode =
  | 'missing-prereq'
  | 'unsupported-arch'
  | 'download-failed'
  | 'no-install-script'

export class CodeServerInstallError extends Error {
  readonly code: InstallErrorCode
  constructor(code: InstallErrorCode, message: string) {
    super(message)
    this.name = 'CodeServerInstallError'
    this.code = code
  }
}

let inFlight: Promise<string> | null = null

// Idempotent, single-flight ensure-installed. Runs the vendored install.sh with
// --method standalone (bundles its own Node; no system-Node dependency).
export function ensureCodeServerInstalled(onProgress?: InstallProgress): Promise<string> {
  const existing = resolveCodeServerExecutable()
  if (existing) {
    // macOS: strip quarantine on the pre-bundled binary so it can execute.
    // Only needed for the bundled path (runtime-installed binaries go through
    // runInstall which does this already).
    if (process.platform === 'darwin') {
      const exeDir = dirname(existing)
      void runProcess({
        program: 'xattr',
        args: ['-dr', 'com.apple.quarantine', existing],
        timeoutMs: 30_000
      }).catch(() => undefined)
      // Ad-hoc sign so Gatekeeper doesn't freeze the binary at first launch.
      void adhocSignBundledBinaries(exeDir).catch(() => undefined)
    }
    return Promise.resolve(existing)
  }
  if (inFlight) {
    return inFlight
  }
  inFlight = runInstall(onProgress).finally(() => {
    inFlight = null
  })
  return inFlight
}

async function runInstall(onProgress?: InstallProgress): Promise<string> {
  // Shell scripts need a POSIX shell — only available natively on macOS/Linux.
  if (process.platform === 'win32') {
    return installWindows(onProgress)
  }

  const script = resolveCodeServerInstallScript()
  if (!script) {
    throw new CodeServerInstallError('no-install-script', 'code-server installer not found.')
  }
  const realRoot = getCodeServerCacheRoot()
  // install.sh's `sh_c` runs commands via `sh -c "$*"`, which re-splits the
  // prefix on whitespace, so a `--prefix` containing a space (macOS userData
  // lives under "Application Support") makes its internal `mkdir` build the
  // wrong dirs, the prefix ends up "not writable", and the script escalates to
  // `sudo` (which fails in Electron's non-interactive spawn). When the real
  // location has a space, install into a space-free staging prefix and relocate
  // the result ourselves with Node fs (space-safe).
  const needsStaging = /\s/.test(realRoot)
  const stagingRoot = needsStaging ? join(tmpdir(), 'orca-code-server-install') : null
  const installPrefix = stagingRoot ?? realRoot
  onProgress?.(0)

  const cleanupTargets = async (): Promise<void> => {
    await rm(realRoot, { recursive: true, force: true }).catch(() => {})
    if (stagingRoot) {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => {})
    }
  }

  if (stagingRoot) {
    // Start from a clean staging dir so install.sh's "already installed" guard
    // (it exits 0 without installing) can't short-circuit a fresh attempt.
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => {})
  }

  await new Promise<void>((resolvePromise, reject) => {
    const child = spawnProcess({
      program: 'sh',
      args: [
        script,
        '--method',
        'standalone',
        '--prefix',
        installPrefix,
        '--version',
        CODE_SERVER_VERSION
      ],
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stderr = ''
    // install.sh does not emit machine-readable progress; surface indeterminate
    // motion by nudging toward, but never reaching, completion.
    let ticks = 0
    child.stdout?.on('data', () => {
      ticks += 1
      onProgress?.(Math.min(0.9, ticks / 40))
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', (err) =>
      reject(
        new CodeServerInstallError('missing-prereq', `Failed to run installer: ${err.message}`)
      )
    )
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      const message = stderr.trim() || `installer exited with code ${code}`
      // install.sh's real sentinel for an unsupported CPU arch (i686, armv7l, riscv64, s390x, ...)
      // is "no standalone releases for $ARCH"; none of those values contain "arch" itself.
      const errorCode: InstallErrorCode = /no standalone releases for/i.test(message)
        ? 'unsupported-arch'
        : /curl|tar|wget|command not found/i.test(message)
          ? 'missing-prereq'
          : 'download-failed'
      reject(new CodeServerInstallError(errorCode, message))
    })
  }).catch(async (err) => {
    // Clean up a partial install so the next attempt starts fresh.
    await cleanupTargets()
    throw err
  })

  if (stagingRoot) {
    await relocateInstall(stagingRoot, realRoot).catch(async (err: unknown) => {
      await cleanupTargets()
      throw new CodeServerInstallError(
        'download-failed',
        `Failed to move code-server into place: ${err instanceof Error ? err.message : String(err)}`
      )
    })
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => {})
  }

  // macOS: strip the quarantine attribute so the bundled binary can execute.
  if (process.platform === 'darwin') {
    await runProcess({
      program: 'xattr',
      args: ['-dr', 'com.apple.quarantine', realRoot],
      timeoutMs: 30_000
    }).catch(() => undefined)
    // Ad-hoc sign the bundled binaries before their first launch so macOS's
    // online Gatekeeper notarization assessment can't freeze code-server's
    // startup for ~120s on Apple Silicon. See code-server-macos-codesign.ts.
    await adhocSignBundledBinaries(realRoot)
  }

  onProgress?.(1)
  const exe = resolveCodeServerExecutable()
  if (!exe) {
    // Mirror the spawn-failure cleanup so a botched install doesn't wedge future retries.
    await cleanupTargets()
    throw new CodeServerInstallError('download-failed', 'code-server missing after install.')
  }
  return exe
}

// Move the self-contained code-server-<version> tree from the staging prefix to
// the real (possibly space-containing) location using Node fs, which handles
// spaces correctly. Only the versioned lib dir is relocated; install.sh's
// prefix/bin symlink is disposable because resolveCodeServerExecutable resolves
// the real binary under lib/code-server-<version>/bin directly.
async function relocateInstall(stagingRoot: string, realRoot: string): Promise<void> {
  const versionDirName = `code-server-${CODE_SERVER_VERSION}`
  const from = join(stagingRoot, 'lib', versionDirName)
  const to = join(realRoot, 'lib', versionDirName)
  await mkdir(join(realRoot, 'lib'), { recursive: true })
  await rm(to, { recursive: true, force: true }).catch(() => {})
  try {
    await rename(from, to)
  } catch (err) {
    // rename fails across filesystems (os tmp may be a different volume than
    // userData); fall back to a recursive copy. `cp -R` takes its paths as argv
    // (not re-split like install.sh's sh_c) so spaces are safe, and it copies
    // the tree's internal symlinks verbatim.
    if (!isErrnoException(err) || err.code !== 'EXDEV') {
      throw err
    }
    await copyTreeWithCp(from, to)
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function copyTreeWithCp(from: string, to: string): Promise<void> {
  return runProcess({
    program: 'cp',
    args: ['-R', from, to],
    timeoutMs: null
  }).then((result) => {
    if (result.code !== 0) {
      throw new Error(`cp exited with code ${result.code}`)
    }
  })
}

async function installWindows(onProgress?: InstallProgress): Promise<string> {
  const existing = resolveCodeServerExecutable()
  if (existing) {
    return existing
  }
  onProgress?.(0)
  throw new CodeServerInstallError(
    'no-install-script',
    'Bundled code-server is missing. Run pnpm prepare:code-server before packaging.'
  )
}
