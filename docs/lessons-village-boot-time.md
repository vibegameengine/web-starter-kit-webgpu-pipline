# Why the village takes minutes to boot

Measured 2026-09-11 on the root tree, headed Chrome, 1280x720, dev server.
Tooling written for this: `scripts/check-boot-stages.mjs` (timeline of every
`bootStage` label, taken from inside the page with a MutationObserver on
`#loading-message`, plus overlay-hidden and 30-steady-frames marks),
`scripts/_boot_profile.mjs` (CDP `Profiler` over a named stage window),
`scripts/_diff_png.mjs` (where two frames differ, by row and column band).

## The numbers

Cold launch of `?scene=midsee-village`: **182.5 s** to steady frames.

| block | seconds |
|---|---|
| scene build (water settle 7.1, rest) | 10.5 |
| lightmap UV unwrap | 2.1 |
| static BVH | 2.4 |
| contact BVH | 6.5 |
| lightmap + probe bake | 92 |
| saving the bake | 2.2 |
| Compiling shaders | 22.6 |
| first frame | 41.3 |

Second launch, bake read from `public/bakes/`: **75.0 s**. The bake is gone from
the timeline; everything else is unchanged. So a user who sees five minutes is
looking at a cold bake plus a machine loaded by other agents - nine dev servers
were listening on 5188-5196 while this was measured, and repeat runs of the same
configuration varied between 72 s and 88 s.

## Where the 50 s of every launch goes

"Waiting for the first frame" is not a stage that waits. `startLoop` returns
immediately; the label stays on screen because `bootStage` pops it and
`announce()` does nothing with an empty stack, so the overlay keeps the last
label until `clearLoading()` at the second rendered frame. That block is
therefore the first two frames, and that is where WebGPU pipelines are created.

A CDP profile from the start of "Compiling shaders" to the overlay hiding,
47.8 s wide:

```
12.00s  (idle)                            GPU-side compile
 7.97s  getNodeType      MathNode.js:136
 3.30s  getTypeLength    NodeBuilder.js:1561
 2.92s  getNodeType      OperatorNode.js:110
 2.51s  getNodeType      VarNode.js:154
 1.87s  isMatrix         NodeBuilder.js:1371
 1.83s  (garbage collector)
 1.28s  getComponentType NodeBuilder.js:1445
```

35 of the 48 s is JavaScript on the main thread inside three's `NodeBuilder`,
resolving TSL node types. `MathNode.getInputType` asks `aNode.getNodeType()`,
`bNode`, `cNode`; each child asks its own children; nothing is memoised and a
node is asked once per parent per build stage, so a deep expression tree is
re-typed a combinatorial number of times. Only 12 s of the window is the GPU.

## What is not the cause

- Post and trace kernels. `?reflections=0&fog=0&glare=0&aa=none&probeSpecular=0`
  gave 80.7 s against a 75.0 s baseline - inside the run-to-run spread, first
  frame unchanged.
- The PCSS sun filter. `?shadowFilter=receiverPlane` gave 87.9 s. Also nothing.
- Scene content and the BVH builds. 19 s of 75, and `?scene=village-light`
  (one house, the same materials) boots with a 3.0 s first frame and a 2.2 s
  shader stage - the cost tracks the number of distinct materials, not the
  triangle count.

## The fix that was measured, and why it is not in this tree

A per-build type cache in the fork - `NodeBuilder.typeOf(node)`, a `WeakMap`
keyed by `buildStage|shaderStage`, skipped during `setup`, with
`globalThis.__nodeTypeCacheOff` as the ablation - and the three hot recursion
sites (`MathNode.getInputType`, `MathNode.getNodeType` EQUALS branch,
`OperatorNode.getNodeType`, `VarNode.getNodeType`) routed through it.

`scripts/check-node-type-cache.mjs` boots the village twice in the same
configuration, once with the cache disabled from `addInitScript`:

```
cache off: shaders 21.7s  first frame 41.9s  exposure 0.538129985332489
cache on : shaders  5.5s  first frame 10.8s  exposure 0.5381324291229248
saved 47.2s
```

The image comparison is not yet closed. Two independent launches of the same
build differ in 36.6 % of pixels, worst channel 62/255, and the difference does
not come from the cache: metered exposure settled to the same 0.53813 in both,
a global gain removal makes the count worse, and the amplified diff image is
faint uniform noise everywhere plus bright geometry silhouettes - film grain and
TAA jitter phase, not shading. The control - two boots with the cache on in both
- gives 0.015 % and worst 10/255, but only because those two runs reached the
first frame within 0.6 s of each other. The comparison has to be re-run with
`&grain=0&aa=none` before the cache can be called visually equivalent.

`vendor/three` is junctioned into every worktree, so this patch cannot be
isolated by branching: it was reverted in the root tree and the work moves to a
worktree with its own copy of the fork.

## Traps

- `bootStage` has no timing of its own, and the label that is on screen when a
  boot feels stuck is the last one pushed, not necessarily the one doing the
  work.
- Two launches of this app are never pixel-identical. Grain is per-frame noise
  and TAA converges from a jitter sequence that depends on how many frames have
  passed; a check that compares screenshots has to turn both off or it measures
  its own scheduling.
- A boot comparison on a machine shared with eight other dev servers has a
  16 % spread. Anything smaller than that is not a result.
