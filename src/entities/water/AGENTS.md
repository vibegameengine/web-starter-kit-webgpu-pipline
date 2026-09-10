# Water work

Before changing water rendering, read `docs/water/reflection-contract.md` and `docs/water/unreal-water-reference.md` from the repository root.

User requirements recorded on 2026-09-10:

- Preserve the quality of the previously successful reflections while optimizing. The later reduction to one eighth of screen width/height was not accepted.
- Total water GPU budget is 1–2 ms, including associated simulation and rendering work. Worker GPU work is not free.
- Current wave shape and foam are not accepted. Passing numerical tests does not establish visual quality.
- Validate changes in the existing standalone water lab with headed rendered comparisons before beach integration. Do not replace working reflections with SSR merely to copy Unreal's documented base pipeline.

`wip/water-upgrade/reflection-preservation-latest.json` locates the source snapshot, historical captures and SHA-256 manifest. The snapshot is current code, not an exact checkout of the older quality reference; preserve that distinction.
