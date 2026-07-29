import * as THREE from 'three/webgpu';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { createScene } from '../../shared/gi/surfel/scene.ts';
import { Layer } from '../../shared/world/index.ts';
import { createTerrain, type Terrain } from '../../entities/terrain/index.ts';
import { createFoliage, type Foliage } from '../../entities/foliage/index.ts';
import { createRocks, type Rocks } from '../../entities/rocks/index.ts';
import { createTrees, type Trees } from '../../entities/trees/index.ts';

export interface LargeScene {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  sun: THREE.DirectionalLight;
  update: (elapsedSeconds: number) => void;
}

export interface LargeSceneContents {
  terrain: Terrain;
  foliage: Foliage;
  rocks: Rocks;
  trees: Trees;
  /** Raster triangles, counting every instance. */
  rasterTriangles: number;
  /** Triangles the current BVH builder would actually merge — one copy per mesh. */
  bvhTriangles: number;
}

const baseUrl = import.meta.env.BASE_URL;

/**
 * Scale knobs, read from the query string here rather than in `app/main.ts`.
 *
 * The composition root is shared with other work in flight, and every knob added there
 * is another line of contention in a file three people are editing. The scene is also
 * the only thing that knows what its own knobs mean. So the sweep parameters live with
 * the scene: `?scene=large&seg=48&trees=12&grass=8000`.
 */
function knobs(): {
  size: number;
  chunks: number;
  segments: number;
  grass: number;
  ferns: number;
  rocks: number;
  trees: number;
  cam: string;
} {
  const params = new URLSearchParams(window.location.search);
  const num = (key: string, fallback: number): number => {
    const raw = params.get(key);
    if (raw === null) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  };
  return {
    size: num('size', 400),
    chunks: num('chunks', 4),
    segments: num('seg', 32),
    grass: num('grass', 4000),
    ferns: num('ferns', 1200),
    rocks: num('rocks', 150),
    trees: num('trees', 6),
    cam: params.get('cam') ?? 'vista',
  };
}

async function loadColorMap(url: string): Promise<THREE.Texture | null> {
  try {
    const texture = await new THREE.TextureLoader().loadAsync(url);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = 8;
    return texture;
  } catch (error) {
    // A missing ground texture must not take the scene down: the measurement this
    // scene exists for is geometric, and a flat-coloured terrain still measures it.
    console.warn(`[largeScene] texture ${url} failed to load:`, error);
    return null;
  }
}

/**
 * The landscape-scale counterpart to the Cornell box.
 *
 * Everything claimed about this GI system so far has been measured on forty triangles
 * inside a ten-metre room. The claims that matter — that the BVH is affordable, that
 * the surfel clipmap covers the world, that a 512 lightmap has usable density, that the
 * diffuse array fits in memory — are all claims about *size*, and none of them can even
 * be evaluated at that size. This scene is four hundred metres across, instanced,
 * alpha-cut and many-material, so those claims become falsifiable.
 *
 * It is not trying to be pretty. It is trying to be the smallest thing that behaves
 * like a forest to every part of the pipeline that cares.
 */
export function createLargeScene(renderer: THREE.WebGPURenderer): LargeScene {
  const { scene, camera, controls, dirLight } = createScene(renderer);

  camera.far = 2000;
  camera.updateProjectionMatrix();
  camera.layers.enable(Layer.Debug);

  return {
    scene,
    camera,
    controls,
    sun: dirLight,
    update: () => {},
  };
}

/** Builds the static contents. Must run before the BVH is built. */
export async function populateLargeScene(
  scene: THREE.Scene,
  sun: THREE.DirectionalLight,
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
): Promise<LargeSceneContents> {
  const cfg = knobs();

  const [groundMap, rockMap] = await Promise.all([
    loadColorMap(`${baseUrl}textures/grass/Grass004_2K-JPG_Color.jpg`),
    loadColorMap(`${baseUrl}textures/rock/Rock030_2K-JPG_Color.jpg`),
  ]);
  // One shared texture object carrying the repeat, so the per-chunk materials differ
  // only in tint. That is the honest arrangement: it is the *material count* the
  // diffuse array charges for, not the texture count, and this makes the distinction
  // visible instead of conflating the two.
  groundMap?.repeat.set(cfg.size / cfg.chunks / 6, cfg.size / cfg.chunks / 6);
  rockMap?.repeat.set(2, 2);

  const terrain = createTerrain({
    size: cfg.size,
    chunks: cfg.chunks,
    segments: cfg.segments,
    map: groundMap,
  });
  scene.add(terrain.object);

  const scatterExtent = cfg.size * 0.42;
  const foliage = createFoliage({
    extent: scatterExtent,
    grassCount: cfg.grass,
    fernCount: cfg.ferns,
    heightAt: terrain.heightAt,
  });
  scene.add(foliage.object);

  const rocks = createRocks({
    extent: scatterExtent,
    count: cfg.rocks,
    map: rockMap,
    heightAt: terrain.heightAt,
  });
  scene.add(rocks.object);

  const trees = createTrees({
    count: cfg.trees,
    extent: cfg.size * 0.25,
    heightAt: terrain.heightAt,
  });
  scene.add(trees.object);

  // The sun arrives from `createScene` aimed at a ten-metre room. A shadow frustum
  // that size over a four-hundred-metre terrain would put everything but the origin
  // in permanent shadow, and the GI would be measured against a lighting bug.
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -cfg.size * 0.35;
  sun.shadow.camera.right = cfg.size * 0.35;
  sun.shadow.camera.top = cfg.size * 0.35;
  sun.shadow.camera.bottom = -cfg.size * 0.35;
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 400;
  sun.shadow.bias = -0.0012;
  sun.shadow.normalBias = 0.05;
  sun.shadow.camera.updateProjectionMatrix();

  placeCamera(cfg.cam, camera, controls, terrain);

  const rasterTriangles =
    terrain.triangleCount +
    foliage.layers.reduce((sum, l) => sum + l.baseTriangles * l.instanceCount, 0) +
    rocks.baseTriangles * rocks.instanceCount +
    trees.triangleCount;

  // What `createSceneBVH` will actually merge today: one copy per Mesh, instance
  // matrices ignored. Recorded next to the raster count so the difference is a datum.
  const bvhTriangles =
    terrain.triangleCount +
    foliage.layers.reduce((sum, l) => sum + l.baseTriangles, 0) +
    rocks.baseTriangles +
    trees.triangleCount;

  console.log(
    `[largeScene] ${cfg.size} m · raster tris ${rasterTriangles} · ` +
      `single-copy tris ${bvhTriangles} · trees ${cfg.trees} · ` +
      `instances ${cfg.grass + cfg.ferns + cfg.rocks}`,
  );

  return { terrain, foliage, rocks, trees, rasterTriangles, bvhTriangles };
}

function placeCamera(
  preset: string,
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
  terrain: Terrain,
): void {
  const ground = (x: number, z: number): number => terrain.heightAt(x, z);

  if (preset === 'closeup') {
    // Eye height in a patch of ground cover: the shot that shows whether instanced
    // foliage is lit at all, and whether it is grounded or floating.
    const eye = new THREE.Vector3(8, ground(8, 16) + 1.6, 16);
    camera.position.copy(eye);
    controls.target.set(0, ground(0, 0) + 0.9, 0);
  } else if (preset === 'ground') {
    const eye = new THREE.Vector3(0, ground(0, 40) + 1.7, 40);
    camera.position.copy(eye);
    controls.target.set(0, ground(0, 0) + 1.2, 0);
  } else {
    // Vista: high enough to see the terrain silhouette and the tree line, low enough
    // that the foliage still resolves.
    const eye = new THREE.Vector3(72, ground(72, 132) + 26, 132);
    camera.position.copy(eye);
    controls.target.set(0, ground(0, 0) + 6, 0);
  }
  controls.update();
  camera.updateMatrixWorld();
}
