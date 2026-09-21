import { beforeEach, describe, expect, it, vi } from 'vitest'

const { readFileMock, writeFileMock, productJsonPathMock } = vi.hoisted(() => ({
  readFileMock: vi.fn(),
  writeFileMock: vi.fn<(path: string, contents: string) => Promise<void>>(() => Promise.resolve()),
  productJsonPathMock: vi.fn<() => string | null>(() => '/root/lib/vscode/product.json')
}))

vi.mock('node:fs/promises', () => ({ readFile: readFileMock, writeFile: writeFileMock }))
vi.mock('./code-server-paths', () => ({ resolveCodeServerProductJson: productJsonPathMock }))

import { disableExtensionSignatureVerification } from './code-server-signature-verification'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseWrittenProductJson(callIndex = 0): Record<string, unknown> {
  const contents = writeFileMock.mock.calls[callIndex]?.[1]
  if (typeof contents !== 'string') {
    throw new Error('product.json write contents were not captured')
  }
  const parsed: unknown = JSON.parse(contents)
  if (!isRecord(parsed)) {
    throw new Error('product.json write contents were not an object')
  }
  return parsed
}

describe('disableExtensionSignatureVerification', () => {
  beforeEach(() => {
    readFileMock.mockReset()
    writeFileMock.mockReset()
    writeFileMock.mockResolvedValue(undefined)
    productJsonPathMock.mockReset()
    productJsonPathMock.mockReturnValue('/root/lib/vscode/product.json')
  })

  it('adds extensions.verifySignature=false, preserving existing defaults', async () => {
    readFileMock.mockResolvedValue(
      JSON.stringify({ nameShort: 'code-server', configurationDefaults: { 'editor.fontSize': 14 } })
    )
    await disableExtensionSignatureVerification()
    expect(writeFileMock).toHaveBeenCalledTimes(1)
    const [path] = writeFileMock.mock.calls[0]
    expect(path).toBe('/root/lib/vscode/product.json')
    const written = parseWrittenProductJson()
    expect(written.configurationDefaults).toEqual({
      'editor.fontSize': 14,
      'extensions.verifySignature': false
    })
    // Untouched product fields survive the rewrite.
    expect(written.nameShort).toBe('code-server')
  })

  it('adds the key when configurationDefaults is absent', async () => {
    readFileMock.mockResolvedValue(JSON.stringify({ nameShort: 'code-server' }))
    await disableExtensionSignatureVerification()
    const written = parseWrittenProductJson()
    expect(written.configurationDefaults).toEqual({ 'extensions.verifySignature': false })
  })

  it('is idempotent: does not rewrite when already disabled', async () => {
    readFileMock.mockResolvedValue(
      JSON.stringify({ configurationDefaults: { 'extensions.verifySignature': false } })
    )
    await disableExtensionSignatureVerification()
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it('no-ops when product.json cannot be resolved', async () => {
    productJsonPathMock.mockReturnValue(null)
    await disableExtensionSignatureVerification()
    expect(readFileMock).not.toHaveBeenCalled()
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it('does not throw when the file is unreadable', async () => {
    readFileMock.mockRejectedValue(new Error('EACCES'))
    await expect(disableExtensionSignatureVerification()).resolves.toBeUndefined()
    expect(writeFileMock).not.toHaveBeenCalled()
  })
})
