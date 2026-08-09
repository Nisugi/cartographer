# @eol/cartograph

The current goals of this project are as follows:

- [ ] create a git history for the MapDB
- [ ] ability to import directly from the `;repository`
- [x] untangle `StringProc` from the node (Room) definitions

## StringProc-free MapDB

`bun run mapdb convert --lich5 <lich-5 checkout>` converts every `;e`
StringProc in a downloaded mapdb into declarative **MapEngine schema**
(steps, strategies, cost gates) using the canonical converter in
lich-5 (`tools/mapdb_convert.rb`). The converted map contains zero
executable strings; the `git` task then explodes it into per-room
`room.json` files whose edges are plain, reviewable JSON — no `.rb`
sidecars, no code review for map submissions.

CI gate (requires a lich-5 checkout, no game connection):

```
ruby tools/mapdb_validate.rb --rooms <gitdir>/rooms --forbid-procs
```

This validates every schema entry against the engine's vocabulary and
fails if any `;e` StringProc reappears. Zod validation here checks
structure only; the Ruby validator owns the vocabulary (single source
of truth). A brand-new proc idiom in an upstream map shows up as
`convert` reporting remaining StringProcs — coverage is added in
lich-5 (recognizer, manual conversion, or relocated crossing), never
by hand-editing converted output.
- [ ] build a CI/CD pipeline for the MapDB
- [ ] provide tools for working directly with the mapDB
- [ ] create a `;go2` utility that uses the tarball from this repository
- [ ] some sort of bot that pulls and merges changes from the MapDB (this is difficult)
## Command risk lint

Submission CI runs lich-5's validator with this repo's allowlists:

```
ruby tools/mapdb_validate.rb --rooms <tree> --forbid-procs \
     --lint-commands config/allowlists/command-allowlist-gs.json
```

Any wayto command starting with a wealth/item-moving verb (`give`,
`put`, `drop`, `_drag`, `trade`, `accept`, `sell`, `deposit`,
`withdraw`) fails validation unless its `room:dest` edge is listed in
`config/allowlists/`. Legitimate uses are tolls, donations, and prop
puzzles - currently 9 GS edges and 1 DR edge. Approving a new one is
an allowlist addition in the same PR as the edge, so the command and
its human sign-off appear in one diff. The allowlist lives here, not
in lich-5, so approvals never wait on a Lich release.
