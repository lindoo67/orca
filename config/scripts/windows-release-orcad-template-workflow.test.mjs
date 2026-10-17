import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const workflow = parse(
  readFileSync(new URL('../../.github/workflows/build-windows-exe.yml', import.meta.url), 'utf8')
)

describe('Windows release ships the orcad template', () => {
  const template = workflow.jobs['orcad-template']
  const build = workflow.jobs['build-windows']
  const stepIndex = (name) => build.steps.findIndex((step) => step.name === name)

  it('builds the template from the selected app ref', () => {
    expect(template.uses).toBe('./.github/workflows/node-server-tests.yml')
    expect(template.with).toEqual({
      ref: '${{ inputs.ref || github.sha }}',
      build_template: true
    })
    expect(template.permissions).toEqual({ contents: 'read' })
  })

  it('downloads and requires the template after building the app', () => {
    expect(build.needs).toBe('orcad-template')
    const app = stepIndex('Build app')
    const download = stepIndex('Download the orcad deployment template')
    const installer = stepIndex('Build Windows installer')
    expect(download).toBeGreaterThan(app)
    expect(installer).toBeGreaterThan(download)
    expect(build.steps[download].with).toEqual({
      name: 'orcad-template',
      path: 'out/orcad-template'
    })
    expect(build.steps[installer].env.ORCA_REQUIRE_ORCAD_TEMPLATE).toBe('1')
  })
})
