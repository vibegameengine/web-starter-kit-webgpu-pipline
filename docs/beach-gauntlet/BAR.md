# The bar — beach diorama (defined before the first gauntlet round)

- **Reference (the artefact the user gave, never our own output):**
  `concepts/beach.png` — 1254×1254, a floating cut slab of coral sand with a
  turquoise lagoon on the open front-left side, boulders, coconut palms and
  tropical undergrowth, on a neutral warm-grey studio backdrop.
- **The recreation (our work, never called "the reference"):** the running app
  at `http://127.0.0.1:5188/?scene=beach&hud=0&iters=48`, rendered to
  `shots/beach/gauntlet/round<N>.png`.
- **Pipeline constraint (not negotiable):** the scene is lit by the project's
  hybrid GI — static geometry baked into the lightmap atlas by the surfel
  integrator, foliage lit by live surfels, water/backdrop outside the GI.
  No fix may replace or bypass that pipeline (no fake ambient constants that
  stand in for bounce; no second lighting path).
- **Shipping frame for every verification render:** viewport 1254×1254,
  deviceScaleFactor 1, `hud=0`, full page, captured after the bake settles:

  ```
  node scripts/capture-chrome.mjs shots/beach/gauntlet/<name>.png --w 1254 --h 1254 --wait 300000 --url "http://127.0.0.1:5188/?scene=beach&hud=0&iters=48"
  ```

  (`&mode=surfel&bake=0` renders without the bake in ~1 min — only for quick
  material checks, never for a judged frame.)
- **Measurable budget:** zero console errors; the bake completes within the
  surfel pool (no "pool exhausted" refusal); ≥ 24 fps at 1600×900 after the bake
  on the RTX 4080 SUPER; total scene ≤ 400k triangles.
- **Stop condition:** two consecutive critique rounds in which no critic (four
  lensed + one unlensed) reports a defect that would be visible side by side at
  100% to an art director. **Capped at 3 rounds regardless.** Outstanding
  defects at the cap are handed to the user as a list, not fixed by a fourth
  round.

## Measured facts from the reference (device px in the 1254² PNG)

Filled in by the round-1 critics with the harness; the manager does not quote
from memory.

## Accepted deviations (closed)

None yet.
