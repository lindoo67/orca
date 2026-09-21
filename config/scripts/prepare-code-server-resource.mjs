import { createWriteStream, rmSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const CODE_SERVER_VERSION = '4.138.0'

const projectRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))

export function codeServerReleasePlatform(platform = process.platform) {
  if (platform === 'win32') {
    return 'windows'
  }
  if (platform === 'darwin') {
    return 'macos'
  }
  if (platform === 'linux') {
    return 'linux'
  }
  throw new Error(`Unsupported code-server platform: ${platform}`)
}

export function codeServerReleaseArch(arch = process.arch) {
  if (arch === 'x64') {
    return 'amd64'
  }
  if (arch === 'arm64') {
    return 'arm64'
  }
  throw new Error(`Unsupported code-server arch: ${arch}`)
}

export function codeServerVendorPlatformArch(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`
}

export function codeServerVendorDirectoryName(platform = process.platform, arch = process.arch) {
  return `code-server-${CODE_SERVER_VERSION}-${codeServerReleasePlatform(platform)}-${codeServerReleaseArch(arch)}`
}

export function codeServerReleaseAssetName(platform = process.platform, arch = process.arch) {
  return `${codeServerVendorDirectoryName(platform, arch)}.tar.gz`
}

function codeServerReleaseUrl(platform = process.platform, arch = process.arch) {
  const asset = codeServerReleaseAssetName(platform, arch)
  return `https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/${asset}`
}

async function download(url, destination) {
  const response = await fetch(url)
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download code-server: ${response.status} ${response.statusText}`)
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination))
}

function extractTarball(archivePath, destinationDir) {
  if (process.platform !== 'win32') {
    const result = spawnSync('tar', ['-xzf', archivePath, '-C', destinationDir], {
      stdio: 'inherit',
      windowsHide: true
    })
    if (result.error) {
      throw result.error
    }
    if (result.status !== 0) {
      throw new Error(`tar exited with code ${result.status}`)
    }
    return
  }

  const gzipResult = spawnSync('7z', ['x', archivePath, `-o${destinationDir}`, '-y'], {
    stdio: 'inherit',
    windowsHide: true
  })
  if (gzipResult.error) {
    throw gzipResult.error
  }
  if (gzipResult.status !== 0) {
    throw new Error(`7z gzip extraction exited with code ${gzipResult.status}`)
  }
  const tarPath = join(destinationDir, archivePath.split(/[\\/]/u).pop().replace(/\.gz$/u, ''))
  const tarResult = spawnSync('7z', ['x', tarPath, `-o${destinationDir}`, '-y'], {
    stdio: 'inherit',
    windowsHide: true
  })
  if (tarResult.error) {
    throw tarResult.error
  }
  if (tarResult.status !== 0) {
    throw new Error(`7z tar extraction exited with code ${tarResult.status}`)
  }
  rmSync(tarPath, { force: true })
}

export async function prepareCodeServerResource({
  platform = process.platform,
  arch = process.arch,
  root = projectRoot
} = {}) {
  const vendorRoot = join(root, 'resources', 'code-server', 'vendor')
  const platformRoot = join(vendorRoot, codeServerVendorPlatformArch(platform, arch))
  const directoryName = codeServerVendorDirectoryName(platform, arch)
  const destination = join(platformRoot, directoryName)
  const archivePath = join(platformRoot, codeServerReleaseAssetName(platform, arch))
  const shouldExtract =
    platform !== 'linux' || (platform === process.platform && arch === process.arch)

  await mkdir(platformRoot, { recursive: true })
  await rm(destination, { recursive: true, force: true })
  await download(codeServerReleaseUrl(platform, arch), archivePath)
  if (shouldExtract) {
    extractTarball(archivePath, platformRoot)
  }
  if (platform !== 'linux' || shouldExtract === false) {
    if (platform === 'linux' && shouldExtract === false) {
      return archivePath
    }
    await rm(archivePath, { force: true })
  }

  return destination
}

function parseTarget(value) {
  const [platform, arch] = value.split('-')
  if (!platform || !arch) {
    throw new Error(`Invalid code-server target: ${value}`)
  }
  return { platform, arch }
}

function uniqueTargets(targets) {
  const seen = new Set()
  return targets.filter(({ platform, arch }) => {
    const key = `${platform}-${arch}`
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

function parseTargets(argv) {
  const explicit = argv
    .filter((arg) => arg.startsWith('--target='))
    .map((arg) => parseTarget(arg.slice('--target='.length)))
  if (explicit.length > 0) {
    return uniqueTargets(explicit)
  }
  return uniqueTargets([
    { platform: process.platform, arch: process.arch },
    { platform: 'linux', arch: 'x64' },
    { platform: 'linux', arch: 'arm64' }
  ])
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  Promise.all(
    parseTargets(process.argv.slice(2)).map(async (target) => {
      const destination = await prepareCodeServerResource(target)
      console.log(`[code-server] prepared ${destination}`)
      return destination
    })
  )
    .then(() => {
      console.log('[code-server] all requested resources prepared')
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    })
}
