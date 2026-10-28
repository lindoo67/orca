import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getCodeServerCacheRoot } from './code-server-paths'
import type { CodeServerResourceTarget } from './code-server-resource-catalog'

function ignoredReleasesPath(): string {
  return join(getCodeServerCacheRoot(), 'ignored-releases.json')
}

export async function isIgnoredCodeServerRelease(
  target: CodeServerResourceTarget,
  version: string
): Promise<boolean> {
  const current = await readIgnoredReleases()
  return current[target]?.includes(version) ?? false
}

export async function recordIgnoredCodeServerRelease(
  target: CodeServerResourceTarget,
  version: string
): Promise<void> {
  const current = await readIgnoredReleases()
  const versions = current[target] ?? []
  if (!versions.includes(version)) {
    current[target] = [...versions, version]
    await writeIgnoredReleases(current)
  }
}

export async function clearIgnoredCodeServerRelease(
  target: CodeServerResourceTarget,
  version: string
): Promise<void> {
  const current = await readIgnoredReleases()
  const versions = current[target]
  if (versions?.includes(version)) {
    current[target] = versions.filter((candidate) => candidate !== version)
    await writeIgnoredReleases(current)
  }
}

async function readIgnoredReleases(): Promise<Record<string, string[]>> {
  try {
    const value: unknown = JSON.parse(await readFile(ignoredReleasesPath(), 'utf8'))
    if (!isRecord(value)) {
      return {}
    }
    const result: Record<string, string[]> = {}
    for (const [key, list] of Object.entries(value)) {
      if (Array.isArray(list) && list.every((item) => typeof item === 'string')) {
        result[key] = list
      }
    }
    return result
  } catch {
    return {}
  }
}

async function writeIgnoredReleases(data: Record<string, string[]>): Promise<void> {
  const target = ignoredReleasesPath()
  await mkdir(dirname(target), { recursive: true })
  const staging = `${target}.${process.pid}.tmp`
  await writeFile(staging, JSON.stringify(data), 'utf8')
  try {
    await rename(staging, target)
  } catch {
    await writeFile(target, JSON.stringify(data), 'utf8')
    await rm(staging, { force: true }).catch(() => undefined)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
