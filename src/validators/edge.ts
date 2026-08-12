import * as z from "zod"

/**
 * MapEngine schema edges: the declarative wayto/timeto format that replaces
 * `;e` StringProcs (lich-5 lib/common/map/map_engine.rb).
 *
 * These validators check STRUCTURE only - a step has a `do`, a strategy has a
 * name, a cost entry has one of its known shapes. Full vocabulary validation
 * (known step names, requirement kinds, regex compilation) is owned by the
 * canonical Ruby validator and runs in CI:
 *
 *   ruby tools/mapdb_validate.rb --rooms <gitDir> --forbid-procs
 *
 * Keeping Zod structural avoids maintaining the vocabulary in two languages.
 */

export type WaytoStep = {
  do: string
  [key: string]: unknown
}

export const WaytoStepValidator: z.ZodType<WaytoStep> = z.lazy(() =>
  z.object({
    do: z.string(),
  }).catchall(z.unknown())
)

/** A crossing: a step list (possibly empty = virtual no-op) */
export const WaytoStepsValidator = z.array(WaytoStepValidator)

/** A strategy reference: named travel service implemented in lich-5 */
export const WaytoStrategyValidator = z.object({
  strategy: z.string(),
}).catchall(z.unknown())

/**
 * A crossing in object form. `define` is optional: it names reusable step
 * lists that the body references by name via `steps_ref`, so a body used
 * several times is stored once rather than inlined per use. A crossing with
 * nothing to reuse is just `{ steps }`.
 */
export const WaytoDefineValidator = z.object({
  define: z.record(z.string(), WaytoStepsValidator).optional(),
  steps: WaytoStepsValidator,
}).catchall(z.unknown())

/** Any schema wayto value (plain movement strings validated separately) */
export const WaytoSchemaValidator = z.union([
  WaytoStepsValidator,
  WaytoDefineValidator,
  WaytoStrategyValidator,
])

/** A schema timeto entry: cost gate, delegation, event table, or formula */
export const TimetoSchemaValidator = z.union([
  z.object({ same_as: z.string().regex(/^\d+:\d+$/) }).strict(),
  z.object({ event: z.string(), key: z.number() }).strict(),
  z.object({
    formula: z.string(),
    base: z.number(),
  }).catchall(z.unknown()),
  z.object({
    cost: z.number().nullable(),
    requires: z.array(z.string()).optional(),
    else: z.unknown().optional(),
  }).catchall(z.unknown()),
])

/** True when a value is a legacy `;e` StringProc string */
export function isStringProc(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(";e ")
}
