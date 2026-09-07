**The reference is `C:\Users\pavel\projects\AIGamess\ThreejsShowcase\concepts\beach.png`** (1254×1254). It is the artefact the user gave; it is not our work and not up for revision. **The recreation under review is the running app** (Three.js r182 WebGPU, project `C:\Users\pavel\projects\AIGamess\ThreejsShowcase`, scene code in `src/widgets/world/beachScene.ts` and `src/entities/{island,water,rocks,palm,shrub,backdrop,foliage}/`, app params in `src/app/main.ts`), **rendered to `C:\Users\pavel\projects\AIGamess\ThreejsShowcase\shots\beach\gauntlet\round0.png`.** Open both PNGs yourself with the Read tool. Do not reason from anything I tell you about them.

Both are in the shipping frame: viewport 1254×1254, deviceScaleFactor 1, full page, HUD off. (The small "FPS" widget top-right of the render is the three.js Inspector overlay, already known, ignore it.) Any extra view you take must use the same frame:

```
node scripts/capture-chrome.mjs shots/beach/gauntlet/<yourname>-<n>.png --w 1254 --h 1254 --wait 300000 --url "http://127.0.0.1:5188/?scene=beach&hud=0&iters=48"
```
(run from the project root; ~3 min because the static lighting bakes. Add `&mode=surfel&bake=0` for a 1-min un-baked look — never judge lighting on that.) URL knobs you may append to test a hypothesis without editing code: `sunAz=<deg>&sunEl=<deg>&sun=<intensity>&env=<sky intensity>&exposure=<n>&waterDebug=path|depth|hit&waterCuts=0&split=albedo|normal|lightmap|indirect&splitAt=0.5`.

Measure with these (absolute paths; run from anywhere), and you are expected to:

```
node C:/Users/pavel/.claude/skills/gauntlet-loop/harness/probe.js <png> x,y x,y ...        colour at points (PNG device px)
node C:/Users/pavel/.claude/skills/gauntlet-loop/harness/scan.js  <png> h:<y> v:<x> [--min 4]   runs of flat colour along a row/column
node C:/Users/pavel/.claude/skills/gauntlet-loop/harness/bbox.js  <ref.png> <ours.png> --rgb r,g,b --tol 30 --region x,y,w,h   where a colour lives, and its delta
node C:/Users/pavel/.claude/skills/gauntlet-loop/harness/diff.js  <ref.png> <ours.png>          one overall number (round0: mean abs diff 52.52)
```
You may also write a throwaway Node script in your scratchpad that reads PNG pixels (pngjs is installed in the project) if you need a statistic the harness lacks (mean colour of a region, luminance histogram). State every command you ran.

Pipeline constraint you must respect in prescriptions: the scene is lit by the project's hybrid surfel GI (static geometry baked into a lightmap atlas by the surfel integrator; foliage lit by live surfels; water and backdrop outside the GI, the studio floor is an invisible GI bounce surface). Do not prescribe a second lighting path or constant ambient hacks; prescribe values in the existing symbols (sun angles/intensity/colour, env intensity, material albedo/roughness nodes, water uniforms `absorb/scatter/scatterStrength/envStrength/foamStrength`, geometry parameters, camera). Read the relevant source files so that every prescription names a real file and symbol.

**Every defect must carry a number and a patch.** "Too dark" is unusable. The form: what I measured (command + values), what the reference measures, the file, the symbol, the value to write. If you cannot measure something, say so and say what you would need — do not upgrade a hunch into a finding.

You are **read-only**: do not edit, create or delete project files (scratchpad scripts and your own shots/beach/gauntlet/<yourname>-*.png renders are fine), do not run the build. Give me a **ranked list, worst first, at most 10 items**, ranked by how much the defect costs the resemblance to the reference, not by ease of fix. **Skip praise** except one closing sentence. Closed list (do not file): none yet.
