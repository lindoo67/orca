import { CODE_SERVER_VERSION } from './code-server-paths'

export type CodeServerResourceTarget =
  | 'win32-x64'
  | 'darwin-x64'
  | 'darwin-arm64'
  | 'linux-x64'
  | 'linux-arm64'

export type CodeServerResourceAsset = {
  target: CodeServerResourceTarget
  version: string
  platform: NodeJS.Platform
  arch: NodeJS.Architecture
  label: string
  archiveName: string
  url: string
  archiveSha256: string
  downloadBytes: number
}

const RELEASE_ROOT = `https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}`

const assets: Record<
  CodeServerResourceTarget,
  Omit<CodeServerResourceAsset, 'target' | 'version' | 'url'>
> = {
  'win32-x64': {
    platform: 'win32',
    arch: 'x64',
    label: 'Windows x64',
    archiveName: `code-server-${CODE_SERVER_VERSION}-windows-amd64.tar.gz`,
    archiveSha256: '82a0c252acb0075c077ad36c10f7dd0be5e8a9579200cadecfa2e1bab8d239d3',
    downloadBytes: 217_074_238
  },
  'darwin-x64': {
    platform: 'darwin',
    arch: 'x64',
    label: 'macOS Intel',
    archiveName: `code-server-${CODE_SERVER_VERSION}-macos-amd64.tar.gz`,
    archiveSha256: 'bd1a54d03e03d3b0ec75705f48c39c5f6b309a36a2c7ee878f746a6e5f9aa2ae',
    downloadBytes: 224_408_024
  },
  'darwin-arm64': {
    platform: 'darwin',
    arch: 'arm64',
    label: 'macOS Apple Silicon',
    archiveName: `code-server-${CODE_SERVER_VERSION}-macos-arm64.tar.gz`,
    archiveSha256: '1ecf699868e64bb9094a7d3ffcac50bb903354a32137dfc4017cb9479ef6b456',
    downloadBytes: 205_092_599
  },
  'linux-x64': {
    platform: 'linux',
    arch: 'x64',
    label: 'Linux x64',
    archiveName: `code-server-${CODE_SERVER_VERSION}-linux-amd64.tar.gz`,
    archiveSha256: '5d63f26c5dabc2acd29610b9b27f413b016aa67019e2cfcdf54031625e18f535',
    downloadBytes: 230_553_881
  },
  'linux-arm64': {
    platform: 'linux',
    arch: 'arm64',
    label: 'Linux ARM64',
    archiveName: `code-server-${CODE_SERVER_VERSION}-linux-arm64.tar.gz`,
    archiveSha256: 'fbebf4b18e97a5a48b7b105be0161d411e54ccfb53a1ffb1673c16518024fa30',
    downloadBytes: 225_430_592
  }
}

export function codeServerFallbackAsset(target: CodeServerResourceTarget): CodeServerResourceAsset {
  const asset = assets[target]
  return {
    ...asset,
    target,
    version: CODE_SERVER_VERSION,
    url: `${RELEASE_ROOT}/${asset.archiveName}`
  }
}

export function codeServerResourceTarget(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture
): CodeServerResourceTarget {
  const target = `${platform}-${arch}`
  switch (target) {
    case 'win32-x64':
    case 'darwin-x64':
    case 'darwin-arm64':
    case 'linux-x64':
    case 'linux-arm64':
      return target
    default:
      throw new Error(`Embedded VS Code is not available on ${target}.`)
  }
}
