# Mapping with MapEngine Schema

*A guide for mappers: adding and changing rooms and edges in the
StringProc-free mapdb.*

---

## What changed, and what didn't

**What didn't change:** rooms. You still walk the game and capture rooms
with `;mapmap` exactly as before — titles, descriptions, paths, tags, uids,
plain movement edges (`"north"`, `"go gate"`). The overwhelming majority of
mapping work is untouched.

**What changed:** special edges. Anything that used to need a hand-written
`;e` StringProc — opening a door before walking through, waiting for a
ferry, gating a passage on citizenship or a setting, riding a mine cart —
is now written as **schema**: plain JSON describing steps and conditions,
interpreted by a reviewed engine inside Lich (`MapEngine`). No Ruby, no
code review, no waiting on a trusted proc reviewer. A special edge is data
you can read, diff, and validate.

Two things follow from that:

1. **Anyone can review a special edge.** A submission diff shows exactly
   what commands the edge sends and when. If you can read this guide, you
   can review a map PR.
2. **You cannot write arbitrary code.** If the vocabulary below can't
   express what you need, that's a deliberate wall — see
   [When you can't express it](#when-you-cant-express-it).

---

## The two edge fields, refreshed

Every connection between rooms is two entries:

- **`wayto`** — *how* to cross: a command, a list of steps, or a strategy.
- **`timeto`** — *how long* it takes (seconds), which doubles as *whether
  you can*: a number, or a cost object whose requirements decide. `null`
  (or failing requirements with no fallback) means "not routable."

### `wayto` takes three forms

```jsonc
"wayto": {
  "1013": "out",                                  // 1. plain command (unchanged)
  "1261": [                                       // 2. step list
    { "do": "send",  "cmd": "buy pass" },
    { "do": "await", "for": "You hastily exit the cart",
      "timeout": 1800, "on_timeout": "fail" }
  ],
  "23300": { "strategy": "confluence_explorer",   // 3. strategy reference
             "target": 23300 }
}
```

### `timeto` takes five forms

```jsonc
"timeto": {
  "1013": 0.2,                                        // 1. plain seconds
  "30714": { "cost": 0.1,                             // 2. cost gate
             "requires": ["setting:urchins", "not:hidden"] },
  "1874": { "same_as": "7:30714" },                   // 3. delegate to another edge
  "188":  { "event": "instability", "key": 188 },     // 4. event table lookup
  "24572": { "formula": "haste_scaled",               // 5. named formula
             "base": 15, "else": 15.2 }
}
```

A cost gate resolves top-down: if every entry in `requires` passes, the
edge costs `cost` (an explicit `"cost": null` means *blocked when the
requirements pass* — the old `cond ? nil : x` idiom). If a requirement
fails, evaluation falls to `else` (another cost object, chainable), or the
edge is simply not routable. Cost evaluation is **pure** — it must never
send game commands; anything that needs game actions belongs in the
`wayto` crossing.

---

## Cookbook

Each recipe shows the old proc and the schema that replaces it.

### Open a door, then walk through

```ruby
;e fput 'open gate'; move 'go gate'
```
```json
[ { "do": "send", "cmd": "open gate" },
  { "do": "move", "cmd": "go gate" } ]
```

### Search until something appears, then enter

```ruby
;e begin; r = dothistimeout 'search', 5, /don't find|discover a crack/; waitrt?; end until r =~ /discover/; move 'go crack'
```
```json
[ { "do": "repeat", "times": 50,
    "steps": [
      { "do": "await", "cmd": "search", "timeout": 5,
        "for": "don't find anything|discover a crack",
        "if_match": { "pattern": "discover", "steps": [ { "do": "break" } ] } },
      { "do": "wait_rt" } ] },
  { "do": "move", "cmd": "go crack" } ]
```

`await` with a `cmd` sends the command and waits (dothistimeout). `repeat`
must always be bounded — `times`, `until`, `until_room`, or
`until_room_change`. `break` exits the innermost repeat.

### Wait for a scheduled ride (ferry, cart, ship)

```ruby
;e fput 'buy ticket'
waitfor 'You hastily exit the cart'
```
```json
[ { "do": "send", "cmd": "buy ticket" },
  { "do": "await", "for": "You hastily exit the cart",
    "timeout": 1800, "on_timeout": "fail" } ]
```

**The single most important policy in this guide:** an `await` *without*
`cmd` is a passive wait (the old `waitfor`). Anything that waits on a game
schedule — boats, carts, escorts — must use `"on_timeout": "fail"` with a
timeout **longer than the ride** (1800s covers everything currently in
either game). The default policy, `continue`, is only correct for
dothistimeout-style probes. We learned this one live: a 600s wait on a
20-minute Teras voyage abandoned a tester mid-ocean, and a 30s wait once
walked someone off a moving mine cart. When a `fail` await times out, the
crossing raises and go2 re-routes — it never silently proceeds.

### Gate a passage on settings, character, or time

```json
"timeto": {
  "30714": { "cost": 0.1,
             "requires": ["setting:urchins", "grant:urchins_expire",
                          "not:hidden", "not:invisible"] },
  "19507": { "cost": 0.2, "requires": ["prof:Bard"] },
  "291":   { "cost": 0.2, "requires": ["citizenship:Wehnimer's Landing"] },
  "31558": { "cost": 2400, "requires": ["month:10"] },
  "23526": { "cost": 3.2, "requires": ["skill:swimming>=30"] },
  "12603": { "cost": 2.8, "requires": ["society:Order of Voln+26", "seeking_enabled"] }
}
```

See the [requirement reference](#requirement-kinds-timeto-requires) for
every kind. Comparison args accept `>=`, `>`, `<`, `<=` (`level:>19`,
`drskill:Athletics>=540`).

### Branch on a condition mid-crossing

```json
[ { "do": "if", "when": "spell:112",
    "then": [ { "do": "move", "cmd": "north" } ],
    "else": [ { "do": "empty_hands" },
              { "do": "move", "cmd": "swim north" },
              { "do": "fill_hands" } ] },
  { "do": "wait_rt" } ]
```

`if` also accepts `when_all` (a list, AND-ed) and `not:` prefixes:
`"when_all": ["not:status:kneeling", "not:race_match:(?i)dwarf|halfling|gnome"]`.
Conditions are a superset of requirement kinds — anything usable in
`requires` works in `when`.

### A blocked way with a fallback (locked doors, absent boats)

```json
[ { "do": "try_move", "cmd": "go doors", "check": "move_result",
    "fallback": [
      { "do": "await", "cmd": "pull lever", "timeout": 3,
        "for": "the stone doors swing silently open" },
      { "do": "move", "cmd": "go doors" } ] } ]
```

`try_move` attempts the command; the fallback runs only if the room didn't
change (or, with `"check": "move_result"`, if `move` itself reported
failure — faster when the game's rejection line is one `move` recognizes).

### A toll or payment (read this before adding one)

```json
[ { "do": "send", "cmd": "give attendant 2000" },
  { "do": "move", "cmd": "go gondola" } ]
```

Commands beginning with `give`, `put`, `drop`, `_drag`, `trade`, `accept`,
`sell`, `deposit`, or `withdraw` **fail validation** unless the edge is on
the reviewed allowlist (`config/allowlists/command-allowlist-{gs,dr}.json`
in the cartographer repo). Legitimate uses exist — about ten across both
games, all NPC tolls and prop puzzles — so the process is: add your edge to
the allowlist **in the same PR**, and a human approves the command and the
exception together. A payment aimed at a player name will not pass review;
don't try.

### Cleanup after arrival, and when to replan

```json
[ { "do": "move", "cmd": "jump" },
  { "do": "if", "when": "not:in_room:30816",
    "then": [ { "do": "replan" } ] } ]
```

`replan` asks go2 to re-route from wherever you are — for crossings whose
landing spot varies (jumps, slips, shifting exits). **Always guard it
behind `not:in_room:<destination>`**: if the crossing landed exactly where
the edge says it goes, the planned route is still valid, and an
unconditional replan trips go2's same-room error.

### Virtual rooms and shared edges

```jsonc
"wayto": { "30714": [] }                      // no-op crossing (virtual waypoint)
"timeto": { "30714": { "same_as": "7:30714" } }  // one gate, referenced everywhere
"wayto": { "3668": [ { "do": "cross", "room": 284, "dest": "3668" } ] }  // follow another room's crossing
```

### Use a strategy for the genuinely stateful stuff

```json
"wayto": {
  "1": { "strategy": "table_join", "table": "Cat's Paw" },
  "12677": { "strategy": "guided_route", "target": 12677, "verb": "swim",
             "dirs": { "20786": "down", "12662": "whirlpool" },
             "hands_free_in": [12662, 20786] },
  "2635": { "strategy": "patrol_search",
            "rooms": [2579, 2580, 2581], "dirs": ["southwest", "east"],
            "objects": ["door", "mirror"] }
}
```

Strategies are travel *services* implemented once in reviewed Lich code —
you supply parameters, the engine supplies the behavior. Using one is a
data edit; see the [strategy reference](#strategies-wayto-strategy) for
parameters. Adding a *new* strategy is a lich-5 pull request.

---

## Rules and invariants

These are enforced by the validator; internalizing them saves you a red CI run.

1. **Room references are mapdb ids, never game uids.** `until_room`,
   `in_room:`, `cross`, `same_as` all take the number you see in
   `Room[...].id` — not the `u1234567` from the game stream.
2. **No `#{...}` anywhere in a command.** Ruby interpolation is dead; the
   validator rejects it. Dynamic values use tokens, expanded at crossing
   time: `{uservar:key_sack}` (a UserVars value), `{item_id:brass key}`
   (`#<id>` of a named inventory item), `{char}` (character name),
   `{map_id}` (current mapdb room id).
3. **Every loop is bounded.** `repeat` requires `times`, `until`,
   `until_room`, or `until_room_change`, and hard-caps at 50 iterations
   regardless. Bad data may waste a route; it can never hang Lich.
4. **Cost evaluation never acts and never crashes.** No game commands in
   `timeto` — scans and setup belong to the crossing. Unknown requirement
   kinds, missing game state, and evaluation errors all mean "edge not
   routable," never a dead router. (This forward-compatibility is also why
   an older Lich safely ignores vocabulary it doesn't know.)
5. **Block-forever waits get `on_timeout: fail`** with a schedule-sized
   timeout. Probe-style awaits keep the default `continue`.
6. **Risk-verb commands need an allowlist entry** in the same PR (above).

---

## Testing your edges

After editing, reload and exercise the edge directly — don't rely on
`;go2` picking it, because the router chooses by cost:

```
;e Map.reload
;e echo Room[FROM].wayto['TO'].inspect        # see what loaded (Crossing/steps)
;e Room[FROM].wayto['TO'].call                # run the crossing, standing in FROM
;e echo Room[FROM].timeto['TO'].call.inspect  # cost: a number, or nil (gated off)
```

The last one is how you verify gates without walking: toggle the setting or
condition and watch the number appear and disappear. Note that expensive
edges (a 300s ferry next to an 8s walk) will *never* be chosen by `;go2`
from adjacent rooms — that's correct routing, not a broken edge; the direct
`.call` is the only way to exercise them.

Offline, the full validation CI runs is:

```
ruby tools/mapdb_validate.rb --in MAP.json --forbid-procs \
     --lint-commands config/allowlists/command-allowlist-gs.json
```

(`--rooms DIR` validates a per-room tree instead of a monolithic file.)

---

## When you can't express it

The vocabulary is deliberately not a programming language. When a crossing
needs something it can't say, escalate in this order:

1. **Check the strategy list** — most "impossible" crossings are an
   existing strategy with different parameters (a new private table, a new
   guided route, another patrol loop).
2. **Ask for vocabulary.** If several edges need the same new condition or
   step (`has_item` and `stamina` both started this way), it's a small
   lich-5 change with a spec, and every future mapper gets it.
3. **A unique crossing.** Genuinely one-off programs (quest rituals,
   NPC-driven puzzles) live as named blocks in lich-5's
   `map_crossings.rb`; the edge references
   `{ "strategy": "unique_crossing", "name": "crossing_X_Y" }`. This
   requires a lich-5 PR — it's real code — but a missing crossing degrades
   gracefully (edge not crossable), never crashes.

What you must never do is the old thing: there is no way to put executable
code in the map, and that's the point.

---

## Runtime edges from scripts (teleport rings, etc.)

Some scripts edit the **in-memory** map at runtime — `teleport.lic` links
your ring's two rooms with temporary edges, for example. This still works
exactly as before: scripts may assign StringProcs (or plain Ruby procs,
which is cleaner) to `wayto`/`timeto` at runtime, and both go2 and the
router accept them. The zero-StringProc rule applies to the **published map
data**, not to what a running script does to its own session — a script
that creates an edge could do anything anyway, so nothing new is trusted.

Two cautions:

- **Never save runtime edges into a submission.** A map saved while
  teleport edges are live would carry `;e` procs and fail
  `--forbid-procs` CI — which is the system catching exactly what it
  should. Well-behaved scripts (teleport.lic does) remove their edges when
  done.
- **Renumbering/merging rooms with schema edges** (mapmap's merge flow):
  schema edges display and search fine, but ids *inside* schema —
  `same_as`, `cross`, `in_room:`, `until_room` — are not rewritten by
  mapmap's proc-oriented renumber. If you merge a room that schema
  references, update those ids by hand in the affected `room.json` files
  (grep the tree for the old id).

---

## Reference

### Steps (`wayto` step lists)

| Step | Params | Does |
|---|---|---|
| `send` | `cmd` | Send a game command (`fput`) |
| `move` | `cmd` | Movement command, verified room change |
| `await` | `cmd`?, `for`, `timeout`, `on_timeout` (`continue`/`fail`/`retry`), `if_match` `{pattern, steps}` | With `cmd`: send and wait (dothistimeout). Without: passive wait (waitfor). `if_match` runs steps when the hit matches a sub-pattern |
| `wait_rt` / `wait_castrt` | — | Wait out roundtime / cast roundtime |
| `sleep` | `seconds` | Fixed pause |
| `wait_room_change` | `timeout`? | Passive carry (rapids, lifts) |
| `wait_until` | `when`, `timeout`? | Block until a condition holds (bounded) |
| `if` | `when` or `when_all`, `then`, `else`? | Conditional branch |
| `repeat` | `steps` + one bound (`times`/`until`/`until_room`/`until_room_change`) | Bounded loop |
| `break` / `break_if_moved` | — | Exit the innermost repeat (unconditionally / if the room changed) |
| `try_move` | `cmd`, `fallback`, `check: "move_result"`? | Attempt, run fallback on failure |
| `empty_hands` / `fill_hands` / `empty_hand` / `fill_hand` | — | Stash / restore hands (both / one) |
| `cast_buff` | `spell` | Cast if known, affordable, and not active |
| `cast` | `spell`, `target`? | Cast at target; waits mana, retries hindrance |
| `move_random` | `among`?, `except`?, `prefix`?, `send`? | Random obvious path |
| `preserve_stance` | `stance`, `steps` | Hold a stance around nested steps, restore after |
| `escort_wait` | — | Wait for a bounty/task escortee to follow |
| `move_with_group` | `cmd` | Move and wait for noted followers to rejoin |
| `set` | `var`, `value`, `raw`? | Set `UserVars.mapdb_<var>` (or raw name) |
| `set_global` | `var`, `value` | Whitelisted legacy globals only |
| `echo` | `msg` | Message to the user |
| `replan` | — | Ask go2 to re-route (guard behind `not:in_room:<dest>`) |
| `cross` | `room`, `dest` | Follow another room's crossing |
| `run_script` | `script`, `args`? | Run a helper script to completion (DR travel) |

### Requirement kinds (`timeto` `requires`)

Prefix any with `not:` to negate. `EXPR` means `>=`/`>`/`<`/`<=` + number.

| Kind | Example | True when |
|---|---|---|
| `setting:NAME` | `setting:urchins` | `UserVars.mapdb_use_NAME` is on |
| `grant:NAME` | `grant:urchins_expire` | `UserVars.mapdb_NAME` epoch is in the future |
| `var:NAME[=V]` / `var_raw:NAME[=V]` | `var:redforest_location=WL` | UserVars (mapdb_-prefixed / raw) truthy or equals V |
| `is:STATUS` / bare `not:STATUS` | `not:hidden` | hidden / invisible / sitting / kneeling / standing / stunned |
| `prof:` `race:` `gender:` | `prof:Warrior` | Stats match (permissive if Stats unavailable) |
| `citizenship:TOWN` | `citizenship:Solhaven` | GS citizenship |
| `level:EXPR` / `skill:NAME EXPR` | `skill:climbing>99` | Level / skill comparison |
| `spell:N` / `spell_known:N,N` | `spell_known:407,1604` | Spell active / any listed known |
| `society:NAME[+RANK]` / `society:+RANK` | `society:Order of Voln+26` | Society and/or rank |
| `climate:X` / `month:N` / `room_name:RE` / `location:RE` | `month:10` | Environment matches |
| `has_item:NAME` | `has_item:brass key` | Named item in inventory |
| `script_running:A,B` / `no_script:A,B` / `script_exists:A` | `no_script:bigshot` | Script state |
| `pass:A+B` / `pass_buyable:TOKEN` | `pass:Solhaven+Wehnimer's Landing` | Chronomage day-pass cache / buy setting |
| `subscription:premium` / `seeking_enabled` / `edge:R+D` / `global:NAME=V` / `climb_vs_encumbrance:N` | | Special-purpose (see engine) |
| DR: `drskill:NAME EXPR`, `guild:`, `circle:EXPR`, `premium:GAMES`, `game:LIST`, `dr_setting:`, `dr_spell_known:`, `stamina:EXPR` | `drskill:Athletics>=540` | DR stats/state |

### Conditions (`if`/`when`, `wait_until`, `repeat until`)

All requirement kinds, plus: `status:X`, `path:DIR` (obvious path exists),
`paths_are:D,D` (exact set), `race_match:REGEX`, `has_item:`, `loot_match:REGEX`
(room objects; `{char}` token allowed), `in_room:ID`, `platinum`, `ice_caution`.

### Strategies (`wayto` `strategy`)

| Strategy | Required params | Service |
|---|---|---|
| `table_join` | `table` | Private-table entry with invitation handling |
| `guided_route` | `target`, `dirs` (+`verb`, `hands_free_in`, `escort_wait`) | Per-room direction walk (swim gauntlets) |
| `patrol_search` | `rooms`, `dirs`, `objects` (+`enter`) | Loop patrol until an object appears, then enter |
| `shifting_maze` | `target`, `rooms` | Learned-layout maze (minotaur) |
| `confluence_explorer` | `target` (id or `"tranquility"`) | The Elemental Confluence |
| `voln_seeking` | `target` | Symbol of Seeking travel |
| `ice_slope` | `cmd` | Icy descent with slip recovery |
| `chronomage_day_pass` | `towns`, `npc`, `ask`, `enter`, `exit` (+bank walks) | Day-pass purchase/use |
| `rogue_guild_door` | — | Secret-knock entry from `UserVars.rogue_password` |
| `uservar_sends` | `var` | Send each element of a UserVars list |
| `unique_crossing` | `name` | A relocated one-off program (lich-5 PR to add) |

---

## Submitting

Rooms live as individual `room.json` files in the mapdb repo's
`gs/rooms/{id}/` tree — your change is a small JSON diff, never an edit to
the monolithic file. CI validates structure, rejects any `;e` StringProc,
and runs the command-risk lint; a green check means any mapper can merge.
If the lint flags your toll/payment edge, add it to the allowlist in the
same PR. That's the whole process — no code review, no trusted-reviewer
queue, no waiting.
