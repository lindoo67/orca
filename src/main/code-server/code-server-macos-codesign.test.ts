import { describe, expect, it } from 'vitest'
import { classifyForSigning, parseMachOFiles } from './code-server-macos-codesign'

describe('parseMachOFiles', () => {
  it('keeps Mach-O lines and drops the rest', () => {
    const output = [
      '/root/lib/node: Mach-O 64-bit executable arm64',
      '/root/readme.txt: ASCII text',
      '/root/lib/vscode/node_modules/@vscode/ripgrep/bin/rg: Mach-O 64-bit executable arm64',
      '/root/script.sh: POSIX shell script text executable, ASCII text'
    ].join('\n')
    expect(parseMachOFiles(output)).toEqual([
      '/root/lib/node',
      '/root/lib/vscode/node_modules/@vscode/ripgrep/bin/rg'
    ])
  })

  it('handles paths containing spaces (Application Support)', () => {
    const output =
      '/Users/x/Library/Application Support/orca-dev/code-server/lib/node: Mach-O 64-bit executable arm64'
    expect(parseMachOFiles(output)).toEqual([
      '/Users/x/Library/Application Support/orca-dev/code-server/lib/node'
    ])
  })

  it('returns nothing for empty output', () => {
    expect(parseMachOFiles('')).toEqual([])
  })

  it('captures a universal binary once, dropping its per-architecture sub-lines', () => {
    // `file` prints a universal binary as three lines: two "(for architecture X)"
    // sub-entries separated by a colon+TAB, then the real path with colon+space.
    // Only the real path must be captured (and signed).
    const output = [
      '/root/kerberos.node (for architecture arm64):\tMach-O 64-bit bundle arm64',
      '/root/kerberos.node (for architecture x86_64):\tMach-O 64-bit bundle x86_64',
      '/root/kerberos.node: Mach-O universal binary with 2 architectures: [x86_64] [arm64]'
    ].join('\n')
    expect(parseMachOFiles(output)).toEqual(['/root/kerberos.node'])
  })
})

describe('classifyForSigning', () => {
  it('signs a binary with a valid signature (authentic vendor or adhoc)', () => {
    expect(classifyForSigning({ code: 0, stderr: '' })).toBe('sign')
  })

  it('signs a binary shipped unsigned', () => {
    expect(classifyForSigning({ code: 1, stderr: 'rg: code object is not signed at all\n' })).toBe(
      'sign'
    )
  })

  it('skips a binary whose present signature fails verification (possible tampering)', () => {
    expect(
      classifyForSigning({
        code: 1,
        stderr: 'node: invalid signature (code or signature have been modified)\n'
      })
    ).toBe('skip')
  })
})
