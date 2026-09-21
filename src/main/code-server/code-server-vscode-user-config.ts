import { existsSync } from 'node:fs'
import { lstat, mkdir, readlink, rm, symlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getCodeServerUserDataDir } from './code-server-paths'

// v1 targets stable "Code" only (Insiders / VSCodium are follow-ups).
function resolveRealVsCodeUserDir(): string | null {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Code', 'User')
  }
  if (process.platform === 'linux') {
    return join(homedir(), '.config', 'Code', 'User')
  }
  return null
}

// settings.json, keybindings.json and snippets are all mirrored verbatim via
// symlink: the embedded editor shares the user's real VS Code config, and edits
// made in either place flow straight back to the other. Regenerated on start.
const SYMLINKED_ENTRIES = ['settings.json', 'keybindings.json', 'snippets'] as const

// Idempotent; never blocks the editor from starting.
export async function mirrorVsCodeUserConfig(): Promise<void> {
  const realUserDir = resolveRealVsCodeUserDir()
  if (!realUserDir) {
    return
  }
  const codeServerUserDir = join(getCodeServerUserDataDir(), 'User')
  try {
    await mkdir(codeServerUserDir, { recursive: true })
  } catch (error) {
    console.warn('[code-server] Could not create user dir for config:', error)
    return
  }

  for (const entry of SYMLINKED_ENTRIES) {
    await linkEntry(join(realUserDir, entry), join(codeServerUserDir, entry))
  }
}

async function linkEntry(target: string, linkPath: string): Promise<void> {
  if (!existsSync(target)) {
    return // never create a dangling symlink; code-server falls back to defaults
  }
  try {
    const current = await lstat(linkPath).catch(() => null)
    if (current?.isSymbolicLink()) {
      const existingTarget = await readlink(linkPath).catch(() => null)
      if (existingTarget === target) {
        return // already correct
      }
    } else if (current?.isDirectory()) {
      return // a real dir already lives here; do not clobber user data
    }
    // Replace a stale symlink or a settings.json copy written by earlier Orca
    // versions (which merged settings into a copy instead of symlinking). Plain
    // files/symlinks under the code-server User dir are Orca-managed mirrors;
    // the real VS Code config is the source of truth, so removing one is safe.
    if (current) {
      await rm(linkPath, { force: true })
    }
    await symlink(target, linkPath)
  } catch (error) {
    // Permissions or a pre-existing file: log and continue with defaults.
    console.warn(`[code-server] Could not link ${target}:`, error)
  }
}
