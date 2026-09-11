# Creating your own instance of this repository (2026-09-11)

Several agents work in this checkout at once. Editing the shared tree while someone else
runs a capture in it means their frame is your half-finished change. Work in your own git
worktree; the existing ones (`worktrees/lod`, `worktrees/look`, `worktrees/reflections`)
are the pattern, and this is what they do plus the parts that only show up when they are
missing.

## The recipe

From the repository root, with `<name>` short and about the work:

```bash
git worktree add worktrees/<name> -b <name> pipeline-v3
cmd //c "mklink /J worktrees\<name>\node_modules node_modules"
cmd //c "mklink /J worktrees\<name>\vendor vendor"
cmd //c "mklink /J worktrees\<name>\dashboard dashboard"
cmd //c "mklink /J worktrees\<name>\config config"
cmd //c "mklink /J worktrees\<name>\public public"
```

Junctions, not copies: `node_modules` is gigabytes, `vendor` holds the patched
react-three-fiber source that `vite.config.ts` aliases to, `dashboard` holds the Vite
plugins that same config imports (untracked — a fresh worktree does not get it and Vite
then fails to start), `config` is the shared GUI settings, and `public` carries the HDR
panoramas and the bake cache, which is keyed by scene name and therefore shared safely.

## Uncommitted work in the root tree

`git worktree add` checks out a commit. If what you need to work on is uncommitted in the
root tree — 253 dirty entries when this was written, with the whole village scene
untracked — your worktree will not have it. Two honest options:

- commit it on the root branch first (the user's standing permission, 2026-09-11: "если
  в головном что-то не закоммичено и вам мешает, смело коммитьте"), then create the
  worktree from that commit; or
- copy the working files over after creating the worktree (`cp -r src scripts` plus
  `index.html package.json tsconfig.json vite.config.ts`) and remember that you are now
  holding a snapshot, not a branch of them.

`git checkout -- vite.config.ts` inside the worktree restores the **committed** 13-line
config, which has no `bakeCachePlugin`, no `guiSettingsPlugin` and no feed plugins. A
scene then re-bakes its probes on every boot and looks slow for no reason. Copy the
root's `vite.config.ts` in.

## Ports

Every `vite.config.ts` here asks for 5188 and Vite takes the next free port when it is
busy, so worktree servers land on 5189, 5190, 5191 … Read the port out of the dev log —
never assume:

```bash
(npm run dev > tmp-dev.log 2>&1 &) && sleep 8 && grep -o "127.0.0.1:[0-9]*" tmp-dev.log
```

169 scripts hardcode `http://127.0.0.1:5188`. Write new checks so the port comes from
the environment (`const port = process.env.PORT ?? '5188'`) and pass `PORT=` when you run
them, or you will be measuring another agent's tree.

`cacheDir` is shared through the `node_modules` junction; `worktrees/lod` sets
`cacheDir: '.vite-lod'` in its config for that reason. Do the same if two servers run
against the same modules at once and the dependency cache starts fighting.

## Before you edit

`node scripts/own.mjs --who <path>`, then claim what you are about to touch with
`own.mjs --session <printed-session> --claim "<path>" --why "<work>"`. The worktree does
not isolate you from ownership: the branch is yours, the file's owner is still whoever
claimed it.

## Test rigs, not production scenes

A worktree fixes collisions, not slowness. If the scene you need boots in 90 s, build a
stripped copy of it in the same code path (see `villageLightScene.tsx`, one house of the
village, 12 s) and run the measurement there. A four-boot measurement on a 90-second
scene is a ten-minute loop, and it will be stopped before it answers anything.
