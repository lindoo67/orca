import { z } from 'zod'

export const CODE_SERVER_RUNTIME_CAPABILITY = 'code-server.attach.v1' as const
export const CODE_SERVER_ATTACH_METHOD = 'codeServer.attach' as const

export const CodeServerAttachParams = z.object({})

export const CodeServerAttachEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ready'),
    tunnelGeneration: z.number().int().positive(),
    port: z.number().int().min(1).max(65_535)
  }),
  z.object({
    type: z.literal('closed'),
    tunnelGeneration: z.number().int().positive()
  })
])

export type CodeServerAttachEvent = z.infer<typeof CodeServerAttachEvent>
