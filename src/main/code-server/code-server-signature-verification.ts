import { readFile, writeFile } from 'node:fs/promises'
import { resolveCodeServerProductJson } from './code-server-paths'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

// The macOS standalone code-server build ships without the @vscode/vsce-sign
// native module, so extension signature verification "was not executed" and
// installs from Open VSX are refused (coder/code-server#7213). Default the
// setting off in code-server's own product.json, a distribution-scoped
// default, the same approach VSCodium uses for Open VSX, so the embedded
// editor can install extensions. We deliberately do NOT write it into
// settings.json: that file is symlinked to the user's real VS Code config and
// drives their desktop editor, which should keep verifying MS-signed
// extensions. Idempotent so it can run on every start (fixing existing
// installs too, not just fresh ones).
export async function disableExtensionSignatureVerification(): Promise<void> {
  const productJsonPath = resolveCodeServerProductJson()
  if (!productJsonPath) {
    return
  }
  try {
    const parsed: unknown = JSON.parse(await readFile(productJsonPath, 'utf8'))
    const product = isRecord(parsed) ? parsed : {}
    const defaults = isRecord(product.configurationDefaults) ? product.configurationDefaults : {}
    if (defaults['extensions.verifySignature'] === false) {
      return // already patched; avoid a needless write on every start
    }
    product.configurationDefaults = { ...defaults, 'extensions.verifySignature': false }
    await writeFile(productJsonPath, `${JSON.stringify(product, null, 2)}\n`, 'utf8')
  } catch (error) {
    // A missing/locked/malformed product.json shouldn't block the editor from
    // starting; extension installs simply keep failing until it's writable.
    console.warn('[code-server] Could not disable extension signature verification:', error)
  }
}
