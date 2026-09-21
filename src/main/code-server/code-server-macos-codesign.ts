import { runProcess } from '../../shared/child-process/run-process'

// Fresh code-server bundles ripgrep and several native .node modules UNSIGNED,
// and its Node binary carries a Developer-ID signature. On Apple Silicon the
// first execution in Orca's responsible-process context makes macOS run an
// online Gatekeeper notarization assessment (syspolicyd) that errors
// ("notarization daemon: 3") and freezes the process for ~120s before the OS
// ad-hoc-signs the binaries itself. Doing that ad-hoc signing up front, at
// install time, keeps the first launch instant. A vendor-signed binary is
// signature-verified first so we only ever strip a signature we could
// authenticate (tamper guard), never blessing a modified download.

type CommandResult = { code: number | null; stdout: string; stderr: string }

function run(command: string, args: string[]): Promise<CommandResult> {
  return runProcess({ program: command, args, timeoutMs: 120_000 }).catch((error) => ({
    code: null,
    stdout: '',
    stderr: error instanceof Error ? error.message : String(error)
  }))
}

// Parse `file`'s "<path>: <description>" lines and keep the Mach-O ones. Paths
// can contain spaces (userData lives under "Application Support"), so we split
// on the first ": " rather than whitespace.
export function parseMachOFiles(fileOutput: string): string[] {
  const files: string[] = []
  for (const line of fileOutput.split('\n')) {
    const match = /^(.*?): .*Mach-O/.exec(line)
    if (match) {
      files.push(match[1])
    }
  }
  return files
}

// Decide what to do with a binary from its `codesign --verify --strict` result.
// - exit 0: a valid signature (vendor or ad-hoc), authenticated, safe to re-sign.
// - unsigned as shipped: no signature to lose, safe to ad-hoc sign.
// - present but invalid: possible tampering, leave it alone, don't strip.
export function classifyForSigning(verify: {
  code: number | null
  stderr: string
}): 'sign' | 'skip' {
  if (verify.code === 0) {
    return 'sign'
  }
  const unsigned = /is not signed at all|not signed/i.test(verify.stderr)
  return unsigned ? 'sign' : 'skip'
}

async function listMachOFiles(root: string): Promise<string[]> {
  // Narrow to plausible binaries (executables + native module/dylib extensions)
  // so `file` only classifies a handful of candidates, not the whole tree.
  const { stdout } = await run('sh', [
    '-c',
    'find "$1" \\( -perm -u+x -o -name "*.node" -o -name "*.dylib" -o -name "*.so" \\) -type f ! -type l -print0 | xargs -0 file',
    'sh',
    root
  ])
  return parseMachOFiles(stdout)
}

async function adhocSignIfSafe(file: string): Promise<void> {
  const verify = await run('codesign', ['--verify', '--strict', file])
  if (classifyForSigning(verify) === 'skip') {
    console.warn(`[code-server] Skipping ad-hoc sign of ${file}: signature failed verification`)
    return
  }
  const sign = await run('codesign', ['--force', '--sign', '-', file])
  if (sign.code !== 0) {
    console.warn(`[code-server] Failed to ad-hoc sign ${file}: ${sign.stderr.trim()}`)
  }
}

export async function adhocSignBundledBinaries(root: string): Promise<void> {
  if (process.platform !== 'darwin') {
    return
  }
  try {
    for (const file of await listMachOFiles(root)) {
      await adhocSignIfSafe(file)
    }
  } catch (error) {
    // Best-effort: without signing the first launch may stall on Gatekeeper, but
    // the editor still works. Never block install on it.
    console.warn('[code-server] Ad-hoc signing step failed:', error)
  }
}
