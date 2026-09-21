import { delimiter } from 'node:path'

// Version managers (mise, asdf, rbenv, pyenv, nodenv, etc.) resolve the correct
// tool version per directory through executables in a `.../shims` dir on PATH.
// A login shell's *activated* PATH, what hydrateShellPath captures, bakes the
// globally-resolved install dirs (e.g. `.../mise/installs/ruby/latest/bin`)
// AHEAD of those shims. The code-server extension host is one long-lived process
// shared across every worktree and never re-runs the shell's per-directory hook,
// so a baked "latest" dir would win everywhere and run the wrong Ruby/Node for a
// worktree that pins a different version (e.g. `bundle` executing against a
// Gemfile.lock whose git gems were installed under the pinned Ruby: "not yet
// checked out"). Promoting shim dirs to the front makes each invocation resolve
// the worktree's own version, matching how a terminal behaves after `cd`.
const SHIM_DIR_RE = /[\\/]shims[\\/]?$/

/**
 * Reorder a PATH so version-manager shim directories come first, so tools in the
 * code-server extension host resolve per-worktree versions. Preserves relative
 * order within shims and within the rest, de-duping while keeping first
 * occurrence. Returns the value unchanged when there are no shim dirs.
 */
export function promoteVersionManagerShims(pathValue: string | undefined): string {
  const value = pathValue ?? ''
  const segments = value.split(delimiter).filter(Boolean)
  const shims: string[] = []
  const rest: string[] = []
  for (const segment of segments) {
    ;(SHIM_DIR_RE.test(segment) ? shims : rest).push(segment)
  }
  if (shims.length === 0) {
    return value
  }
  const seen = new Set<string>()
  const ordered = [...shims, ...rest].filter((segment) => {
    if (seen.has(segment)) {
      return false
    }
    seen.add(segment)
    return true
  })
  return ordered.join(delimiter)
}
