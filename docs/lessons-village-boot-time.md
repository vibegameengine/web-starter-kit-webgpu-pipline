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

## The fix

A per-build type cache in the fork - `NodeBuilder.typeOf(node)`, a `WeakMap` keyed by
`buildStage|shaderStage`, skipped during `setup` because a node's type is not settled
until its children are built, with `globalThis.__nodeTypeCacheOff` as the ablation - and
the four hot recursion sites routed through it: `MathNode.getInputType`, the EQUALS
branch of `MathNode.getNodeType`, `OperatorNode.getNodeType` and `VarNode.getNodeType`.
The patch is `docs/patches/three-node-type-cache.diff`, four files, 82 lines.

`scripts/check-node-type-cache.mjs` boots the village twice in the same configuration,
disabling the cache in one arm from `addInitScript`, and compares the settled frames:

```
cache off: shaders 17.0s  first frame 37.8s  exposure 7.999996662139893
cache on : shaders  6.2s  first frame  9.8s  exposure 7.999999046325684
saved 38.8s
pixels differing by more than 1/255: 75 of 921600 (0.008%), worst channel 7/255
```

`vendor/three` is junctioned into every worktree, so the patch cannot be isolated by
branching. It was reverted in the root tree; `worktrees/boot` carries its own copy of the
fork's `src` and `examples` and the patch is applied there. Landing it means a commit in
the fork repository, which every session shares.

## The image comparison that nearly rejected a correct fix

The first A/B reported **98.8 % of pixels differing, worst channel 126/255**, and the
second 36.6 % - against a control of two identical boots at 0.015 %. Three things had to
be ruled out before the difference could be attributed:

- Metered exposure. It adapts over seconds, and the two arms reached their first frame
  20 s apart, so they were sampled at different points of the ramp. Reading
  `__fog.exposure()` at capture time settled it: 0.538129985332489 against
  0.5381324291229248, and later 7.999996662139893 against 7.999999046325684. Not exposure.
- A global gain. Dividing out the mean ratio made the count worse, not better, so the
  difference is not a brightness scale.
- Where the pixels are. `scripts/_diff_png.mjs` bands the difference by row and column:
  it was uniform across the frame, including the empty grey backdrop, plus bright
  silhouettes along every geometry edge. That is film grain - per-frame noise - and TAA
  jitter phase, which depends on how many frames have been accumulated.

With `&grain=0&aa=none` the same comparison gives 75 pixels of 921600, worst 7/255. The
cache is visually equivalent; the harness was measuring its own scheduling.

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
