// @ts-nocheck -- TSL structured storage follows the surrounding Webgiya passes.
import * as THREE from 'three/webgpu';
import { Fn, storage, struct, uniform, int, float, vec4, vec3, vec2, If,
  instanceIndex, texture, Loop, transpose, atomicAdd } from 'three/tsl';
import { Mobility } from '../../world/index';
import { SurfelStruct, SurfelMoments, type SurfelPool } from './surfelPool';
import { SURFEL_TTL, SURFEL_DEPTH_TEXELS, SLG_TOTAL_FLOATS, SURFEL_LIFE_RECYCLED } from './constants';
import { surfel_radius_for_pos } from './surfelHashGrid';
import { bindSurfelAnchors } from './surfelAnchors';

const ObjectTransform = struct({ current: 'mat4', inverse: 'mat4', normal: 'mat4', previous: 'mat4' });

/** Query the previous grid at the previous position of this receiver. */
export function previousReceiverPosition(worldPos, owner, objects) {
  const objectIndex = int(owner).toVar();
  const object = objects.element(objectIndex);
  return object.get('previous').mul(object.get('inverse').mul(vec4(worldPos, 1))).xyz;
}

/** Rigid mesh anchors. Skinned, instanced and vertex-deformed meshes keep the unbound path. */
export function createSurfelMotion(scene: THREE.Scene, previous: any = null) {
  const meshes: THREE.Mesh[] = [];
  scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh) mesh.userData.giRigidReceiver = 0;
    if (!mesh.isMesh || !mesh.visible || mesh.userData.giExclude === true || mesh.userData.mobility !== Mobility.Movable) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (mesh.isSkinnedMesh || mesh.isInstancedMesh || mesh.geometry.morphAttributes.position?.length ||
        materials.some(material => material.positionNode)) return;
    meshes.push(mesh);
  });
  // Normal attachment is FP16: integer receiver ids through 1024 are exact.
  if (meshes.length > 1024) throw new Error('Rigid GI receiver limit exceeded');
  // Keep surviving receiver slots stable. Besides avoiding unnecessary remapping,
  // this preserves the owner encoded in cached draws of stationary meshes.
  // Removed slots are reused, so repeated spawn/despawn does not exhaust ids.
  const previousIds = new Map(previous?.meshes.map((mesh, i) => [mesh, i]) ?? []);
  const receiverIds = meshes.map(mesh => previousIds.has(mesh) ? previous.receiverIds[previousIds.get(mesh)] : 0);
  const occupied = new Set(receiverIds);
  let freeId = 1;
  receiverIds.forEach((id, i) => {
    if (id) return;
    while (occupied.has(freeId)) freeId++;
    receiverIds[i] = freeId; occupied.add(freeId);
  });
  const objectCount = Math.max(0, ...receiverIds) + 1;
  const meshById = new Map(meshes.map((mesh, i) => [receiverIds[i], mesh]));
  const transforms = new THREE.StorageBufferAttribute(new Float32Array(objectCount * 64), 16);
  const objects = storage(transforms, ObjectTransform, objectCount).toReadOnly();
  const oldMatrices = meshes.map(() => new THREE.Matrix4());
  const poseWritten = meshes.map(() => false);
  const previousNeedsSettle = meshes.map(() => false);
  const geometrySignatures = meshes.map(mesh => `${mesh.geometry.uuid}:${mesh.geometry.getAttribute('position').version}:${mesh.geometry.getAttribute('normal')?.version}:${mesh.geometry.index?.version}`);
  const identity = new THREE.Matrix4(), inverse = new THREE.Matrix4(), normalMatrix = new THREE.Matrix4();
  for (let i = 0; i < objectCount * 4; i++) identity.toArray(transforms.array, i * 16);
  meshes.forEach((mesh, i) => {
    mesh.updateWorldMatrix(true, false);
    oldMatrices[i].copy(previousIds.has(mesh) ? previous.oldMatrices[previousIds.get(mesh)] : mesh.matrixWorld);
  });
  let initialized = previous !== null;
  let active = false;
  let generation = -1, moveNode = null, captureNode = null;
  let anchorAttribute = null;
  let captureTexture = null;
  const frame = uniform(0), readOffset = uniform(0), writeOffset = uniform(0);
  const cameraPos = uniform(new THREE.Vector3()), viewProjection = uniform(new THREE.Matrix4());
  const tempVP = new THREE.Matrix4();

  function prepare(renderer, pool: SurfelPool, camera, enabled: boolean) {
    const wasActive = active;
    active = enabled && meshes.length > 0 && pool.getAnchorStart() < pool.getCapacity();
    let needsMove = active && !wasActive;
    let transformsChanged = false;
    // Creation uploads the entire CPU array. Ranges queued before that upload
    // survive in Three r182 and would resend every receiver on its first move.
    const uploaded = renderer.backend.has(transforms) && renderer.backend.get(transforms).buffer;
    meshes.forEach((mesh, index) => {
      const id = receiverIds[index];
      mesh.userData.giRigidReceiver = active ? id : 0;
      mesh.updateWorldMatrix(true, false);
      if (!initialized) oldMatrices[index].copy(mesh.matrixWorld);
      const base = id * 64;
      const moved = !oldMatrices[index].equals(mesh.matrixWorld);
      if (!poseWritten[index] || moved) {
        mesh.matrixWorld.toArray(transforms.array, base);
        inverse.copy(mesh.matrixWorld).invert().toArray(transforms.array, base + 16);
        normalMatrix.copy(inverse).transpose().toArray(transforms.array, base + 32);
        oldMatrices[index].toArray(transforms.array, base + 48);
        if (uploaded) transforms.addUpdateRange(base, 64);
        transformsChanged = true;
        poseWritten[index] = true;
      } else if (previousNeedsSettle[index]) {
        // The frame after a stop must query the grid at the current pose.
        // Only this fourth matrix changes; other receivers keep their records.
        mesh.matrixWorld.toArray(transforms.array, base + 48);
        if (uploaded) transforms.addUpdateRange(base + 48, 16);
        transformsChanged = true;
      }
      previousNeedsSettle[index] = moved;
      if (moved) { oldMatrices[index].copy(mesh.matrixWorld); needsMove = true; }
    });
    initialized = true;
    if (transformsChanged) transforms.needsUpdate = true;
    if (!active) return;
    if (pool.getGeneration() !== generation || anchorAttribute !== pool.getAnchorAttr()) {
      moveNode?.dispose(); captureNode?.dispose();
      generation = pool.getGeneration(); anchorAttribute = pool.getAnchorAttr();
      moveNode = null; captureNode = null;
      needsMove = true;
    }
    frame.value = renderer.info.frame;
    const offsets = pool.getOffsets();
    readOffset.value = offsets.readOffset; writeOffset.value = offsets.writeOffset;
    cameraPos.value.copy(camera.position);
    if (!needsMove) return;
    const capacity = pool.getCapacity();
    if (!moveNode) {
      const surfels = storage(pool.getSurfelAttr(), SurfelStruct, capacity);
      const anchors = bindSurfelAnchors(pool);
      const moments = storage(pool.getMomentsAttr(), SurfelMoments, capacity * 2);
      const depth = storage(pool.getSurfelDepthAttr(), 'vec4', pool.getSurfelDepthAttr().count);
      const guides = storage(pool.getGuidingAttr(), 'float', pool.getGuidingAttr().count);
      moveNode = Fn(() => {
        const sid = int(instanceIndex).add(anchors.start).toVar(), s = surfels.element(sid);
        const p = anchors.position(sid), n = anchors.normal(sid);
        const valid = sid.lessThan(capacity).and(s.get('age').greaterThanEqual(0)).and(s.get('age').lessThan(SURFEL_TTL))
          .and(p.w.greaterThan(0)).and(n.w.equal(s.get('posb').w));
        If(valid, () => {
          const objectIndex = int(p.w).toVar();
          const object = objects.element(objectIndex);
          const position = object.get('current').mul(vec4(p.xyz, 1)).xyz;
          const normal = object.get('normal').mul(vec4(n.xyz, 0)).xyz.normalize();
          const distance = position.sub(s.get('posb').xyz).length();
          const normalChange = normal.dot(s.get('normal'));
          If(distance.greaterThan(1e-6).or(normalChange.lessThan(0.999999)), () => {
            const radius = surfel_radius_for_pos(position, cameraPos);
            // Visibility moments are tied to the world around the previous point.
            Loop(int(SURFEL_DEPTH_TEXELS * SURFEL_DEPTH_TEXELS), ({ i }) => {
              depth.element(sid.mul(SURFEL_DEPTH_TEXELS * SURFEL_DEPTH_TEXELS).add(i)).assign(vec4(0));
            });
            // Smooth rigid motion retains irradiance history. Teleports/large turns
            // invalidate it and its proposal distribution, without touching statics.
            If(distance.greaterThan(radius.mul(0.5)).or(normalChange.lessThan(0.866)), () => {
              for (const offset of [readOffset, writeOffset]) {
                const m = moments.element(sid.add(int(offset)));
                m.get('irradiance').assign(vec4(0));
                m.get('msmeData0').assign(vec4(0, 0, 0, 1));
                m.get('msmeData1').assign(vec4(1));
              }
              Loop(int(SLG_TOTAL_FLOATS), ({ i }) => { guides.element(sid.mul(SLG_TOTAL_FLOATS).add(i)).assign(0); });
            });
            s.get('posb').xyz.assign(position);
            s.get('normal').assign(normal);
          });
        });
      })().compute(anchors.count).setName('Move Rigid Surfel Anchors');
    }
    renderer.compute(moveNode);
  }

  function capture(renderer, pool: SurfelPool, camera, gbuffer) {
    if (!active) return;
    const normalTexture = gbuffer.target.textures[0];
    if (normalTexture !== captureTexture) { captureNode = null; captureTexture = normalTexture; }
    tempVP.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    viewProjection.value.copy(tempVP);
    const capacity = pool.getCapacity();
    if (!captureNode) {
      const surfels = storage(pool.getSurfelAttr(), SurfelStruct, capacity).toReadOnly();
      const anchors = bindSurfelAnchors(pool, false);
      captureNode = Fn(() => {
        const sid = int(instanceIndex).add(anchors.start).toVar(), s = surfels.element(sid);
        If(sid.lessThan(capacity).and(s.get('age').greaterThanEqual(0)).and(s.get('age').lessThan(SURFEL_TTL))
          .and(s.get('posb').w.equal(frame)), () => {
          const clip = viewProjection.mul(vec4(s.get('posb').xyz, 1));
          const ndc = clip.xy.div(clip.w);
          const uv = vec2(ndc.x.mul(0.5).add(0.5), ndc.y.mul(-0.5).add(0.5));
          const owner = texture(normalTexture, uv).w.negate().max(0).round().toInt().toVar();
          const object = objects.element(owner);
          const localPos = object.get('inverse').mul(vec4(s.get('posb').xyz, 1)).xyz;
          const localNormal = transpose(object.get('current')).mul(vec4(s.get('normal'), 0)).xyz.normalize();
          anchors.position(sid).assign(vec4(localPos, float(owner)));
          anchors.normal(sid).assign(vec4(localNormal, s.get('posb').w));
        });
      })().compute(anchors.count).setName('Capture New Surfel Anchors');
    }
    renderer.compute(captureNode);
  }

  async function readState(renderer, pool: SurfelPool) {
    const [spatialBuffer, anchorBuffer] = await Promise.all([
      renderer.getArrayBufferAsync(pool.getSurfelAttr()), renderer.getArrayBufferAsync(pool.getAnchorAttr()),
    ]);
    const spatial = new Float32Array(spatialBuffer), ages = new Int32Array(spatialBuffer);
    const anchors = new Float32Array(anchorBuffer);
    const rows = [], expected = new THREE.Vector3(), actualNormal = new THREE.Vector3();
    let maxPositionError = 0, maxNormalError = 0;
    for (let sid = 0; sid < pool.getCapacity(); sid++) {
      const base = sid * 8;
      const anchorBase = Math.max(0, Math.min(pool.getAnchorAttr().count / 2 - 1, sid - pool.getAnchorStart() + 1)) * 8;
      if (ages[base + 7] < 0 || ages[base + 7] >= SURFEL_TTL) continue;
      const owner = anchors[anchorBase + 7] === spatial[base + 3] ? anchors[anchorBase + 3] : 0;
      const world = Array.from(spatial.slice(base, base + 3));
      const local = Array.from(anchors.slice(anchorBase, anchorBase + 3));
      if (owner > 0 && meshById.has(owner)) {
        const matrix = meshById.get(owner).matrixWorld;
        expected.fromArray(local).applyMatrix4(matrix);
        maxPositionError = Math.max(maxPositionError, expected.distanceTo(new THREE.Vector3(...world)));
        expected.fromArray(anchors, anchorBase + 4).applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(matrix));
        actualNormal.fromArray(spatial, base + 4);
        maxNormalError = Math.max(maxNormalError, expected.distanceTo(actualNormal));
      }
      rows.push({ sid, owner, birth: spatial[base + 3], world, local });
    }
    return { active, rows, maxPositionError, maxNormalError,
      anchorStart: pool.getAnchorStart(), anchorSlots: pool.getAnchorAttr().count / 2 - 1,
      poolCapacity: pool.getCapacity(), anchorBufferBytes: anchorBuffer.byteLength,
      nullAnchor: Array.from(anchors.slice(0, 8)),
      allocatedBytes: pool.getAnchorAttr().array.byteLength + transforms.array.byteLength,
      objects: meshes.map((mesh, index) => {
        mesh.geometry.computeBoundingSphere();
        return { id: receiverIds[index], name: mesh.name, matrix: mesh.matrixWorld.toArray(),
          center: mesh.geometry.boundingSphere.center.toArray(), radius: mesh.geometry.boundingSphere.radius };
      }) };
  }

  function remapTo(renderer, pool, next) {
    if (pool.getAnchorStart() >= pool.getCapacity()) return;
    const nextIndices = new Map(next.meshes.map((mesh, i) => [mesh, i]));
    const targets = new Int32Array(objectCount);
    meshes.forEach((mesh, i) => {
      const index = nextIndices.get(mesh);
      if (index !== undefined && geometrySignatures[i] === next.geometrySignatures[index]) {
        targets[receiverIds[i]] = next.receiverIds[index];
      }
    });
    const mapping = new THREE.StorageBufferAttribute(targets, 1);
    const ids = storage(mapping, 'int', objectCount).toReadOnly();
    const capacity = pool.getCapacity(), anchors = bindSurfelAnchors(pool, false);
    const surfels = storage(pool.getSurfelAttr(), SurfelStruct, capacity);
    const depth = storage(pool.getSurfelDepthAttr(), 'vec4', pool.getSurfelDepthAttr().count);
    const free = storage(pool.getPoolAttr(), 'int', capacity), allocated = pool.getPoolAllocAtomic();
    const retired = pool.getDebugExecAttr();
    const node = Fn(() => {
      const sid = int(instanceIndex).add(anchors.start).toVar(), s = surfels.element(sid);
      const p = anchors.position(sid), n = anchors.normal(sid);
      If(sid.lessThan(capacity).and(s.get('age').greaterThanEqual(0)).and(s.get('age').lessThan(SURFEL_TTL))
        .and(p.w.greaterThan(0)).and(n.w.equal(s.get('posb').w)), () => {
        const owner = ids.element(int(p.w)).toVar();
        If(owner.greaterThan(0), () => {
          p.w.assign(float(owner));
          // Occluder membership changed even when this receiver did not move.
          // Keep its irradiance history, but discard visibility of the old scene.
          Loop(int(SURFEL_DEPTH_TEXELS * SURFEL_DEPTH_TEXELS), ({ i }) => {
            depth.element(sid.mul(SURFEL_DEPTH_TEXELS * SURFEL_DEPTH_TEXELS).add(i)).assign(vec4(0));
          });
        }).Else(() => {
          // Same free-list transaction as the lifecycle pass. Retire only removed
          // receivers; existing objects retain positions, irradiance and birth ids.
          s.get('age').assign(SURFEL_LIFE_RECYCLED);
          const count = atomicAdd(allocated.element(0), int(-1)).toVar();
          free.element(count.sub(1)).assign(sid);
          atomicAdd(retired.element(sid), int(1));
          p.assign(vec4(0)); n.assign(vec4(0));
        });
      });
    })().compute(anchors.count);
    renderer.compute(node); node.dispose(); renderer.backend.destroyAttribute(mapping);
  }
  function dispose(renderer) {
    moveNode?.dispose(); captureNode?.dispose();
    if (renderer.backend.has(transforms) && renderer.backend.get(transforms).buffer) renderer.backend.destroyAttribute(transforms);
  }
  return { prepare, capture, readState, remapTo, dispose, oldMatrices, geometrySignatures, receiverIds, objects, get active() { return active; },
    meshes, get allocatedBytes() { return transforms.array.byteLength; } };
}
