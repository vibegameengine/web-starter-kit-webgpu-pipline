# Village material sources

`limestone-albedo.png` is an AI-generated seamless single limestone surface, generated sequentially for the village quay on 2026-09-11. Source output: `C:/Users/pavel/.codex/generated_images/01a08fc0-b6aa-78e2-bab4-dec116bfa730/exec-48311709-0662-480f-9d72-9f6a103d04d9.png`.

`limestone-normal.jpg` is a local copy of the project's existing `public/textures/rock/Rock030_2K-JPG_NormalGL.jpg`, reused at low strength until a limestone-specific normal is available. It is not a generated matching PBR map.

Village-specific textures live with this entity and are imported as Vite asset URLs. Existing shared beach resources remain owned by the original entities.

`plaster-albedo.png` is a neutral limewashed stucco albedo generated on 2026-09-11 for the five facade tints. Source: `exec-e319f054-e06a-401e-87cd-02f1f7cdd206.png` in the same generated-images session directory. It is an albedo only; no matching normal or roughness has been inferred from it.

`pine-needles.png` is a 1254×1254 RGBA pine spray generated next, after the plaster was integrated. Source: `exec-ded33c32-2345-4c3a-876b-e4d9deb79812.png`. Its alpha range was verified as 0–255. Used on oriented cards distributed around the modeled pine branches, with alpha testing.

`terracotta-albedo.png` was generated subsequently for the individually modeled curved roof tiles and ridge caps. Source: `exec-0aae32fa-9fa0-412d-a51b-e26c7590570c.png`. This is a porous fired-clay surface, without roof patterns or baked lighting.

`bougainvillea-spray.png` was generated after the coast review for small flower clusters on the modeled potted and hanging branches. Source: `exec-780deef1-d329-4701-b5b7-325e7f491556.png`. Its 1254×1254 RGBA alpha range was verified as 0–255. It is used on small curved, independently oriented cards with alpha testing.

`bougainvillea-leaves.png` was generated subsequently, after the flower texture had been integrated and its surrounding angular geometric leaves inspected. Source: `exec-2dd7a8fc-c2d2-4e8d-964c-de3150350598.png` in the same session directory. This independent green twig cutout replaces those geometric leaves on curved oriented cards. Verified RGBA, 1254×1254, alpha 0–255. The modeled woody framework remains separate.

`olive-leaves.png` was generated with the built-in image tool after the broadleaf vegetation review. Source: `exec-eae175fd-ee80-431b-89ed-5af97627193c.png` in the same session directory. The unchanged PNG is RGBA, 1254×1254, alpha 0–255. It supplies narrow grey-green leaves for the separately modeled courtyard olive. Prompt: one isolated olive twig spray on real transparency, about 22 narrow lanceolate leaves with sage upper surfaces and silvery undersides, slender branching stem, neutral diffuse albedo illumination, clear gaps, no fruit, no flowers, no scene or background. No generated normal or roughness maps are claimed. Lemon trees reuse the existing broadleaf twig image with modeled lemons; that reuse is an approximation of leaf species.
