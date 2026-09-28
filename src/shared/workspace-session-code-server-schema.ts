/* Why: the code server slice of the persisted workspace session. Split out of
 * workspace-session-schema.ts to keep that file inside its line budget; the
 * schema itself is unchanged. */
import { z } from 'zod'
import { codeServerTabSchema } from './code-server-session-schema'
import { salvagedOptional, salvagingRecord, salvagingArray } from './zod-salvage'

const worktreeIdSchema = z.string()

export const codeServerTabsByWorktreeSchema = salvagedOptional(
  'codeServerTabsByWorktree',
  salvagingRecord(worktreeIdSchema, salvagingArray(codeServerTabSchema))
)

export const activeCodeServerTabIdByWorktreeSchema = salvagedOptional(
  'activeCodeServerTabIdByWorktree',
  salvagingRecord(worktreeIdSchema, z.string().nullable())
)
