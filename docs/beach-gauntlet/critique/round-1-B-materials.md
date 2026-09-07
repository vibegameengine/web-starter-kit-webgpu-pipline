# Round 1 — Critic B (materials & texture), verbatim summary

1. Water blue not turquoise; cut face opaque blue wall. deep REF hue 177–181 vs OUR 196–197; shallow REF (88,166,158) vs OUR (91,139,164); cut face REF L149 floor visible vs OUR (12,132,173). Write: water `scatter → (0.010,0.26,0.27)`, `WATER_ABSORB → (1.8,0.28,0.22)`, `scatterAmount` coeff `-0.6 → -0.25`. Target deep hue 176–184, cut-face L ≥ 120.
2. Caustics 3× too coarse, half contrast. REF 4.2 seg/100px w4.3 gap18.5 +37%; OUR 1.6 w7.9 gap48.6 +20%. Write sandMaterial: `q1 3.0→8.0`, `q2 4.2→11.5`, line smoothsteps `0.12→0.06`, emissive `0.55→0.85`. Also attach caustic term to submerged rock material.
3. No ripple sparkle. deep REF Lsd 33.5 |∇L| 17.8 22 peaks; OUR 12.9/3.0/2. Write water: q2 slope `0.006→0.028`, q1 `0.03→0.045`, `roughnessNode → mix(0.08,0.04,isTop)`.
4. Foam flecks not lace. REF 6.8% white, median thickness 38px p90 94; OUR 1.6%/7/14. Write: `band → smoothstep(0.95,0,verticalDepth)`, `edge → smoothstep(0.25,0,…)`, `.sub(1.05)→.sub(0.85)`.
5. Dry sand no grain. REF Lsd 22 |∇L| 17.2 28 peaks; OUR 3.2/2.8/5. Write: grainCoarse freq `48→22` gain `0.07→0.20`; mottle `0.06→0.10`; bump `q=p*30`, `s 0.35→0.9`; speck freq `160→60`.
6. Cut walls uniformly crumpled. REF |∇L| 1.2–8.5, 0–2 peaks; OUR 11–15.6, 19–26 peaks. Write island/index.ts: `0.05*noise3 → 0`, `0.10*lumps → 0.04*lumps`, `rockMask → clamp((rockField−0.60)*4)`, rock bulge `0.5→0.7`; cliff `nSoil` strength `0.6→0.25`.
7. Wall colour: soil too yellow, rock brighter than matrix. REF hue 16–27, rock L87 < soil L130; OUR hue 36–45, rock L103 vs soil L136. Write cliff: soilTint dark `(0.40,0.34,0.29)`, pale `(0.76,0.64,0.52)`; rock mult `(2.4,2.3,2.3)` clamp 0.55; crust `(0.82,0.72,0.58)`.
8. Dry boulders 2× too bright on lit facets. REF L≈85 = 0.41×sand; OUR L≈165 = 0.77×sand. Write rocks: `dry → [0.42,0.37,0.31]`, `submerged → [0.30,0.32,0.26]`. (Black shaded faces: lighting lens.)
9. Foliage grey-green matte; REF warm yellow-olive with glints. crown REF hue 41, 2.7% L>200; OUR hue 57, 0%. Write palm `green→[0.20,0.30,0.05]`, `yellowGreen→[0.58,0.55,0.10]`, roughness `0.55→0.32`; shrub `LEAF_BASE→(0.12,0.20,0.04)`, `LEAF_TIP→(0.55,0.52,0.08)`, roughness `0.45→0.35`.
10. Bark neutral grey; REF orange-brown hue 35 sat 0.66. Write palm `buildBarkTexture base → [0.24,0.12,0.035]`, `groove*0.4→0.6`.
