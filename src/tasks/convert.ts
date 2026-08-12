import { $ } from "bun"
import path from "path"
import type { Project } from "../project"

/**
 * Converts a mapdb's `;e` StringProcs into MapEngine schema by driving the
 * canonical Ruby converter from a lich-5 checkout:
 *
 *   ruby tools/mapdb_convert.rb --in map.json \
 *        --manual lib/common/map/manual_conversions_gs.json --out map.converted.json
 *
 * The converter, its recognizers, the manual conversion overlay, and the
 * schema validator all live in lich-5 (single source of truth); cartographer
 * orchestrates and consumes the output.
 */

export interface ConvertConfig {
  project: Project
  /** lich-5 checkout containing tools/mapdb_convert.rb */
  lich5Dir: string
  /** input mapdb.json (defaults to the project's downloaded map) */
  inputFile?: string
  /** output path (defaults to /map.converted.json in the project tmp dir) */
  outputFile?: string
}

export interface ConvertResult {
  outputFile: string
  /** stringprocs remaining after conversion (0 once the corpus is covered) */
  remainingProcs: number
  stats: string
}

export async function convert(config: ConvertConfig): Promise<ConvertResult> {
  const inputFile = config.inputFile || config.project.route("/map.json")
  const outputFile = config.outputFile || config.project.route("/map.converted.json")
  const converter = path.join(config.lich5Dir, "tools", "mapdb_convert.rb")
  // The overlay ships beside the engine (lib/), not in tools/, because Lich
  // loads it at runtime too. It is per-game: DR used to be handed the GS file.
  const manual = path.join(
    config.lich5Dir, "lib", "common", "map",
    config.project.world === "dr" ? "manual_conversions_dr.json" : "manual_conversions_gs.json",
  )

  if (!(await Bun.file(converter).exists())) {
    throw new Error(`mapdb_convert.rb not found at ${converter} - pass --lich5 or set LICH5_DIR`)
  }

  const proc = $`ruby ${converter} --in ${inputFile} --manual ${manual} --out ${outputFile}`
  proc.quiet()
  proc.nothrow()
  const result = await proc
  const stdout = result.stdout.toString()

  if (result.exitCode !== 0) {
    throw new Error(`converter failed (${result.exitCode}): ${result.stderr.toString().slice(0, 500)}`)
  }

  const unconverted = [...stdout.matchAll(/^\s*(\d+)\s+\w+:unconverted$/gm)]
    .reduce((sum, m) => sum + Number(m[1]), 0)

  return {
    outputFile,
    remainingProcs: unconverted,
    stats: stdout,
  }
}
