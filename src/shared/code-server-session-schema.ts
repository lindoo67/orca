import { z } from 'zod'

export const codeServerTabSchema = z.object({
  id: z.string(),
  worktreeId: z.string(),
  folderPath: z.string(),
  label: z.string()
})
