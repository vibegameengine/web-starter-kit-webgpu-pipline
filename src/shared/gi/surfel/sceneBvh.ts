// @ts-nocheck -- vendored from jure/webgiya; kept byte-compatible so upstream fixes can be re-applied.
// sceneBvh.ts
import * as THREE from 'three/webgpu';
import { MeshBVH, SAH } from '../bvh/index.js';
// import { MeshBVH, SAH } from 'three-mesh-bvh';

import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { storage } from 'three/tsl';
import { buildDiffuseArrayTexture, DIFFUSE_LAYER_MAX } from './diffuseArray';
import { U_GI_EMISSIVE_BASE, U_GI_EMISSIVE_SCALE } from './sceneLights';
import { giKnobs } from './knobs';
import { Mobility } from '../../world/index.ts';

export type SceneBVHBundle = {
  // TSL Storage Nodes
  bvhNode: THREE.StorageBufferNode;
  positionNode: THREE.StorageBufferNode;
  normalNode: THREE.StorageBufferNode;
  indexNode: THREE.StorageBufferNode;
  colorNode: THREE.StorageBufferNode;
  diffuseArrayTex: THREE.Texture;
  /**
   * LOCAL ADDITION vs upstream: the dynamic BVH is a second, separately bound
   * acceleration structure over the same world, and its hits are shaded by the same
   * `sampleDiffuseArray` call. Handing the id map out is what keeps a single material
   * table shared between the two, rather than two tables whose ids silently disagree.
   */
  materialIdByUUID: Map<string, number>;
  /** Where emission lives in the diffuse array, or -1. See diffuseArray.ts. */
  emissiveBase: number;
  /** Radiance a full-white emissive texel stands for. */
  emissiveScale: number;
  /** What went in, so a harness does not have to reach through `private` to find out. */
  stats: SceneBVHStats;
  //   update: (scene: THREE.Scene) => void;
};

export type SceneBVHStats = {
  /** Triangles in the merged structure, proxies included. */
  triangles: number;
  /** Triangles that would have been in it at full detail. */
  fullDetailTriangles: number;
  /** Full-detail triangles replaced by cluster proxy boxes. */
  proxiedTriangles: number;
  /** Triangles the tracer does not have at all. Should be 0. */
  droppedTriangles: number;
  proxyBoxes: number;
  buildMs: number;
};

/**
 * Triangles a single BVH is allowed to hold.
 *
 * There is a hard reason for a number here rather than "as many as fit": the buffers
 * below are non-indexed, so one triangle costs three vertices × (position, normal,
 * colour) = 108 bytes, plus its share of the node array. Half a million triangles is
 * already ~86 MB of GPU storage. Past that a forest of instanced grass does not get
 * slow, it fails to allocate — and the failure mode we refuse to have is a tracer
 * that quietly holds a fraction of the world it claims to represent.
 */
export const BVH_TRIANGLE_BUDGET = 500_000;

/**
 * One drawable copy of one geometry: the object-space template plus the world matrix
 * that places it. Instances of an InstancedMesh differ only in the matrix, which is
 * what lets the dynamic BVH re-bake a mover without re-deriving its attributes.
 */
export type GatheredGeometry = {
  /** Object space, non-indexed, sequential index, position/normal/colour only. */
  template: THREE.BufferGeometry;
  /** World matrix for this copy: `matrixWorld` composed with `instanceMatrix`. */
  matrix: THREE.Matrix4;
  source: THREE.Mesh;
  /** -1 for a plain Mesh, otherwise the InstancedMesh row this copy came from. */
  instance: number;
};

export type GatherOptions = {
  materialIdByUUID: Map<string, number>;
  /** Which meshes belong in this BVH. */
  include: (mesh: THREE.Mesh) => boolean;
  /** Names the BVH in log output, so a dropped mesh says which one it fell out of. */
  label: string;
  triangleBudget?: number;
  /**
   * Centre of the full-detail region. Copies further than `farRadius` from it are
   * clustered into proxy boxes instead of contributing their triangles.
   */
  focus?: THREE.Vector3;
  /** 0 disables the far tier entirely, which is the default and the old behaviour. */
  farRadius?: number;
};

/**
 * How coarse a far cluster cell is, as a fraction of its distance from the focus.
 *
 * This is the one number that decides whether the far tier is O(world) or not. A fixed
 * cell size would give cell count proportional to world *area*, which is the same
 * failure in different clothing. Sizing the cell proportionally to distance means each
 * distance-doubling shell holds roughly the same number of cells — the clipmap
 * property, and the reason Lumen's global SDF costs the same in a courtyard and a
 * continent. 0.08 puts an 8 m cell at 100 m and a 32 m cell at 400 m.
 */
const FAR_CELL_RATIO = 0.08;

/** A world-space axis-aligned box carrying one material id, in template layout. */
function proxyBoxGeometry(box: THREE.Box3, matId: number): THREE.BufferGeometry {
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const geom = new THREE.BoxGeometry(
    Math.max(size.x, 1e-3),
    Math.max(size.y, 1e-3),
    Math.max(size.z, 1e-3),
  )
    .toNonIndexed()
    .translate(centre.x, centre.y, centre.z);

  const count = geom.getAttribute('position').count;
  const idx: number[] = [];
  for (let i = 0; i < count; i++) idx.push(i);
  geom.setIndex(idx);

  // The tracer reads uv from `color.xy` and the material id from `color.z`. A proxy has
  // no meaningful uv — it is standing in for a cloud of scattered instances, not for a
  // surface — so it points at the middle of the layer and lets the mip selection in the
  // integrator do the averaging that a proxy hit deserves anyway.
  const packed = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    packed[i * 3 + 0] = 0.5;
    packed[i * 3 + 1] = 0.5;
    packed[i * 3 + 2] = matId;
  }
  geom.setAttribute('color', new THREE.BufferAttribute(packed, 3));

  for (const name of Object.keys(geom.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'color') {
      geom.deleteAttribute(name);
    }
  }
  geom.clearGroups();
  return geom;
}

/** Object-space template for one mesh: everything the tracer reads, nothing else. */
function buildTemplate(
  mesh: THREE.Mesh,
  materialIdByUUID: Map<string, number>,
): THREE.BufferGeometry | null {
  // IMPORTANT: make triangles independent so matId can be constant per-triangle
  let geom = mesh.geometry.index
    ? mesh.geometry.toNonIndexed()
    : mesh.geometry.clone();

  const posAttr = geom.getAttribute('position') as
    | THREE.BufferAttribute
    | undefined;
  if (!posAttr) return null;

  const vertexCount = posAttr.count;

  // Ensure sequential index
  if (!geom.index) {
    const idx = [];
    for (let i = 0; i < vertexCount; i++) {
      idx.push(i);
    }
    geom.setIndex(idx);
  }

  if (!geom.getAttribute('normal')) geom.computeVertexNormals();

  // Ensure uv exists (fallback 0,0)
  if (!geom.getAttribute('uv')) {
    geom.setAttribute(
      'uv',
      new THREE.BufferAttribute(new Float32Array(vertexCount * 2), 2),
    );
  }
  const uvAttr = geom.getAttribute('uv') as THREE.BufferAttribute;

  // --- NEW: compute matId per vertex (constant within each triangle) ---
  const matIdArray = new Float32Array(vertexCount);
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];

  if (geom.groups && geom.groups.length > 0 && mats.length > 1) {
    // multi-material geometry
    for (const g of geom.groups) {
      const m = mats[g.materialIndex] ?? mats[0];
      const id = materialIdByUUID.get(m.uuid) ?? 0;
      // after our non-indexed + sequential index, start/count map 1:1 to vertices
      matIdArray.fill(id, g.start, g.start + g.count);
    }
  } else {
    // single material
    const m = mats[0];
    const id = materialIdByUUID.get(m.uuid) ?? 0;
    matIdArray.fill(id);
  }

  const packed = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    packed[i * 3 + 0] = uvAttr.getX(i);
    packed[i * 3 + 1] = uvAttr.getY(i);
    packed[i * 3 + 2] = matIdArray[i]; // integer stored as float (safe for < 16M)
  }
  geom.setAttribute('color', new THREE.BufferAttribute(packed, 3));
  // -----------------------------------------------------

  // LOCAL ADDITION vs upstream: mergeGeometries requires an identical attribute
  // set on every input. Once uv/matId are packed into `color`, nothing else is
  // read by the tracer — and dropping the rest is what keeps the merge from
  // failing the moment the lightmap unwrapper has given uv1 to some meshes and
  // not others.
  for (const name of Object.keys(geom.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'color') {
      geom.deleteAttribute(name);
    }
  }
  geom.clearGroups();

  return geom;
}

/**
 * Walks the scene and returns one entry per drawable copy.
 *
 * LOCAL CHANGE vs upstream: upstream emitted exactly one copy per `THREE.Mesh` and
 * baked `matrixWorld` into it. `InstancedMesh extends Mesh`, so a thousand instances
 * of a grass blade passed that test and came out as a single blade sitting at the
 * InstancedMesh's own origin — geometry the tracer can see that nothing on screen
 * matches, and the other 999 blades invisible to every ray. `instanceMatrix` was read
 * nowhere in the build. This expands them.
 *
 * The budget is enforced per mesh and a mesh that does not fit is dropped whole and
 * logged as an error. Truncating an instance list halfway would give a BVH that is
 * *almost* the scene, which is the one failure that cannot be spotted in a screenshot.
 */
export function gatherBvhGeometries(
  scene: THREE.Object3D,
  options: GatherOptions,
): {
  entries: GatheredGeometry[];
  triangles: number;
  fullDetailTriangles: number;
  proxiedTriangles: number;
  droppedTriangles: number;
  proxyBoxes: number;
} {
  const { materialIdByUUID, include, label } = options;
  const budgetOverride = giKnobs.bvhBudget();
  const budget =
    options.triangleBudget ??
    (budgetOverride > 0 ? budgetOverride : BVH_TRIANGLE_BUDGET);
  const expandInstances = giKnobs.bvhInstances();
  const farRadius = Math.max(0, options.farRadius ?? 0);
  const focus = options.focus ?? new THREE.Vector3();

  const entries: GatheredGeometry[] = [];
  const templates = new Map<string, THREE.BufferGeometry | null>();
  let triangles = 0;
  let fullDetailTriangles = 0;
  let proxiedTriangles = 0;
  let droppedTriangles = 0;
  let droppedMeshes = 0;

  /**
   * Far clusters, accumulated as world bounds and only turned into geometry at the end.
   * Keyed by material and by a cell whose size grows with distance, so what comes out is
   * one box per (material, cell) rather than one per instance.
   */
  const clusters = new Map<string, { box: THREE.Box3; matId: number; copies: number }>();
  const copyBox = new THREE.Box3();
  const copyCentre = new THREE.Vector3();

  const addToCluster = (
    template: THREE.BufferGeometry,
    matrix: THREE.Matrix4,
    distance: number,
  ) => {
    if (!template.boundingBox) template.computeBoundingBox();
    copyBox.copy(template.boundingBox!).applyMatrix4(matrix);
    copyBox.getCenter(copyCentre);

    const colour = template.getAttribute('color');
    const matId = colour ? Math.round(colour.getZ(0)) : 0;

    const cell = Math.max(1e-3, distance * FAR_CELL_RATIO);
    const key =
      `${matId}|${Math.floor(copyCentre.x / cell)},` +
      `${Math.floor(copyCentre.y / cell)},${Math.floor(copyCentre.z / cell)}`;

    const existing = clusters.get(key);
    if (existing) {
      existing.box.union(copyBox);
      existing.copies++;
    } else {
      clusters.set(key, { box: copyBox.clone(), matId, copies: 1 });
    }
  };

  scene.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh) || !obj.visible) return;
    const mesh = obj as THREE.Mesh;
    if (!include(mesh)) return;

    const instanced = mesh as THREE.InstancedMesh;
    const isInstancedMesh =
      (instanced as { isInstancedMesh?: boolean }).isInstancedMesh === true;
    // `?bvhInstances=0` reproduces the pre-fix builder exactly: one copy per Mesh,
    // placed by the object's own world matrix, with `instanceMatrix` never read. It
    // exists so the cost of that bug can be photographed rather than derived.
    const isInstanced = isInstancedMesh && expandInstances;
    const copies = isInstanced ? Math.max(0, instanced.count) : 1;
    if (copies === 0) return;

    // Templates are keyed by geometry+material, not by object: instancing exists so a
    // forest shares one blade, and re-deriving it per InstancedMesh would undo that.
    const key = `${mesh.geometry.uuid}|${
      Array.isArray(mesh.material)
        ? mesh.material.map((m) => m.uuid).join(',')
        : mesh.material.uuid
    }`;
    let template = templates.get(key);
    if (template === undefined) {
      template = buildTemplate(mesh, materialIdByUUID);
      templates.set(key, template);
    }
    if (!template) return;

    const triPerCopy = template.index!.count / 3;
    if (!template.boundingBox) template.computeBoundingBox();
    fullDetailTriangles += triPerCopy * copies;

    // Per copy, not per mesh. The old test was per mesh and its verdict was binary —
    // the whole thing fitted or the whole thing vanished — which is how six entire
    // trees left the tracer at once and frame time went *down*.
    let meshProxied = 0;
    for (let i = 0; i < copies; i++) {
      const matrix = new THREE.Matrix4();
      if (isInstanced) {
        instanced.getMatrixAt(i, matrix);
        matrix.premultiply(mesh.matrixWorld);
      } else {
        matrix.copy(mesh.matrixWorld);
      }

      let demote = false;
      if (farRadius > 0) {
        copyBox.copy(template.boundingBox!).applyMatrix4(matrix);
        copyBox.getCenter(copyCentre);
        const distance = copyCentre.distanceTo(focus);
        if (distance > farRadius) {
          addToCluster(template, matrix, distance);
          demote = true;
        }
      }

      // Budget exhaustion is now a demotion, not a deletion. A proxy box is a bad
      // representation of a tree; it is a far better one than nothing, and — the point —
      // it is a *visible* one. Silence was the actual defect: the tracer got cheaper by
      // holding less of the world and no graph in the project could show it.
      if (!demote && triangles + triPerCopy > budget) {
        copyBox.copy(template.boundingBox!).applyMatrix4(matrix);
        copyBox.getCenter(copyCentre);
        addToCluster(template, matrix, Math.max(1, copyCentre.distanceTo(focus)));
        demote = true;
      }

      if (demote) {
        proxiedTriangles += triPerCopy;
        meshProxied++;
        continue;
      }

      entries.push({ template, matrix, source: mesh, instance: isInstanced ? i : -1 });
      triangles += triPerCopy;
    }

    if (meshProxied > 0 && meshProxied === copies) droppedMeshes++;
  });

  // Emit one box per cluster. Identity matrices: the bounds are already world-space,
  // which is also why proxies cost nothing to re-derive if the focus ever moves.
  let proxyBoxes = 0;
  for (const cluster of clusters.values()) {
    const geom = proxyBoxGeometry(cluster.box, cluster.matId);
    entries.push({
      template: geom,
      matrix: new THREE.Matrix4(),
      source: null as unknown as THREE.Mesh,
      instance: -1,
    });
    triangles += geom.index!.count / 3;
    proxyBoxes++;
  }

  if (proxiedTriangles > 0) {
    console.warn(
      `[BVH:${label}] ${proxiedTriangles} triangles across ${droppedMeshes} fully-demoted ` +
        `mesh(es) were replaced by ${proxyBoxes} cluster proxy boxes ` +
        `(${(proxyBoxes * 12)} triangles, ${(
          (proxyBoxes * 12) / Math.max(1, proxiedTriangles) * 100
        ).toFixed(2)} % of what they stand in for). Those surfaces still occlude and ` +
        'still bleed colour, but at box resolution and with one flat albedo each.',
    );
  }

  return {
    entries,
    triangles,
    fullDetailTriangles,
    proxiedTriangles,
    droppedTriangles,
    proxyBoxes,
  };
}

export function createSceneBVH(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
): SceneBVHBundle {
  scene.updateMatrixWorld(true);

  // Over the whole scene, movers included: the dynamic BVH shades its hits through
  // this same array, so a mover's material has to have an id in it.
  const capOverride = giKnobs.diffuseLayerCap();
  const diffuse = buildDiffuseArrayTexture(
    renderer,
    scene,
    capOverride > 0 ? capOverride : DIFFUSE_LAYER_MAX,
  );
  const { diffuseArrayTex, materialIdByUUID } = diffuse;

  // Published to the tracers as uniforms rather than threaded through five call sites.
  // There is exactly one diffuse array per run and every pass that shades a ray hit
  // reads the same two numbers out of it; a second copy of them is a second thing that
  // can be stale, and a stale emissive base points a sample at an albedo layer.
  // `?emissive=0` leaves the layers baked and stops the tracer reading them, so the
  // emissive panel still glows on screen and stops throwing indirect light. Any other
  // ablation (removing the material, zeroing its emission) would change the raster too
  // and measure two things at once.
  U_GI_EMISSIVE_BASE.value = giKnobs.emissiveLights() ? diffuse.emissiveBase : -1;
  U_GI_EMISSIVE_SCALE.value = diffuse.emissiveScale;

  // LOCAL CHANGE vs upstream: `Mobility.Movable` geometry is excluded here and goes
  // into the dynamic BVH instead (see dynamicBvh.ts). Upstream had one structure and
  // simply never traced anything that moved; keeping movers out of *this* one is what
  // lets it stay built once, which is the whole reason for the split.
  // The full-detail region is centred on the static scene, not on the camera. That is
  // the honest limit of this tier: Lumen's clipmap is camera-centred and re-composited
  // as the camera moves, and re-centring here would mean re-merging and re-building the
  // whole structure — 600 ms on this scene — which is not something that can happen
  // while anyone is walking. What it does buy is that the far half of a world stops
  // costing triangles proportional to its area. Off unless `?bvhFar=` asks for it.
  const bounds = new THREE.Box3().setFromObject(scene);
  const focus = bounds.isEmpty()
    ? new THREE.Vector3()
    : bounds.getCenter(new THREE.Vector3());

  const gathered = gatherBvhGeometries(scene, {
    materialIdByUUID,
    label: 'static',
    include: (mesh) => mesh.userData.mobility !== Mobility.Movable,
    focus,
    farRadius: giKnobs.bvhFarRadius(),
  });
  const entries = gathered.entries;

  if (entries.length === 0) {
    throw new Error('createSceneBVH: no geometries found');
  }

  const geometries = entries.map((entry) =>
    entry.template.clone().applyMatrix4(entry.matrix),
  );

  const merged = BufferGeometryUtils.mergeGeometries(geometries);

  // Build BVH
  console.time('BVH Build');
  const buildStart = performance.now();
  const bvh = new MeshBVH(merged, { maxLeafTris: 1, strategy: SAH });
  const buildMs = performance.now() - buildStart;
  console.timeEnd('BVH Build');

  // Upload to GPU Buffers
  const roots = bvh._roots; // Access internal array buffer of nodes
  const rootBuffer = roots[0]; // Assuming 1 root for now

  // Stable attribute references (we resize array content, keep object ref)
  const bvhAttr = new THREE.StorageBufferAttribute(
    new Float32Array(bvh._roots[0]),
    8,
  ); // BVHNode is 8 floats
  const posAttr = new THREE.StorageBufferAttribute(
    merged.attributes.position.array,
    3,
  );
  const norAttr = new THREE.StorageBufferAttribute(
    merged.attributes.normal.array,
    3,
  );
  const idxAttr = new THREE.StorageBufferAttribute(merged.index?.array, 3); // uvec3
  const colAttr = new THREE.StorageBufferAttribute(
    merged.attributes.color.array,
    3,
  );

  // TSL Nodes
  const bvhNode = storage(bvhAttr, 'BVHNode', 0).toReadOnly().setName('bvh');
  const positionNode = storage(posAttr, 'vec3', 0)
    .toReadOnly()
    .setName('bvh_position');
  const normalNode = storage(norAttr, 'vec3', 0).toReadOnly();
  const indexNode = storage(idxAttr, 'uvec3', 0)
    .toReadOnly()
    .setName('bvh_index');
  const colorNode = storage(colAttr, 'vec3', 0)
    .toReadOnly()
    .setName('bvh_attribute');

  // 1. BVH Nodes
  if (bvhAttr.count * 8 < rootBuffer.length) {
    // Resize if needed (naive)
    bvhAttr.array = new Float32Array(rootBuffer);
    // @ts-ignore
    bvhAttr.count = rootBuffer.length / 8;
  } else {
    (bvhAttr.array as Float32Array).set(rootBuffer);
  }
  bvhAttr.needsUpdate = true;

  const resizeAndUpload = (
    attr: THREE.StorageBufferAttribute,
    data: ArrayLike<number>,
    itemSize: number,
  ) => {
    if (attr.array.length < data.length) {
      attr.array =
        data instanceof Float32Array
          ? new Float32Array(data)
          : new Uint32Array(data);
      // @ts-ignore
      attr.count = data.length / itemSize;
    } else {
      (attr.array as any).set(data);
    }
    attr.needsUpdate = true;
  };

  // 2. Geometry Attributes
  const positions = merged.getAttribute('position').array as Float32Array;
  const normals = merged.getAttribute('normal').array as Float32Array;
  const indices = merged.index!.array as Uint32Array;
  const colors = merged.getAttribute('color').array as Float32Array;

  console.log('[BVH] triCount:', merged.index!.count / 3);
  console.log('[BVH] positionCount:', merged.getAttribute('position').count);
  console.log('[BVH] bounds:', bvh.geometry.boundingBox);

  resizeAndUpload(posAttr, positions, 3);
  resizeAndUpload(norAttr, normals, 3);
  resizeAndUpload(colAttr, colors, 3); // <--- NEW
  resizeAndUpload(idxAttr, indices, 3);

  // Update TSL node counts
  // @ts-ignore
  bvhNode.count = bvhAttr.count;
  // @ts-ignore
  positionNode.count = posAttr.count;
  // @ts-ignore
  normalNode.count = norAttr.count;
  // @ts-ignore
  colorNode.count = colAttr.count;
  // @ts-ignore
  indexNode.count = idxAttr.count;

  // Initial empty
  return {
    bvhNode,
    positionNode,
    normalNode,
    indexNode,
    colorNode,
    diffuseArrayTex,
    materialIdByUUID,
    emissiveBase: diffuse.emissiveBase,
    emissiveScale: diffuse.emissiveScale,
    stats: {
      triangles: merged.index!.count / 3,
      fullDetailTriangles: gathered.fullDetailTriangles,
      proxiedTriangles: gathered.proxiedTriangles,
      droppedTriangles: gathered.droppedTriangles,
      proxyBoxes: gathered.proxyBoxes,
      buildMs,
    },
  };
}
