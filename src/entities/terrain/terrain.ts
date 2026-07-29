import * as THREE from 'three/webgpu';
import { createNoise2D } from 'simplex-noise';

import { Layer, Mobility, applyMobility } from '../../shared/world/index.ts';

export interface TerrainOptions {
  /** Edge length of the whole heightfield, in metres. */
  size?: number;
  /** Chunks per side. Each chunk is one draw call and one material. */
  chunks?: number;
  /** Quads per chunk edge. Total triangles = chunks² · segments² · 2. */
  segments?: number;
  /** Peak-to-trough relief in metres. */
  amplitude?: number;
  seed?: number;
  /** Colour texture; shared across every chunk, tiled by `uv` repeat. */
  map?: THREE.Texture | null;
}

export interface Terrain {
  object: THREE.Group;
  /** Edge length in metres — foliage scatters inside ±size/2. */
  size: number;
  /** World-space ground height under (x, z). The only thing other slices need. */
  heightAt: (x: number, z: number) => number;
  triangleCount: number;
  materials: THREE.Material[];
}

/**
 * Deterministic PRNG, because a scale measurement that scatters different foliage on
 * every reload cannot be compared with the previous run.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A chunked heightfield, sized in hundreds of metres rather than the Cornell box's ten.
 *
 * Chunked rather than one mesh on purpose. The GI code under measurement keys several
 * of its costs off *per-mesh* and *per-material* counts — the diffuse array allocates a
 * full layer per unique material, the lightmap unwrapper allocates atlas cells per mesh
 * — and a single-mesh terrain would hide both behind a count of one. Real terrain is
 * componentised for exactly the same reason UE componentises Landscape: streaming and
 * per-component material instances. So this is representative, not a stress rig.
 */
export function createTerrain(options: TerrainOptions = {}): Terrain {
  const {
    size = 400,
    chunks = 4,
    segments = 32,
    amplitude = 26,
    seed = 1337,
    map = null,
  } = options;

  const random = mulberry32(seed);
  const noise = createNoise2D(random);

  // Four octaves plus a ridge term: enough relief that shadows and GI have something
  // to occlude, without a shape so wild that foliage placement needs slope rejection.
  const heightAt = (x: number, z: number): number => {
    let h = 0;
    let amp = 1;
    let freq = 1 / 260;
    let norm = 0;
    for (let octave = 0; octave < 4; octave++) {
      h += noise(x * freq, z * freq) * amp;
      norm += amp;
      amp *= 0.48;
      freq *= 2.13;
    }
    h /= norm;
    const ridge = 1 - Math.abs(noise(x / 520 + 11.3, z / 520 - 7.1));
    return (h * 0.72 + (ridge - 0.5) * 0.56) * amplitude;
  };

  const group = new THREE.Group();
  group.name = 'terrain';

  const chunkSize = size / chunks;
  const materials: THREE.Material[] = [];
  let triangleCount = 0;

  for (let cz = 0; cz < chunks; cz++) {
    for (let cx = 0; cx < chunks; cx++) {
      const originX = -size / 2 + (cx + 0.5) * chunkSize;
      const originZ = -size / 2 + (cz + 0.5) * chunkSize;

      const geometry = new THREE.PlaneGeometry(
        chunkSize,
        chunkSize,
        segments,
        segments,
      );
      geometry.rotateX(-Math.PI / 2);

      const position = geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < position.count; i++) {
        const localX = position.getX(i);
        const localZ = position.getZ(i);
        position.setY(i, heightAt(originX + localX, originZ + localZ));
      }
      position.needsUpdate = true;
      geometry.computeVertexNormals();
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();

      // uv stays 0..1 across the chunk and the *texture* carries the repeat. The
      // lightmap unwrapper reads `uv` and assumes it is per-face 0..1; baking the
      // tiling into the attribute instead would push every chart out of its cell and
      // the resulting atlas density would be unmeasurable rather than merely wrong.
      const material = new THREE.MeshStandardNodeMaterial({
        color: new THREE.Color().setHSL(
          0.24 + (random() - 0.5) * 0.04,
          0.34 + random() * 0.1,
          0.3 + random() * 0.06,
        ),
        roughness: 0.95,
        metalness: 0,
      });
      if (map) material.map = map;
      material.name = `terrain_${cx}_${cz}`;
      materials.push(material);

      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(originX, 0, originZ);
      mesh.name = `terrain_chunk_${cx}_${cz}`;
      group.add(mesh);

      triangleCount += segments * segments * 2;
    }
  }

  applyMobility(group, Mobility.Static);
  // The heightfield receives shadow and GI but is never a caster worth its own pass
  // cost at this scale; it stays on the static caster layer regardless, because the
  // relief self-shadows and that is most of the terrain read.
  group.traverse((object) => object.layers.enable(Layer.GiStatic));

  return { object: group, size, heightAt, triangleCount, materials };
}
