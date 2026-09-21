import { app } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

// Pinned code-server release. Bump manually via PR; verify latest stable at
// https://github.com/coder/code-server/releases before changing.
export const CODE_SERVER_VERSION = '4.138.0'

function getCodeServerReleasePlatform(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return 'windows'
  }
  if (platform === 'darwin') {
    return 'macos'
  }
  return platform
}

function getCodeServerReleaseArch(arch: NodeJS.Architecture = process.arch): string {
  return arch === 'x64' ? 'amd64' : arch
}

function getCodeServerVendorPlatformArch(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch
): string {
  return `${platform}-${arch}`
}

export function getCodeServerVendorDirectoryName(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch
): string {
  return `code-server-${CODE_SERVER_VERSION}-${getCodeServerReleasePlatform(platform)}-${getCodeServerReleaseArch(arch)}`
}

export function getCodeServerReleaseAssetName(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture
): string {
  return `${getCodeServerVendorDirectoryName(platform, arch)}.tar.gz`
}

function getCodeServerExecutableName(): string {
  return process.platform === 'win32' ? 'code-server.cmd' : 'code-server'
}

export function getCodeServerCacheRoot(): string {
  return join(app.getPath('userData'), 'code-server')
}

export function getCodeServerUserDataDir(): string {
  return join(getCodeServerCacheRoot(), 'user-data')
}

export function getCodeServerExtensionsDir(): string {
  return join(getCodeServerCacheRoot(), 'extensions')
}

export function getCodeServerPidFilePath(): string {
  return join(getCodeServerCacheRoot(), 'code-server.pid')
}

// install.sh --prefix <root> installs to <root>/lib/code-server-<version>
// and symlinks <root>/bin/code-server.
// On Windows (npm -g --prefix <root>): also checks bin/code-server.cmd and
// node_modules/.bin/code-server.cmd.
// Resolution order: env override → bundled (app/resources) → user data install → system npm.
export function resolveCodeServerExecutable(): string | null {
  const override = process.env.ORCA_CODE_SERVER_PATH
  if (override && existsSync(override)) {
    return override
  }
  // Check bundled code-server first (ships via resources/code-server/vendor).
  const bundled = resolveBundledCodeServerExecutable()
  if (bundled) {
    return bundled
  }
  // Fall back to user-data install (runtime-installed or pre-built).
  const root = getCodeServerCacheRoot()
  const ext = process.platform === 'win32' ? '.exe' : ''
  const candidates: string[] = [
    join(root, 'lib', `code-server-${CODE_SERVER_VERSION}`, 'bin', `code-server${ext}`),
    join(root, 'bin', `code-server${ext}`)
  ]
  // npm -g --prefix on Windows puts code-server.cmd in bin/ and also under
  // node_modules/.bin/ — check both so we resolve regardless of how it was installed.
  if (process.platform === 'win32') {
    candidates.push(
      join(root, 'bin', 'code-server.cmd'),
      join(root, 'node_modules', '.bin', 'code-server.cmd')
    )
  }
  // System npm global install (Windows: %APPDATA%/npm/node_modules/code-server/).
  const npmGlobal = resolveNpmGlobalCodeServer()
  if (npmGlobal) {
    candidates.push(npmGlobal)
  }
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

// Resolve code-server installed via `npm install -g code-server` on the system.
function resolveNpmGlobalCodeServer(): string | null {
  const prefix = getNpmGlobalPrefix()
  if (!prefix) {
    return null
  }
  // npm -g on Windows: <prefix>/node_modules/code-server/bin/code-server.cmd
  const ext = process.platform === 'win32' ? '.cmd' : ''
  const candidates = [
    join(prefix, 'node_modules', 'code-server', 'bin', `code-server${ext}`),
    join(prefix, 'lib', 'node_modules', 'code-server', 'bin', `code-server${ext}`)
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

// Get the npm global install prefix. Falls back to the environment variable or
// the platform default.
function getNpmGlobalPrefix(): string | null {
  const env = process.env.npm_config_prefix
  if (env && existsSync(env)) {
    return env
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA
    if (appData) {
      return join(appData, 'npm')
    }
    return null
  }
  // Linux/macOS default
  return '/usr/local'
}

function resolveBundledCodeServerExecutable(): string | null {
  const executableName = getCodeServerExecutableName()
  const candidates = getCodeServerResourceRoots().map((root) =>
    join(
      root,
      'code-server',
      'vendor',
      getCodeServerVendorPlatformArch(),
      getCodeServerVendorDirectoryName(),
      'bin',
      executableName
    )
  )
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

export function resolveBundledCodeServerDirectory(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture
): string | null {
  const platformArch = getCodeServerVendorPlatformArch(platform, arch)
  const directoryName = getCodeServerVendorDirectoryName(platform, arch)
  const candidates = getCodeServerResourceRoots().map((root) =>
    join(root, 'code-server', 'vendor', platformArch, directoryName)
  )
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

export function resolveBundledCodeServerArchive(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture
): string | null {
  const platformArch = getCodeServerVendorPlatformArch(platform, arch)
  const archiveName = getCodeServerReleaseAssetName(platform, arch)
  const candidates = getCodeServerResourceRoots().map((root) =>
    join(root, 'code-server', 'vendor', platformArch, archiveName)
  )
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

function getCodeServerResourceRoots(): string[] {
  return [
    process.resourcesPath,
    join(process.cwd(), 'resources'),
    resolve(__dirname, '../../resources')
  ].filter((root): root is string => Boolean(root))
}

// code-server's bundled VS Code product.json lives one level up from the
// executable's bin/ dir (…/code-server-<version>/lib/vscode/product.json).
// Used to apply distribution-scoped configuration defaults to the embedded
// editor without touching the user's real settings.json.
export function resolveCodeServerProductJson(): string | null {
  const exe = resolveCodeServerExecutable()
  if (!exe) {
    return null
  }
  const productJson = join(dirname(exe), '..', 'lib', 'vscode', 'product.json')
  return existsSync(productJson) ? productJson : null
}

// Vendored copy of code-server's official install.sh, shipped via extraResources.
export function resolveCodeServerInstallScript(): string | null {
  const override = process.env.ORCA_CODE_SERVER_INSTALL_SCRIPT
  if (override && existsSync(override)) {
    return override
  }
  const packaged = [join(process.resourcesPath ?? '', 'code-server', 'install.sh')]
  const dev = [
    join(process.cwd(), 'resources/code-server/install.sh'),
    resolve(__dirname, '../../resources/code-server/install.sh')
  ]
  const candidates = process.resourcesPath ? [...packaged, ...dev] : dev
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null
}
