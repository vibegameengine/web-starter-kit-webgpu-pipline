# Light leaks: what the design said, what the measurements said

Implementation of [bake-light-leaks-design.html](../public/bake-light-leaks-design.html), 2026-09-11.
Every number below is from a headed run on this machine and is reproducible with the command
printed beside it.

## The oracle came first, and it is the only reason any of this is checkable

`?scene=leak-room` is design section 07's A1/A2: a box stands on open ground, its walls in exact
contact with it and a lid on top. The interior is sealed, so **its true irradiance is zero** and
whatever the atlas holds on the inner faces is the error in physical units. `?gap=` lifts one wall by
that many millimetres, and the paired test is that light comes back — darkness alone is not a pass,
because thicker walls or a darker bake would produce it too. The check also demands the widest gap
reach 0.2 % of the sunlit ground, which global darkening cannot fake.

```bash
node scripts/check-leak-room.mjs contact 0,1,5,20
```

Measured through the baked atlas (`?leak=1`), never through the screen: exposure, tone mapping and
the probes cannot flatter the number.

## What actually leaked, in the order it was found

| Suspect | How it was separated | Verdict |
|---|---|---|
| The bake | `__audit.atlasIntensity(0)` and the streak stays | not the bake |
| Filtering across a wall | links off/on, 0.0313 / 0.00265 | **guilty**, section 05 |
| Donor reuse | `?bakeExactReuse=1`, 0.00164 / 0.00164 | innocent here |
| Atlas read at a hit | `?atlasHits=0`, 0.00164 / 0.00159 | innocent |
| Corners of the test room | walls overlapped, unchanged | innocent |
| Sky through escaped rays | `?env=0`, 0.00164 → 0.00002 | **guilty**, section 03 |
| Ray distance epsilon | `?triTEps=` sweep | **the whole of it** |
| Spawn offset in metres | `?scale=0.001`, 0.355 / 0.047 | **guilty**, section 03 |
| Raster shadow at a wall foot | `?shadowBias=0` removes the streak | **guilty**, section 06 |
| Shadow map resolution | texel sweep 6.3 → 0.7 mm, 72 → 2 px | **guilty**, section 06 |

## The three findings worth remembering

**One epsilon guarded three different quantities.** `intersectsTriangle` tested the determinant
(an area), the three barycentric coordinates (dimensionless) and the ray distance (a length) against
the same `1e-5`. The distance test was the leak: a ray leaving a corner hits the adjoining wall at a
tiny `t`, `1e-5` rejected that hit, the ray carried on out of the sealed room and its miss was paid
out as sky. Sealed interior: 0.00164 at `t = 1e-5`, 0.00148 at `1e-6`, 0.00071 at `1e-7`, **0.00001
at `1e-8`**, with the sunlit ground outside unmoved at 0.255 throughout. Self-intersection is the
spawn offset's job, not this test's.

**An offset in metres cannot follow a scene that changes size.** `clamp(sRad * 0.01, 0.0005, 0.01)`
put a hard half-millimetre floor under the ray offset. At `?scale=0.001` the room is 2 mm across with
0.2 mm walls, every ray started outside it, and the sealed interior read **0.355 against 0.248 for
the sunlit ground** — brighter inside a closed box than out in the sun. float32 keeps about seven
digits, so the offset now scales with the coordinate it is added to: 0.047 at that scale, and scale 1
unchanged. What is left is scale-bound in the cache itself — the surfel radius and the hash grid are
still parameterised in metres.

**A lit sliver narrower than one shadow texel draws a white line.** The streak along every wall foot
in the corridor was two faults. First `sun.shadow.bias = -0.0003`, a constant depth bias that moves
the comparison toward the light, which is exactly what lets the floor at a wall's foot escape its
shadow. Removing it left a thinner line that **no bias setting moved**: 251 bright pixels at 0 mm of
normal offset, 207 at 11 mm. Its width follows the shadow texel instead — 72 pixels at 6.3 mm, 11 at
3.2, 5 at 1.5, 2 at 0.7 — so the map is now sized to a target texel of 4 mm rather than a constant
4096, and the corridor gets 8192 at 3.7 mm.

## Traps this cost a detour each

**A shader that fails to compile looks exactly like a feature that works.** The filter-link kernel
named a variable `self`, which is reserved in WGSL. The pass produced no shader module, the link
buffer stayed at zero, and a zero mask rejects every neighbour — which silently turned the denoise
*off* rather than steering it. The commit that landed it reported an eleven-fold improvement measured
on a dead kernel. Passes now print what they did (`22414 links allowed, 1714 blocked, 69 hidden`), so
a dead kernel cannot pass for a working one.

**Three's Raycaster returns the interpolated normal, not the face normal.** A scan across a bright
line showed the normal swinging from `(0,0,1)` to `(0.435,0.900,0.014)` over four pixels, which was
read as smoothed vertex normals across a hard corner. `toCreasedNormals` at 40° made it *worse* — 369
bright pixels against 202 — because the geometry really does have a chamfer there. The question was
only settled by asking the geometry directly: `__audit.sunOccluded` casts a CPU ray to the sun and
reported the point blocked by a wall 10 mm away, which is what turned a "nothing to do here" into a
resolution fix.

**A bake read from cache answers no question at all.** Two runs of an A/B on the corridor came back
identical because both restored the same saved bake. Clear `public/bakes/` before comparing anything
that changes the bake; `?leak=1` bakes fresh and neither reads nor writes the cache for this reason.

**A fix with no measurement behind it is not a fix.** Three changes in this series moved nothing:
gating every donor on visibility, tracing the donor link exactly, and relocating the bake sample
within its texel. All three are corrections of a real rule — the arithmetic for the donor gate is not
arguable, a lone untested donor at weight 0.01 becomes the entire normalised answer — and all three
are shipped behind flags that default to the cheaper behaviour, with the null result recorded in the
commit rather than dressed up.

## Where the acceptance stands

```bash
node scripts/check-leak-room.mjs contact 0,1,5,20            # A1, A2 - green
node scripts/check-leak-room.mjs contact 0 "&lm=64"          # A4, one texel spans the wall base - green
node scripts/check-bake-leak.mjs corridor floor              # section 01 capture and its mutation - green
node scripts/check-leak-room.mjs contact 0 "&scale=0.001"    # A3 - RED, see below
```

Sealed room at the fine atlas: 0.00007 peak against 0.2592 for the sunlit ground, a 20 mm gap adds
0.00027, all three criteria pass. At 0.23 m per texel it reads 0.00001, from 0.0313 when this
started.

**A3 is red and stays red.** At `?scale=0.001` the sealed interior reads 0.047 against 0.2503 for the
sunlit ground - 18.8 %, against the script's own tolerance of 0.00025. The spawn offset was the
dominant term and is fixed; what remains is scale-bound in the cache itself. Do not read the three
green commands as "the acceptance is green".

## What a harsh critic found afterwards

An independent agent re-ran this work with no memory of writing it. Confirmed and fixed:

- **The shadow map was 8192 for every scene, not for the corridor.** `MIN_SHADOW_EXTENT = 15` forces a
  30 m shadow camera however small the scene, and a 4 mm target texel asks 8192 of 30 m every time -
  the Cornell box and the beach printed the same line while the commit message said "the corridor gets
  8192". The floor is 6 m now: Cornell takes 4096 over 16 m, the corridor 8192 over 26.
- **Two of three verdicts in `check-leak-room.mjs` could not fail on a single-gap run.** With no gap,
  `opened` is empty, `widest` is undefined and `every` on an empty array is true, so both halves of
  the paired test printed PASS without opening anything. Two of the four documented commands are
  single-gap. They print SKIPPED now.
- **`captured` in `check-bake-leak.mjs` was half a tautology** - `firstChange()` emits one entry per
  stage pair by construction. It checks stage names and world positions instead.
- **Two `@important` comments were lying**: one claimed 1.5 shadow texels where the code had 0.3, the
  other blamed the determinant and the distance for the same measurement in consecutive paragraphs.
  The determinant guard at 1e-12 still has no measurement behind it.
- **A JS `return` inside a TSL `If` is not a `continue`.** The placement loop read its own texel as a
  neighbour at `i = 4`, which `bit = i < 4 ? i : i - 1` turned into the left neighbour's bit.
- **The parity test marking texels "inside solids" was worse than useless.** It called 76107 of the
  corridor's 662784 charted texels inside and cut each out of the filter, leaving the raw transport's
  noise. Parity means nothing in an open sheet and those walls are sheets. Three directions vote and
  an exhausted traversal abstains; that moved the count by two. Off by default, `?bakeHidden=1`.
- **`0 allowed, 0 blocked, 0 texels` printed for both a dead kernel and an atlas where everything is
  blocked** - the very line this file offers as the guarantee against the first. Isolated texels are
  counted apart and a pass that writes nothing throws.

Confirmed and kept as a trade: **the links cost visible noise at contacts** - vertical second
difference on the Cornell cube edge 2.84 with them, 2.04 without, and four denoise passes instead of
two only reach 2.81. Kept because the other side is the sealed room reading 0.02965 without links
against 0.00001 with them. The contact texel needs its own domain, which is the split in Not done.

Its one false finding, retracted by itself: "the beach never reaches a frame". It does, in about
183 s of page time; the capture harness was timing out. That retraction is why the report is worth
reading.

Still open from the critique: `?triTEps=` and `?triDetEps=` on needle triangles - the beach's foliage
and the forest's ez-tree - because another session was editing the tree while it measured.

## Not done

- Section 02's domain split. Two sides of a contact still share one texel and one value; only the
  placement half exists, and it is off because nothing measured pays for it.
- Section 03's watertight triangle test and the `Incomplete` state — a ray that exhausted its
  traversal still counts as a miss.
- Section 07's A5, A8, A10, A11 and the independent CPU path tracer. Without that reference the
  acceptance compares the renderer against a sealed box, which catches leaks but cannot catch a
  uniformly wrong answer.
- Cascades for the sun shadow. `sunShadowFit` fits the shadow camera to the view and is off by
  default: on the corridor the bounding sphere of a 30 m frustum is 26 m against the world fit's 15,
  so it needs a distance cap, and that costs the far shadows.
