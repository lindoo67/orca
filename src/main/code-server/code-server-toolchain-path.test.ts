import { describe, expect, it } from 'vitest'
import { delimiter } from 'node:path'
import { promoteVersionManagerShims } from './code-server-toolchain-path'

describe('promoteVersionManagerShims', () => {
  it('moves shim dirs ahead of a shell-activated resolved-version dir', () => {
    // The real regression: mise's activated PATH puts installs/ruby/latest/bin
    // before the shims, so the extension host ran the wrong Ruby for a worktree.
    const input = [
      '/Users/me/.local/share/mise/installs/ruby/latest/bin',
      '/Users/me/.asdf/shims',
      '/Users/me/.local/share/mise/shims',
      '/opt/homebrew/bin',
      '/usr/bin'
    ].join(delimiter)
    expect(promoteVersionManagerShims(input).split(delimiter)).toEqual([
      '/Users/me/.asdf/shims',
      '/Users/me/.local/share/mise/shims',
      '/Users/me/.local/share/mise/installs/ruby/latest/bin',
      '/opt/homebrew/bin',
      '/usr/bin'
    ])
  })

  it('preserves relative order within shims and within the rest', () => {
    const input = ['/a/bin', '/x/shims', '/b/bin', '/y/shims'].join(delimiter)
    expect(promoteVersionManagerShims(input).split(delimiter)).toEqual([
      '/x/shims',
      '/y/shims',
      '/a/bin',
      '/b/bin'
    ])
  })

  it('de-dupes repeated entries, keeping first occurrence (shims win)', () => {
    // Activated PATH commonly lists a shim dir twice (once baked, once base).
    const input = ['/m/shims', '/usr/bin', '/m/shims', '/usr/bin'].join(delimiter)
    expect(promoteVersionManagerShims(input).split(delimiter)).toEqual(['/m/shims', '/usr/bin'])
  })

  it('leaves PATH untouched when there are no shim dirs', () => {
    const input = ['/opt/homebrew/bin', '/usr/bin', '/bin'].join(delimiter)
    expect(promoteVersionManagerShims(input)).toBe(input)
  })

  it('matches a shim dir with a trailing separator', () => {
    const input = [`/m/shims${'/'}`, '/usr/bin'].join(delimiter)
    expect(promoteVersionManagerShims(input).split(delimiter)[0]).toBe('/m/shims/')
  })

  it('returns empty string for undefined/empty input', () => {
    expect(promoteVersionManagerShims(undefined)).toBe('')
    expect(promoteVersionManagerShims('')).toBe('')
  })

  it('does not treat a non-terminal "shims" path component as a shim dir', () => {
    const input = ['/opt/shims/tool/bin', '/usr/bin'].join(delimiter)
    expect(promoteVersionManagerShims(input)).toBe(input)
  })
})
