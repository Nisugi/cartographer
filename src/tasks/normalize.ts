import * as fs from "node:fs/promises"
import { Room, State } from "../room/room"
import type { Project } from "../project"
import { fromError } from "zod-validation-error"

export interface NormalizeConfig {
  project: Project;
  files: string[];
}

export interface NormalizeError {
  file: string;
  error: string;
}

export interface NormalizeResult {
  created: number;
  updated: number;
  unchanged: number;
  errors: NormalizeError[];
}

/**
 * Canonicalizes submitted room.json files into a git directory.
 *
 * Submissions (e.g. from `;cartographer --submit`) arrive in raw form:
 * `{room: {...}}` with StringProcs inline as `;e` strings and no checksum.
 * This task validates each room, externalizes inline StringProcs into their
 * canonical `.rb` files (formatted via the string-proc batch), computes the
 * checksum, and rewrites the room file in the git-canonical
 * `{checksum, room}` shape at `rooms/{id}/room.json`.
 *
 * Already-canonical files pass through untouched (file-path references are
 * not re-transformed and the checksum matches), so the task is idempotent
 * and safe to run over any mix of raw and canonical files.
 */
export async function normalize(config: NormalizeConfig): Promise<NormalizeResult> {
  const result: NormalizeResult = { created: 0, updated: 0, unchanged: 0, errors: [] }

  for (const file of config.files) {
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf-8"))
      // Accept GitRoom format ({checksum, room}), raw submissions ({room}),
      // and bare room objects.
      const roomData = parsed.room ?? parsed

      // Submissions from cartographer.lic carry UNCHANGED procs as
      // ";e Cartographer.evaluate_script('...')" strings - pointers into the
      // userland release, not proc code. Resolve them back to canonical
      // file-path references before validation so they are neither treated
      // as new code nor allowed to clobber the real proc files.
      const danglingRefs = await resolveUserlandReferences(roomData, config.project)
      if (danglingRefs.length > 0) {
        danglingRefs.forEach(error => result.errors.push({ file, error }))
        continue
      }

      const room = await Room.validate(roomData)

      // A room file lives at rooms/{id}/room.json - reject submissions whose
      // path claims a different room than their contents describe.
      const pathId = idFromPath(file)
      if (pathId !== null && pathId !== room.validated.id) {
        result.errors.push({ file, error: `path says room ${pathId} but contents say room ${room.validated.id}` })
        continue
      }

      switch (await room.getState(config.project)) {
        case State.Ok:
          result.unchanged++
          break
        case State.Missing:
          await room.write(config.project)
          result.created++
          break
        case State.Stale:
          await room.write(config.project)
          result.updated++
          break
      }
    } catch (error: any) {
      const message = error.name === "ZodError" ? fromError(error).toString() : error.message
      result.errors.push({ file, error: message })
    }
  }

  // Write and format the externalized StringProc files queued by write().
  const batchErrors = await Room.processBatchedStringProcs(config.project)
  result.errors.push(...batchErrors.map(({ err, file }) => ({ file, error: err })))

  return result
}

/**
 * Extracts the room id a file path claims, or null when the path does not
 * follow the rooms/{id}/room.json convention (e.g. out-of-tree submissions).
 */
function idFromPath(file: string): number | null {
  const match = file.replaceAll("\\", "/").match(/rooms\/(\d+)\/room\.json$/)
  return match ? Number(match[1]) : null
}

/** The exact shape of an unchanged-proc pointer in a userland submission. */
const USERLAND_REFERENCE = /^;e\s+Cartographer\.evaluate_script\('(wayto|timeto)\/room-(\d+)-to-(\d+)\.rb'\)$/

/**
 * Rewrites `;e Cartographer.evaluate_script('...')` wayto/timeto entries
 * into the canonical `/rooms/{from}/{kind}/stringproc-{to}.rb` references
 * they point at, verifying the referenced proc actually exists in the repo.
 *
 * @returns problems for references whose canonical proc file is missing
 */
async function resolveUserlandReferences(roomData: any, project: Project): Promise<string[]> {
  const problems: string[] = []
  for (const field of ["wayto", "timeto"] as const) {
    const entries = roomData?.[field]
    if (!entries || typeof entries !== "object") continue
    for (const [to, value] of Object.entries(entries)) {
      if (typeof value !== "string") continue
      const match = value.match(USERLAND_REFERENCE)
      if (!match) continue
      const [, kind, fromRoom, toRoom] = match
      const location = `/rooms/${fromRoom}/${kind}/stringproc-${toRoom}.rb`
      if (await project.gitExists(location)) {
        entries[to] = location
      } else {
        problems.push(`${field}["${to}"] is a userland reference (${value}) but ${location} does not exist in the repo`)
      }
    }
  }
  return problems
}
