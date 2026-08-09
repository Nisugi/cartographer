import { expect, test } from "bun:test"
import { RoomValidator } from "../src/validators/room"
import { isStringProc } from "../src/validators/edge"

const base = {
  id: 100,
  title: ["Test Room"],
  description: ["A room."],
}

test("rooms with MapEngine schema wayto entries validate", () => {
  const room = {
    ...base,
    wayto: {
      "101": "north",
      "102": [{ do: "send", cmd: "open gate" }, { do: "move", cmd: "go gate" }],
      "103": { strategy: "table_join", table: "Ant Hill" },
      "104": [], // virtual no-op crossing
      "105": [{ do: "repeat", times: 10, until: "status:standing", steps: [{ do: "send", cmd: "stand" }] }],
    },
    timeto: {
      "101": 0.2,
      "102": { cost: 0.1, requires: ["setting:urchins", "not:hidden"] },
      "103": { same_as: "7:30714" },
      "104": { event: "instability", key: 2300 },
      "105": { formula: "haste_scaled", base: 15, else: 15.2 },
      "106": { cost: null, requires: ["is:sitting"], else: { cost: 0.2 } },
    },
  }
  const result = RoomValidator.safeParse(room)
  expect(result.success).toBe(true)
})

test("malformed schema entries are rejected", () => {
  const room = {
    ...base,
    wayto: { "101": [{ cmd: "missing do key" }] },
    timeto: {},
  }
  expect(RoomValidator.safeParse(room).success).toBe(false)

  const badTimeto = {
    ...base,
    wayto: {},
    timeto: { "101": { same_as: "not-a-ref" } },
  }
  expect(RoomValidator.safeParse(badTimeto).success).toBe(false)
})

test("legacy StringProc strings still validate during migration", () => {
  const room = {
    ...base,
    wayto: { "101": ";e move 'go gate'" },
    timeto: { "101": ";e nil" },
  }
  expect(RoomValidator.safeParse(room).success).toBe(true)
  expect(isStringProc(room.wayto["101"])).toBe(true)
  expect(isStringProc("north")).toBe(false)
})
