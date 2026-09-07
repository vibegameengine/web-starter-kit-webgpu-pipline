import * as THREE from 'three/webgpu';
import {
  Break,
  Fn,
  If,
  Loop,
  abs,
  cameraPosition,
  clamp,
  cos,
  dot,
  equirectUV,
  exp,
  float,
  max,
  mix,
  mrt,
  mx_fractal_noise_float,
  mx_noise_float,
  normalWorld,
  normalize,
  positionWorld,
  pow,
  reflect,
  refract,
  smoothstep,
  step,
  texture,
  time,
  transformNormalToView,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { IslandField } from '../island/heightField.ts';
import { WATER_ABSORB } from './medium.ts';

export interface WaterOptions {
  field: IslandField;
  /** Equirectangular HDR the sky reflection is read from. */
  environment: THREE.Texture;
  sun: THREE.DirectionalLight;
  /** How far below the water line the cut faces reach; the sand wall hides the rest. */
  cutDepth?: number;
}

export interface Water {
  group: THREE.Group;
  material: THREE.MeshStandardNodeMaterial;
  uniforms: {
    absorb: ReturnType<typeof uniform>;
    scatter: ReturnType<typeof uniform>;
    scatterStrength: ReturnType<typeof uniform>;
    envStrength: ReturnType<typeof uniform>;
    foamStrength: ReturnType<typeof uniform>;
    sunColor: ReturnType<typeof uniform>;
    sunDir: ReturnType<typeof uniform>;
  };
  update(): void;
}

/**
 * Lagoon water as one volume: a wave surface on top and glass-flat cut faces at the
 * slab edge, all shaded by the same material.
 *
 * The material knows the sand underneath (the island height texture), so every pixel
 * marches its refracted view ray through the volume to the floor and gets a real path
 * length. Absorption along that path (red first) is what turns the sand turquoise
 * with depth; in-scattered light is what keeps deep water from going black; the
 * vertical depth at the surface point is what places the shore foam and lets the
 * wet-sand band on the beach line up with it.
 *
 * Blending is premultiplied (`src + dst × (1 − α)`), so specular, sky reflection and
 * foam are added at full strength even where the water is nearly clear, and the sand
 * behind is attenuated by the marched transmittance rather than a constant opacity.
 */
export function createWater(options: WaterOptions): Water {
  const { field, environment, sun, cutDepth = 2.2 } = options;
  const half = field.half;

  const heightTexture = field.toTexture(256);
  heightTexture.name = 'islandHeight';

  const uniforms = {
    absorb: uniform(WATER_ABSORB.clone()),
    scatter: uniform(new THREE.Color(0.005, 0.135, 0.30)),
    scatterStrength: uniform(1.0),
    envStrength: uniform(0.7),
    foamStrength: uniform(1.0),
    sunColor: uniform(new THREE.Color(1, 0.95, 0.85)),
    sunDir: uniform(new THREE.Vector3(0, 1, 0)),
  };
  const waterLevel = uniform(field.waterLevel);
  const slabHalf = uniform(half);
  const slabBottom = uniform(field.bottom);

  const material = new THREE.MeshStandardNodeMaterial();
  material.name = 'lagoonWater';
  material.transparent = true;
  material.depthWrite = false;
  material.blending = THREE.CustomBlending;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneMinusSrcAlphaFactor;
  material.blendSrcAlpha = THREE.OneFactor;
  material.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  material.side = THREE.FrontSide;
  material.color = new THREE.Color(0.02, 0.1, 0.12);
  material.metalness = 0;
  material.roughness = 0.06;

  // No diffuse: everything the water shows is specular, transmitted or scattered.
  material.colorNode = vec3(0.0);
  material.metalnessNode = float(0.0);

  const p = positionWorld;
  const t = time;
  const isTop = smoothstep(0.5, 0.9, normalWorld.y);

  /** Sand height under (x, z) from the height texture; +z is row-down in the texture. */
  const sandHeight = Fn(([xz]: [ReturnType<typeof vec2>]) => {
    const uvCoord = xz.div(slabHalf).mul(0.5).add(0.5);
    return texture(heightTexture, uvCoord).r;
  });

  // --- wave normal (world) ----------------------------------------------------
  const waveNormal = Fn(() => {
    const xz = p.xz;
    let dx: THREE.Node = float(0.0);
    let dz: THREE.Node = float(0.0);
    const waves: Array<[number, number, number, number, number]> = [
      // dir x, dir z, wavelength, amplitude, speed
      [0.86, 0.5, 1.7, 0.010, 0.9],
      [-0.4, 0.92, 0.95, 0.007, 1.3],
      [0.98, -0.2, 0.55, 0.0045, 1.8],
      [0.3, -0.95, 0.32, 0.003, 2.4],
    ];
    for (const [ddx, ddz, wavelength, amplitude, speed] of waves) {
      const k = (2 * Math.PI) / wavelength;
      const phase = xz.x.mul(ddx * k).add(xz.y.mul(ddz * k)).sub(t.mul(speed * k * 0.35));
      const slope = cos(phase).mul(amplitude * k);
      dx = (dx as ReturnType<typeof float>).add(slope.mul(ddx));
      dz = (dz as ReturnType<typeof float>).add(slope.mul(ddz));
    }
    // Ripple detail: gradient of drifting noise, two scales.
    const e = float(0.03);
    const q1 = vec3(xz.x.mul(5.5).add(t.mul(0.35)), xz.y.mul(5.5).sub(t.mul(0.2)), t.mul(0.25));
    const n0 = mx_noise_float(q1);
    const nx = mx_noise_float(q1.add(vec3(e, 0.0, 0.0)));
    const nz = mx_noise_float(q1.add(vec3(0.0, e, 0.0)));
    dx = (dx as ReturnType<typeof float>).add(nx.sub(n0).div(e).mul(0.03));
    dz = (dz as ReturnType<typeof float>).add(nz.sub(n0).div(e).mul(0.03));
    const q2 = vec3(xz.x.mul(16.0).sub(t.mul(0.5)), xz.y.mul(16.0).add(t.mul(0.4)), t.mul(0.6).add(3.0));
    const m0 = mx_noise_float(q2);
    const mx = mx_noise_float(q2.add(vec3(e, 0.0, 0.0)));
    const mz = mx_noise_float(q2.add(vec3(0.0, e, 0.0)));
    dx = (dx as ReturnType<typeof float>).add(mx.sub(m0).div(e).mul(0.006));
    dz = (dz as ReturnType<typeof float>).add(mz.sub(m0).div(e).mul(0.006));
    const top = normalize(vec3((dx as ReturnType<typeof float>).negate(), 1.0, (dz as ReturnType<typeof float>).negate()));
    return normalize(mix(normalWorld, top, isTop));
  });
  const nWorld = waveNormal();
  material.normalNode = transformNormalToView(nWorld);
  material.roughnessNode = mix(float(0.10), float(0.09), isTop);

  // --- volume: march the refracted ray to the floor -----------------------
  const viewDir = normalize(p.sub(cameraPosition));
  // Geometric normal for the refraction so the path length does not shimmer.
  const refracted = refract(viewDir, normalWorld, float(1.0 / 1.333));

  const marched = Fn(() => {
    const pos = vec3(p).toVar();
    const dist = float(0.0).toVar();
    const stepLength = float(0.05).toVar();
    const hit = float(0.0).toVar();
    Loop({ start: 0, end: 28, type: 'int', condition: '<' }, () => {
      pos.addAssign(refracted.mul(stepLength));
      dist.addAssign(stepLength);
      const floor = sandHeight(pos.xz);
      // The volume is treated as continuing past the cut: a ray leaving through the
      // glass face would otherwise draw the slab outline onto the surface.
      const outside = pos.y.lessThan(slabBottom).or(abs(pos.x).greaterThan(slabHalf.mul(1.6))).or(abs(pos.z).greaterThan(slabHalf.mul(1.6)));
      If(pos.y.lessThan(floor).or(outside), () => {
        // Bisect the last step: the crossing is somewhere inside it, and the
        // coarse step alone contours the floor into visible depth bands.
        const lo = dist.sub(stepLength).toVar();
        const hi = dist.toVar();
        Loop({ start: 0, end: 5, type: 'int', condition: '<' }, () => {
          const mid = lo.add(hi).mul(0.5);
          const probe = p.add(refracted.mul(mid));
          If(probe.y.lessThan(sandHeight(probe.xz)), () => {
            hi.assign(mid);
          }).Else(() => {
            lo.assign(mid);
          });
        });
        dist.assign(lo.add(hi).mul(0.5));
        hit.assign(1.0);
        Break();
      });
      stepLength.mulAssign(1.18);
    });
    // Encode "no hit" as a negative length so a debug view can show it.
    return max(dist, 0.0).mul(hit.mul(2.0).sub(1.0));
  });
  const marchedSigned = marched();
  const pathLength = abs(marchedSigned);
  const missed = step(marchedSigned, 0.0);

  const transmittance = exp(vec3(uniforms.absorb).mul(pathLength).negate());
  // Vertical depth right under the shaded point (shore foam, wet band).
  const verticalDepth = waterLevel.sub(sandHeight(p.xz));
  // Cut faces below the sand floor show nothing: the wall is there, not water.
  const inWater = mix(step(sandHeight(p.xz), p.y), float(1.0), isTop);

  // --- in-scattering ---------------------------------------------------------
  const sunDir = vec3(uniforms.sunDir);
  const sunUp = clamp(sunDir.y, 0.0, 1.0);
  const lightIntoWater = vec3(uniforms.sunColor).mul(sunUp.mul(1.6).add(0.5));
  const scatterAmount = float(1.0).sub(exp(pathLength.mul(-0.6)));
  const scatter = vec3(uniforms.scatter).mul(lightIntoWater).mul(scatterAmount).mul(uniforms.scatterStrength);

  // --- sky reflection --------------------------------------------------------
  const reflected = reflect(viewDir, nWorld);
  const reflectedUp = vec3(reflected.x, abs(reflected.y), reflected.z);
  const sky = texture(environment, equirectUV(reflectedUp)).rgb;
  const cosTheta = clamp(dot(nWorld, viewDir.negate()), 0.0, 1.0);
  const fresnel = float(0.02).add(float(0.98).mul(pow(float(1.0).sub(cosTheta), 5.0)));
  const reflection = sky.mul(fresnel).mul(uniforms.envStrength);

  // --- foam --------------------------------------------------------------------
  const foam = Fn(() => {
    const band = smoothstep(0.55, 0.0, verticalDepth);
    const q = vec3(p.x.mul(5.0), p.z.mul(5.0), t.mul(0.45));
    const lace = mx_fractal_noise_float(q, 4, 2.3, 0.55);
    const fine = mx_noise_float(vec3(p.x.mul(22.0), p.z.mul(22.0), t.mul(0.8)));
    // Surge lines rolling toward the shore.
    const surge = cos(verticalDepth.mul(30.0).sub(t.mul(2.0)).add(lace.mul(4.0))).mul(0.5).add(0.5);
    // Lace: dense at the water line, breaking into holes and filaments further out.
    // Solid at the water line, lace with holes over the next half metre, gone beyond.
    const edge = smoothstep(0.10, 0.0, verticalDepth);
    const shape = lace.mul(0.75).add(fine.mul(0.3)).add(surge.mul(0.4).mul(band)).add(band.mul(0.85)).add(edge.mul(0.25)).sub(1.05);
    const shore = smoothstep(0.0, 0.45, shape).mul(band.mul(0.9).add(0.1)).mul(smoothstep(0.0, 0.05, band));
    const caps = float(0.0).mul(fine);
    return clamp(shore.add(caps), 0.0, 1.0).mul(isTop).mul(uniforms.foamStrength);
  });
  const foamMask = foam();
  const foamLight = vec3(uniforms.sunColor).mul(clamp(sunDir.y, 0.0, 1.0).mul(1.3)).add(vec3(0.35, 0.4, 0.45));
  const foamColor = vec3(0.92, 0.95, 0.96).mul(foamLight);

  // Everything the water adds, premultiplied.
  const alphaWater = float(1.0).sub(dot(transmittance, vec3(0.6, 0.3, 0.1)));
  const alpha = mix(alphaWater, float(1.0), foamMask).mul(inWater);
  const added = mix(scatter.add(reflection), foamColor, foamMask).mul(inWater);

  // `?waterDebug=path` paints the marched path length (0.3 m per unit) so the volume
  // can be checked as numbers rather than as a colour impression.
  const debugMode = new URLSearchParams(window.location.search).get('waterDebug');
  const debugNode =
    debugMode === 'path' ? vec3(pathLength.mul(0.3))
    : debugMode === 'depth' ? vec3(verticalDepth.mul(0.5))
    : debugMode === 'hit' ? vec3(missed, float(1.0).sub(missed), 0.0)
    : null;
  material.emissiveNode = debugNode ?? added;
  material.opacityNode = debugNode ? float(1.0) : alpha;
  // Leave the G-buffer to the sand underneath: the composite's indirect term must
  // not be steered by a translucent surface, and velocity is meaningless here.
  material.mrtNode = mrt({ albedo: vec4(0.0), normal: vec4(0.0), velocity: vec4(0.0) });

  // --- geometry ------------------------------------------------------------------
  const group = new THREE.Group();
  group.name = 'water';

  const top = new THREE.PlaneGeometry(2 * half, 2 * half, 96, 96);
  top.rotateX(-Math.PI / 2);
  top.translate(0, field.waterLevel, 0);
  const topMesh = new THREE.Mesh(top, material);
  topMesh.name = 'waterSurface';
  group.add(topMesh);

  // Cut faces on the two open sides (front +z, left -x). A hair outside the slab
  // so they never z-fight with the wall's rim row.
  const skin = 0.004;
  const wantCuts = new URLSearchParams(window.location.search).get('waterCuts') !== '0';
  const front = new THREE.PlaneGeometry(2 * half, cutDepth, 96, 24);
  front.translate(0, field.waterLevel - cutDepth / 2, half + skin);
  const frontMesh = new THREE.Mesh(front, material);
  frontMesh.name = 'waterCutFront';
  group.add(frontMesh);

  const left = new THREE.PlaneGeometry(2 * half, cutDepth, 96, 24);
  left.rotateY(-Math.PI / 2);
  left.translate(-half - skin, field.waterLevel - cutDepth / 2, 0);
  const leftMesh = new THREE.Mesh(left, material);
  leftMesh.name = 'waterCutLeft';
  group.add(leftMesh);

  if (!wantCuts) group.remove(frontMesh, leftMesh);
  for (const mesh of [topMesh, frontMesh, leftMesh]) {
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.userData.giExclude = true;
    mesh.renderOrder = 10;
  }

  const sunDirection = new THREE.Vector3();
  return {
    group,
    material,
    uniforms,
    update() {
      sunDirection.copy(sun.position).sub(sun.target.position).normalize();
      (uniforms.sunDir.value as THREE.Vector3).copy(sunDirection);
      (uniforms.sunColor.value as THREE.Color).copy(sun.color).multiplyScalar(Math.min(1.5, sun.intensity * 0.5));
    },
  };
}
