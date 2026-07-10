import { expect, test } from "bun:test"
import * as Tasks from "../src/tasks"
import { Project } from "../src/project"
import * as fs from "node:fs/promises"
import * as path from "path"
import * as os from "os"

function tempDir(name: string) {
  return path.join(os.tmpdir(), "cartographer-normalize-spec", name)
}

function rawRoom(id: number) {
  return {
    room: {
      id,
      title: [`[Test Room ${id}]`],
      description: ["A room used by the normalize spec."],
      location: "test",
      terrain: "rough",
      wayto: {
        "101": "north",
        "102": ";e fput \"go arch\" if checkfried",
      },
      timeto: {
        "101": 0.2,
        "102": ";e Spell[9099].active? ? 0.2 : 30",
      },
    },
  }
}

async function writeJson(file: string, data: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(data, null, 2))
}

test("normalize canonicalizes a raw in-place submission", async () => {
  const gitDir = tempDir("in-place")
  const roomFile = path.join(gitDir, "rooms", "100", "room.json")

  try {
    await fs.rm(gitDir, { recursive: true, force: true })
    await writeJson(roomFile, rawRoom(100))

    const project = new Project({ world: "gs", outputDir: gitDir })
    const results = await Tasks.normalize({ project, files: [roomFile] })

    // Raw file existed at the canonical path with no checksum -> updated
    expect(results.errors.filter(e => e.file.endsWith("room.json"))).toEqual([])
    expect(results.updated).toBe(1)

    const canonical = JSON.parse(await fs.readFile(roomFile, "utf-8"))
    expect(typeof canonical.checksum).toBe("string")
    expect(canonical.checksum.length).toBe(32)
    // Inline ;e procs replaced by file-path references
    expect(canonical.room.wayto["102"]).toBe("/rooms/100/wayto/stringproc-102.rb")
    expect(canonical.room.timeto["102"]).toBe("/rooms/100/timeto/stringproc-102.rb")
    // Static entries untouched
    expect(canonical.room.wayto["101"]).toBe("north")
    expect(canonical.room.timeto["101"]).toBe(0.2)

    // Externalized ruby written to disk
    const wayto = await fs.readFile(path.join(gitDir, "rooms", "100", "wayto", "stringproc-102.rb"), "utf-8")
    expect(wayto).toContain("go arch")
    const timeto = await fs.readFile(path.join(gitDir, "rooms", "100", "timeto", "stringproc-102.rb"), "utf-8")
    expect(timeto).toContain("Spell[9099]")
  } finally {
    await fs.rm(gitDir, { recursive: true, force: true })
  }
})

test("normalize is idempotent over canonical files", async () => {
  const gitDir = tempDir("idempotent")
  const roomFile = path.join(gitDir, "rooms", "100", "room.json")

  try {
    await fs.rm(gitDir, { recursive: true, force: true })
    await writeJson(roomFile, rawRoom(100))

    const project = new Project({ world: "gs", outputDir: gitDir })
    await Tasks.normalize({ project, files: [roomFile] })
    const firstPass = await fs.readFile(roomFile, "utf-8")

    const second = await Tasks.normalize({ project, files: [roomFile] })
    expect(second.unchanged).toBe(1)
    expect(second.updated).toBe(0)
    expect(second.created).toBe(0)
    expect(await fs.readFile(roomFile, "utf-8")).toBe(firstPass)
  } finally {
    await fs.rm(gitDir, { recursive: true, force: true })
  }
})

test("normalize creates canonical files from out-of-tree submissions", async () => {
  const gitDir = tempDir("out-of-tree-git")
  const submission = path.join(tempDir("out-of-tree-pending"), "submitted.json")

  try {
    await fs.rm(gitDir, { recursive: true, force: true })
    await fs.rm(path.dirname(submission), { recursive: true, force: true })
    await writeJson(submission, rawRoom(200))

    const project = new Project({ world: "gs", outputDir: gitDir })
    const results = await Tasks.normalize({ project, files: [submission] })

    expect(results.created).toBe(1)
    const canonical = JSON.parse(await fs.readFile(path.join(gitDir, "rooms", "200", "room.json"), "utf-8"))
    expect(canonical.room.id).toBe(200)
  } finally {
    await fs.rm(gitDir, { recursive: true, force: true })
    await fs.rm(path.dirname(submission), { recursive: true, force: true })
  }
})

test("normalize rejects a path/contents room id mismatch", async () => {
  const gitDir = tempDir("mismatch")
  const roomFile = path.join(gitDir, "rooms", "999", "room.json")

  try {
    await fs.rm(gitDir, { recursive: true, force: true })
    await writeJson(roomFile, rawRoom(100))

    const project = new Project({ world: "gs", outputDir: gitDir })
    const results = await Tasks.normalize({ project, files: [roomFile] })

    expect(results.created + results.updated + results.unchanged).toBe(0)
    expect(results.errors.length).toBe(1)
    expect(results.errors[0].error).toContain("path says room 999")
    expect(results.errors[0].error).toContain("contents say room 100")
  } finally {
    await fs.rm(gitDir, { recursive: true, force: true })
  }
})

test("normalize resolves userland references without touching the canonical proc", async () => {
  const gitDir = tempDir("userland-refs")
  const roomFile = path.join(gitDir, "rooms", "100", "room.json")
  const procFile = path.join(gitDir, "rooms", "100", "wayto", "stringproc-102.rb")
  const canonicalRuby = "Map[7].wayto['102'].call"

  try {
    await fs.rm(gitDir, { recursive: true, force: true })
    // Repo already holds the canonical proc for the unchanged edge
    await fs.mkdir(path.dirname(procFile), { recursive: true })
    await fs.writeFile(procFile, canonicalRuby)

    // Submission: unchanged proc arrives as a userland pointer, not code
    const submission = rawRoom(100)
    submission.room.wayto["102"] = ";e Cartographer.evaluate_script('wayto/room-100-to-102.rb')"
    submission.room.timeto["102"] = 0.2 as any
    await writeJson(roomFile, submission)

    const project = new Project({ world: "gs", outputDir: gitDir })
    const results = await Tasks.normalize({ project, files: [roomFile] })

    expect(results.errors).toEqual([])
    expect(results.updated).toBe(1)

    const canonical = JSON.parse(await fs.readFile(roomFile, "utf-8"))
    // Pointer resolved to the canonical reference...
    expect(canonical.room.wayto["102"]).toBe("/rooms/100/wayto/stringproc-102.rb")
    // ...and the real proc content was NOT clobbered by the pointer text
    expect(await fs.readFile(procFile, "utf-8")).toBe(canonicalRuby)
  } finally {
    await fs.rm(gitDir, { recursive: true, force: true })
  }
})

test("normalize rejects userland references to procs the repo does not have", async () => {
  const gitDir = tempDir("dangling-refs")
  const roomFile = path.join(gitDir, "rooms", "100", "room.json")

  try {
    await fs.rm(gitDir, { recursive: true, force: true })
    const submission = rawRoom(100)
    submission.room.wayto["102"] = ";e Cartographer.evaluate_script('wayto/room-100-to-102.rb')"
    submission.room.timeto["102"] = 0.2 as any
    await writeJson(roomFile, submission)

    const project = new Project({ world: "gs", outputDir: gitDir })
    const results = await Tasks.normalize({ project, files: [roomFile] })

    expect(results.created + results.updated + results.unchanged).toBe(0)
    expect(results.errors.length).toBe(1)
    expect(results.errors[0].error).toContain("does not exist in the repo")
  } finally {
    await fs.rm(gitDir, { recursive: true, force: true })
  }
})

test("normalize rejects unknown climate/terrain values with a readable error", async () => {
  const gitDir = tempDir("bad-climate")
  const roomFile = path.join(gitDir, "rooms", "100", "room.json")

  try {
    await fs.rm(gitDir, { recursive: true, force: true })
    const submission = rawRoom(100)
    // Valid components in the wrong order - the enum only knows "arid, temperate"
    ;(submission.room as any).climate = "temperate, arid"
    await writeJson(roomFile, submission)

    const project = new Project({ world: "gs", outputDir: gitDir })
    const results = await Tasks.normalize({ project, files: [roomFile] })

    expect(results.created + results.updated + results.unchanged).toBe(0)
    expect(results.errors.length).toBe(1)
    expect(results.errors[0].error).toContain("climate")
  } finally {
    await fs.rm(gitDir, { recursive: true, force: true })
  }
})

test("normalize reports readable validation errors", async () => {
  const gitDir = tempDir("invalid")
  const roomFile = path.join(gitDir, "rooms", "100", "room.json")

  try {
    await fs.rm(gitDir, { recursive: true, force: true })
    await writeJson(roomFile, { room: { id: "not-a-number", title: ["x"] } })

    const project = new Project({ world: "gs", outputDir: gitDir })
    const results = await Tasks.normalize({ project, files: [roomFile] })

    expect(results.errors.length).toBe(1)
    expect(results.errors[0].error).toContain("Expected number, received string")
  } finally {
    await fs.rm(gitDir, { recursive: true, force: true })
  }
})
