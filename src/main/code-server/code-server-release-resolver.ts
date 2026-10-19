import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { compareAppVersions, isValidAppVersion } from '../../shared/app-version'
import { getMainHttpClient } from '../network/http-client'
import {
  codeServerFallbackAsset,
  codeServerResourceTarget,
  type CodeServerResourceAsset,
  type CodeServerResourceTarget
} from './code-server-resource-catalog'
import { CODE_SERVER_VERSION, getCodeServerCacheRoot } from './code-server-paths'

const LATEST_RELEASE_URL = 'https://api.github.com/repos/coder/code-server/releases/latest'
const RELEASE_CACHE_TTL_MS = 24 * 60 * 60 * 1_000
const SHA256_DIGEST = /^sha256:([a-f0-9]{64})$/

type CachedRelease = {
  checkedAt: number
  version: string
  assets: CodeServerResourceAsset[]
}

let inFlight: Promise<CachedRelease | null> | null = null

export async function resolveCodeServerReleaseAsset(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
  options: { allowNetwork?: boolean } = {}
): Promise<CodeServerResourceAsset> {
  const target = codeServerResourceTarget(platform, arch)
  const release = await resolveLatestCompatibleRelease(options.allowNetwork !== false).catch(
    () => null
  )
  return release?.assets.find((asset) => asset.target === target) ?? codeServerFallbackAsset(target)
}

export async function refreshCodeServerRelease(): Promise<void> {
  await resolveLatestCompatibleRelease(true).catch(() => null)
}

export function resetCodeServerReleaseResolverForTests(): void {
  inFlight = null
}

async function resolveLatestCompatibleRelease(
  allowNetwork: boolean
): Promise<CachedRelease | null> {
  const cached = await readCachedRelease()
  if ((cached && Date.now() - cached.checkedAt < RELEASE_CACHE_TTL_MS) || !allowNetwork) {
    return cached
  }
  inFlight ??= fetchLatestCompatibleRelease()
    .then(async (release) => {
      if (release) {
        await writeCachedRelease(release)
      }
      return release ?? cached
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

async function fetchLatestCompatibleRelease(): Promise<CachedRelease | null> {
  const response = await getMainHttpClient().fetch(LATEST_RELEASE_URL, {
    signal: AbortSignal.timeout(15_000),
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Orca-Code-Server'
    }
  })
  if (!response.ok) {
    await response.body?.cancel()
    return null
  }
  const parsed = parseGithubRelease(await response.json())
  if (!parsed || compareAppVersions(parsed.version, CODE_SERVER_VERSION) < 0) {
    return null
  }
  return { ...parsed, checkedAt: Date.now() }
}

function parseGithubRelease(value: unknown): Omit<CachedRelease, 'checkedAt'> | null {
  if (!isRecord(value) || value.draft === true || value.prerelease === true) {
    return null
  }
  const tag = typeof value.tag_name === 'string' ? value.tag_name : ''
  const version = tag.replace(/^v/, '')
  if (!isCompatibleVersion(version) || !Array.isArray(value.assets)) {
    return null
  }
  const assets = value.assets.flatMap((asset) => parseGithubAsset(version, asset))
  return assets.length > 0 ? { version, assets } : null
}

function parseGithubAsset(version: string, value: unknown): CodeServerResourceAsset[] {
  if (!isRecord(value)) {
    return []
  }
  const name = typeof value.name === 'string' ? value.name : ''
  const url = typeof value.browser_download_url === 'string' ? value.browser_download_url : ''
  const size = typeof value.size === 'number' ? value.size : -1
  const digest = typeof value.digest === 'string' ? SHA256_DIGEST.exec(value.digest) : null
  const target = targetForArchiveName(version, name)
  if (!target || !url.startsWith('https://github.com/coder/code-server/releases/download/')) {
    return []
  }
  if (!digest || !Number.isSafeInteger(size) || size <= 0 || size > 300 * 1024 * 1024) {
    return []
  }
  const fallback = codeServerFallbackAsset(target)
  return [
    { ...fallback, version, archiveName: name, url, archiveSha256: digest[1], downloadBytes: size }
  ]
}

function targetForArchiveName(version: string, name: string): CodeServerResourceTarget | null {
  const suffixes: Record<string, CodeServerResourceTarget> = {
    [`code-server-${version}-windows-amd64.tar.gz`]: 'win32-x64',
    [`code-server-${version}-macos-amd64.tar.gz`]: 'darwin-x64',
    [`code-server-${version}-macos-arm64.tar.gz`]: 'darwin-arm64',
    [`code-server-${version}-linux-amd64.tar.gz`]: 'linux-x64',
    [`code-server-${version}-linux-arm64.tar.gz`]: 'linux-arm64'
  }
  return suffixes[name] ?? null
}

function isCompatibleVersion(version: string): boolean {
  return isValidAppVersion(version) && version.split('.')[0] === CODE_SERVER_VERSION.split('.')[0]
}

async function readCachedRelease(): Promise<CachedRelease | null> {
  try {
    const value: unknown = JSON.parse(await readFile(releaseCachePath(), 'utf8'))
    if (!isRecord(value) || typeof value.checkedAt !== 'number') {
      return null
    }
    const release = parseCachedRelease(value)
    return release ? { ...release, checkedAt: value.checkedAt } : null
  } catch {
    return null
  }
}

function parseCachedRelease(
  value: Record<string, unknown>
): Omit<CachedRelease, 'checkedAt'> | null {
  if (typeof value.version !== 'string' || !isCompatibleVersion(value.version)) {
    return null
  }
  if (!Array.isArray(value.assets)) {
    return null
  }
  const assets = value.assets.filter(isCachedAsset)
  return assets.length > 0 ? { version: value.version, assets } : null
}

function isCachedAsset(value: unknown): value is CodeServerResourceAsset {
  if (!isRecord(value)) {
    return false
  }
  if (!isCodeServerResourceTarget(value.target)) {
    return false
  }
  try {
    const fallback = codeServerFallbackAsset(value.target)
    return (
      value.platform === fallback.platform &&
      value.arch === fallback.arch &&
      typeof value.version === 'string' &&
      typeof value.archiveName === 'string' &&
      typeof value.url === 'string' &&
      typeof value.archiveSha256 === 'string' &&
      SHA256_DIGEST.test(`sha256:${value.archiveSha256}`) &&
      typeof value.downloadBytes === 'number'
    )
  } catch {
    return false
  }
}

function isCodeServerResourceTarget(value: unknown): value is CodeServerResourceTarget {
  return (
    value === 'win32-x64' ||
    value === 'darwin-x64' ||
    value === 'darwin-arm64' ||
    value === 'linux-x64' ||
    value === 'linux-arm64'
  )
}

async function writeCachedRelease(release: CachedRelease): Promise<void> {
  const target = releaseCachePath()
  await mkdir(dirname(target), { recursive: true })
  const staging = `${target}.${process.pid}.tmp`
  await writeFile(staging, JSON.stringify(release), 'utf8')
  try {
    await rename(staging, target)
  } catch {
    await writeFile(target, JSON.stringify(release), 'utf8')
    await rm(staging, { force: true }).catch(() => undefined)
  }
}

function releaseCachePath(): string {
  return join(getCodeServerCacheRoot(), 'latest-release.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
