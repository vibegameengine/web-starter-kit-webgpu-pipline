# Round 1 — consolidated defect list

Reference: `concepts/beach.png`. Reviewed render: `shots/beach/gauntlet/round0.png`
(mean abs diff 52.52). Critics: A composition, B materials, C lighting, D props,
E unlensed. Raw reports are in the session; the numbers below are theirs.

Ordered cause before consequence: camera/landform → placement → light → surface → detail.

## Defect list

| # | from | file / symbol | change | value |
|---|------|---------------|--------|-------|
| 1 | A1, E10 | `beachScene.ts` camera | pull back to the reference corner view; whole slab + palms + negative space in frame | `fov 34`, `position (-18.8, 11.0, 19.1)`, `target (2.25, -2.9, -2.5)` |
| 2 | A2, E1 | `heightField.ts` `height()` `t`/`bay` | landform: water on the whole left face, sand on the right corner, shore bulging to x≈3.5 mid-slab | `bulge = 4.8*max(0, sin(π(z+5)/12.5))`; `t = 0.85*(x + 0.75z + 1.2 − bulge)/h + 0.08*fbm2(x*0.09+3.1, z*0.09, 3)` (A verified: water share 0.653, crossings z=−6:x=3.3, z=0:3.4, z=3:1.0, z=6:−4.1) |
| 3 | A6 | `heightField.ts` `floor` | deep water at the left corner (72% of the cut) | `-0.35*smooth(-0.15,-1.2,t)` → `-1.05*smooth(-0.15,-1.2,t)` |
| 4 | E3 | `water/index.ts` `cutDepth` | glass reaches the new floor | `2.2 → 3.0` |
| 5 | D5, B6 | `heightField.ts` `height()` rim; `island/index.ts` walls | rounded irregular rim; stones start at the lip; fewer, larger stones; no fine crumple | rim: `e = smooth(half-0.6, half, max(|x|,|z|))`, `y -= 0.3*e*e`, `y += 0.08*fbm2(x*1.3, z*1.3, 2)*e`; walls: `rockField = ridged3(bx*0.55+3, y*0.9, bz*0.55, 4)`, `rockMask = clamp((rockField-0.6)*4)`, `reach = clamp(sub/0.2)*(1-0.6v²)`, `bulge = 0.04*lumps + 0.7*rockMask*(0.5+0.5*lumps)` (applied), `strata` follows |
| 6 | A3, D1 | `beachScene.ts` `palmSpecs` | three palms strung along the +x rim, crowns inside the frame against the backdrop | `{x:5.6,z:-2.8,h:5.8,lean:-0.22,seed:41}`, `{x:5.7,z:0.6,h:5.1,lean:-0.12,seed:42}`, `{x:5.6,z:2.6,h:4.4,lean:0.05,seed:43}` (drop the 4th) |
| 7 | D1, D6 | `palm/index.ts` | crown diameter 6.0/3.9/3.6 m for h 5.8/5.1/4.4: frond length ≈ 0.45–0.57 h; broader feathers | `frondLength = clamp(height*(0.45 + rng()*0.12), 1.6, 3.0)`; `leafletLength = clamp(frondLength*0.34, 0.5, 0.9)`; `vAngle 0.45 + rng()*0.25`; `leafletWidth 0.075 + rng()*0.025`; `tipElevation lerp(-0.75, -1.3, age)`; `frondCount = 15 + floor(rng()*4)` |
| 8 | D7, D9 | `palm/index.ts` | trunk radius 0.30–0.40 m; visible coconuts | `lerp(0.17, 0.11, t)*sizeK`; `nutCount 8+floor(rng()*5)`, `r 0.11+rng()*0.04`, `dist 0.25+rng()*0.2`, `y = crownBase.y − 0.4 − rng()*0.15` |
| 9 | A4, D2 | `beachScene.ts` `rimRocks` (+`sharpness` in RockSpec) | boulder massif on the right half of the back rim, ~6.5 m long, 2.3 m tall, blocky, left third standing in the water | `{x:0.4,z:-5.0,r:1.6,sink:0.15}`, `{x:2.0,z:-5.4,r:1.3,sink:-0.05}`, `{x:1.2,z:-4.6,r:1.0,sink:-0.7}` (capstone), `{x:-1.2,z:-4.4,r:0.9,sink:0.1}`, `{x:3.4,z:-5.6,r:1.0,sink:0.05}`, `{x:4.8,z:-5.2,r:0.9,sink:0.2}`, `{x:-2.4,z:-5.2,r:0.7,sink:0.0}`; all `sharpness 0.85`, keep seeds 11–17 |
| 10 | A7, D4 | `beachScene.ts` `rightRocks`, `waterRocks` | right-rim rocks under the new palms move; three lagoon boulders break the surface | rightRocks first three → `{x:4.7,z:2.8,r:0.9}`, `{x:4.9,z:4.7,r:0.65}`, `{x:3.0,z:0.9,r:0.55}`; waterRocks seed 31 `r:1.1,sink:-0.05`, seed 33 `r:0.95,sink:-0.15`, seed 34 `r:0.9,sink:0.0` |
| 11 | A5, D3 | `beachScene.ts` `shrubSpecs`; `shrub/index.ts` | continuous 1.2–1.5 m hedge along the +x rim under the palms | positions x 5.3–5.8, z = −5.5,−4.0,−3.2,−2.0,−0.5,1.2,2.2,3.4 (+ D's extra fans at z −5.5/−3.5 on the rim), radii 0.9–1.2; `stemLength = radius*lerp(0.45,1.1,u)*(0.85+rng()*0.3)`; fan `stemLength = radius*lerp(1.0,1.4,u)*…` |
| 12 | D8 | `rockGeometry.ts` | no wedge rocks: aspect ≤ 1.6 | `depth = 0.08 + rng()*0.12*(0.5+sharpness)`; `lumpAmp = 0.12 + rng()*0.1` |
| 13 | C1, E2 | `main.ts` `sunAz`/`sunEl` | key from screen-left/front, palm shadows leave the slab | `28 → 185`, `52 → 48` |
| 14 | C4 | `main.ts` `envIntensityParam` | rock lit/shade ratio 2.0 (ours 1.16) | `1.6 → 0.7` |
| 15 | C7, C8 | `beachScene.ts` `sun.color`; `main.ts` exposure | warm gold key, lit sand L≈192 | `(1.0, 0.85, 0.62)`; `1.15 → 1.0` |
| 16 | C2, E5 | `backdrop/index.ts` | lit cyclorama 2.6:1 warm-left → cool-right, mapped to the *new* camera's visible cone | `upness = smoothstep(-0.70, -0.12, dir.y)`; `sideness = smoothstep(0.26, -0.26, dot(dir, (0.71, 0, 0.70)))`; `dark (0.055, 0.060, 0.078)`, `light (0.55, 0.42, 0.33)`; `grade = mix(dark, light, side*0.6 + up*0.4)` |
| 17 | E4 | `backdrop/index.ts` pool | the slab floats: dark pool right under the corner | `floorY = islandBottom − 0.8`; `radial = |hit−centre|/islandHalf`; `pool = 1 − smoothstep(0.95, 1.7, radial)`; `shadow = pool*0.5` |
| 18 | B1, C3, E7 | `water/medium.ts` `WATER_ABSORB`; `water/index.ts` | teal not blue; floor and submerged rocks visible; note the sand and the tracer now ALSO attenuate the sun path, so absorption is applied twice on the floor | `WATER_ABSORB (0.45, 0.07, 0.035)` (clear tropical water, Jerlov I); `scatter (0.03, 0.14, 0.15)`; `scatterAmount exp(-0.25·path)`; `envStrength 0.45` |
| 19 | B3 | `water/index.ts` `waveNormal`, roughness | ripple sparkle | q2 slope `0.006 → 0.028`, q1 `0.03 → 0.045`, `roughnessNode mix(0.08, 0.04, isTop)` |
| 20 | B4, E6 | `water/index.ts` `foam` | lace band, 6.8% white in the shore region, median thickness ≥ 30 px | `band = smoothstep(0.95, 0, verticalDepth)`, `edge = smoothstep(0.25, 0, …)`, `.sub(1.05) → .sub(0.85)` |
| 21 | B2, E8 | `sandMaterial.ts` `caustic` | finer, brighter, shallows only | (applied) freq 8.0/11.5, lines 0.06, emissive 0.85; fade `exp(depth*-1.4) → exp(depth*-3.5)`; also add the caustic term to the `submerged` rock material |
| 22 | B5 | `sandMaterial.ts` grain | (applied) grainCoarse 22/0.20, mottle 0.10, bump q=30 s=0.9, speck 60 | — |
| 23 | B7 | `cliffMaterial.ts` | (applied) soil grey-pink brown, rock darker than matrix | — |
| 24 | B8 | `rocks/index.ts` `TARGET_ALBEDO_SRGB` | lit facet L ≈ 0.4–0.5 × sand | `dry [0.42, 0.37, 0.31]`, `submerged [0.30, 0.32, 0.26]` |
| 25 | B9, C9 | `palm/index.ts`, `shrub/index.ts`, `foliage/translucency.ts` | warm yellow-olive glossy leaves, R ≥ G in the lit canopy | palm `green [0.20,0.30,0.05]`, `yellowGreen [0.58,0.55,0.10]`, roughness 0.32; shrub `LEAF_BASE (0.12,0.20,0.04)`, `LEAF_TIP (0.55,0.52,0.08)`, roughness 0.35; translucency palm 0.28 → 0.45, shrub 0.20 → 0.30 |
| 26 | B10 | `palm/index.ts` bark | (applied) base `[0.24,0.12,0.035]`, groove 0.6 | — |
| 27 | C5 | `palm/index.ts` trunk | trunks render pure black (0,0,0) on every probe; atlas shows lit charts → the raster albedo/lookup, not the bake | diagnose with `split=albedo`; acceptance lit side L ≥ 100, shaded ≥ 30 |
| 28 | C6 | `src/shared/gi/bake/` (manager) | black atlas texels under stamped rocks bleed into the sand | dilate unlit covered texels from lit neighbours before publishing/saving the lightmap |

## Rejections

- **Rejected D2's rock positions (x −3.2…0.6, back-left)**: they assume the round-0 landform; A owns composition and unprojected the reference cluster to the right half of the back rim. D's sizes, sink values, capstone and `sharpness` are kept.
- **Rejected D1's palm heights (3.8/3.4/4.2/2.6)** in favour of A's 5.8/5.1/4.4: A's camera fit (rms 47 px, 58.5 px/m at the rim) is the more careful scale; D's crown-diameter measurement is kept and converted into the frond-length ratio.
- **Rejected E3's flat `floor -1.9`**: it deepens the front corner too, which A measured at 34% water / 1.1 m; A's t-dependent deepening keeps the front and deepens the left.
- **Rejected B1/C3/E7 absorption values (1.8 / 1.2 / 0.6 red)**: all three were measured on round0, before the medium was also applied to the sun path in the sand shader and in the tracer. With three attenuations in series even C's 1.2/m leaves 19% red at 0.5 m. Physically plausible clear-water absorption (0.45/m red) is written instead; the round-2 measurement decides.
- **Rejected E5's backdrop weights (0.3 up / 0.7 side)** in favour of C's 0.4/0.6; both mappings are re-derived for the new camera because the camera moves first.
- **Rejected D5's `reach = sub/0.2` only partially**: kept (stones at the lip), but with B6's removal of the 6/m noise so the lip is stones, not crumple.
- **Not applied C4's secondary `shadowStrength 1.0`**: unmeasured; try in round 2 if the rock ratio is still < 1.8.

## Closed — do not file again

None.
