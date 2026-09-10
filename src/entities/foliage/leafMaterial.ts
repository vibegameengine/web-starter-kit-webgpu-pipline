/**
 * Thin-leaf BSDF for the WebGPU raster.
 *
 * A leaf is a translucent sheet: light that is not reflected by its upper face
 * and not absorbed by its pigments leaves through the other face, scattered by
 * the mesophyll into a near-Lambertian distribution. The plate model in
 * `leafOptics.ts` gives both halves of that budget per leaf — the reflectance R
 * and the transmittance T, with R + T + absorption = 1 — and this material
 * spends them:
 *
 *   front (reflected):    R / π · E(n)             (three's Lambert term)
 *   through (transmitted): T · p(θ) · E(−n)         (added here)
 *   cuticle specular:      GGX with F0 from the cuticle's refractive index
 *
 * `p(θ)` is the angular distribution of the transmitted light. A leaf is not a
 * Lambertian diffuser in transmission: measured leaf BTDFs (Bousquet et al.
 * 2005) keep a forward lobe around the continuation of the incident ray, on
 * top of a diffuse floor from multiple scattering in the mesophyll. Here
 * p = (1 − f) / π + f · HG(g, cos θ), a Henyey–Greenstein lobe of asymmetry
 * g = 0.55 carrying f = 0.35 of the transmitted flux, θ measured between the
 * view ray and the continued sun ray. That is what makes a crown glow when
 * looked at toward the sun and stay merely lit when looked at from the side.
 *
 * `E(−n)` for the sun is `lightColor · max(0, −n·l)`; it is evaluated inside the
 * lighting model, so the sun's shadow map applies to the transmitted light as
 * well as to the reflected light — a leaf in another leaf's shadow does not glow.
 * For the diffuse environment the same irradiance is used on both faces, a fair
 * approximation for a thin sheet under a sky and a ground of similar brightness.
 * The screen-space GI composite multiplies its irradiance by the G-buffer's
 * `diffuseColor`, which is R only; that path does not transmit.
 *
 * The scene sets no `scene.environment`: diffuse indirect light is the GI's job.
 * A waxy cuticle, though, mirrors the sky, and at grazing angles Fresnel takes
 * that reflection toward 1 — a leaf without it reads as matte plastic. So the
 * leaf carries its own `LeafEnvironmentNode`: the sky's prefiltered radiance for
 * the specular lobe only (no IBL irradiance, which would double the GI), plus
 * the sky irradiance on the far face for the transmitted term.
 */
import * as THREE from 'three/webgpu';
import { IsolateNode, LightingNode, PhysicalLightingModel } from 'three/webgpu';
import {
  attribute,
  cameraViewMatrix,
  float,
  frontFacing,
  materialEnvIntensity,
  mix,
  normalMap,
  normalView,
  normalWorld,
  pmremTexture,
  positionViewDirection,
  pow4,
  roughness,
  texture,
  uv,
  vec3,
  vertexColor,
} from 'three/tsl';
import type { LeafSurface } from './leafSurface.ts';

const RECIPROCAL_PI = 1 / Math.PI;
/** Henyey–Greenstein asymmetry of the forward-transmitted lobe and its share of the flux. */
const HG_G = 0.55;
const HG_FRACTION = 0.35;
/** Switches for isolating the environment node's two terms while debugging. */
const LEAF_ENV_BACK = true;
const LEAF_ENV_RADIANCE = true;

interface DirectLight {
  lightDirection: THREE.Node;
  lightColor: THREE.Node;
  reflectedLight: { directDiffuse: THREE.Node; indirectDiffuse: THREE.Node };
}

const pmremCache = new WeakMap<THREE.Texture, ReturnType<typeof pmremTexture>>();

/**
 * The GI reads the sky through a luminance knee (5 → 15, `sampleEnvEquirectClamped`
 * in surfelIntegratePass.ts) so the sun disc in the panorama does not double the
 * analytic sun. The leaf's mirror is stricter: the sun's highlight is the analytic
 * GGX lobe's job, so the copy of the map that feeds the mirror is clipped at the
 * knee — a glossy leaf in shade must reflect the sky, not a smeared sun.
 */
function compressedSky(source: THREE.Texture): THREE.Texture {
  const image = source.image as { data?: ArrayLike<number>; width: number; height: number };
  if (!image?.data) return source;
  const half = source.type === THREE.HalfFloatType;
  const src = image.data;
  const out = half ? new Uint16Array(src.length) : new Float32Array(src.length);
  const read = (i: number): number => (half ? THREE.DataUtils.fromHalfFloat(src[i] as number) : (src[i] as number));
  const write = (i: number, v: number): void => {
    out[i] = half ? THREE.DataUtils.toHalfFloat(v) : v;
  };
  const knee = 5;
  for (let i = 0; i < src.length; i += 4) {
    const r = read(i);
    const g = read(i + 1);
    const b = read(i + 2);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const k = lum > knee ? knee / lum : 1;
    write(i, r * k);
    write(i + 1, g * k);
    write(i + 2, b * k);
    write(i + 3, read(i + 3));
  }
  const texture = new THREE.DataTexture(out, image.width, image.height, THREE.RGBAFormat, source.type);
  texture.name = `${source.name || 'sky'}-compressed`;
  texture.colorSpace = source.colorSpace;
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.flipY = source.flipY;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/** Sky for the cuticle's mirror and for light coming through from the far side. */
class LeafEnvironmentNode extends LightingNode {
  constructor(private readonly environment: THREE.Texture) {
    super();
  }

  override setup(builder: THREE.NodeBuilder): void {
    let env = pmremCache.get(this.environment);
    if (!env) {
      env = pmremTexture(compressedSky(this.environment));
      pmremCache.set(this.environment, env);
    }
    let reflectVec: THREE.Node | null = null;
    const reflectWorld = (): THREE.Node => {
      if (reflectVec === null) {
        reflectVec = positionViewDirection.negate().reflect(normalView);
        reflectVec = pow4(roughness).mix(reflectVec, normalView).normalize().transformDirection(cameraViewMatrix);
      }
      return reflectVec;
    };
    // Only reflections that point at the sky. Below the horizon the panorama holds
    // its own ground (a flat grey in a "puresky" map), not this scene's sand; that
    // grey is what turned every underside steel-blue. The scene's ground has no
    // specular source here (no SSR), so those directions reflect nothing.
    const skyMirror = reflectWorld().y.smoothstep(-0.05, 0.25);
    const radiance = env
      .context({ getUV: reflectWorld, getTextureLevel: () => roughness })
      .mul(materialEnvIntensity)
      .mul(skyMirror);
    // Only the sky half of the map: the ground in a panorama is not this scene's
    // ground, and the bounce off the real sand is the GI's to provide. A leaf seen
    // from below therefore transmits the sky; one seen from above transmits little.
    const backDir = normalWorld.negate();
    const skyward = backDir.y.smoothstep(-0.15, 0.35);
    const back = env
      .context({ getUV: () => backDir, getTextureLevel: () => float(1) })
      .mul(Math.PI)
      .mul(materialEnvIntensity)
      .mul(skyward);
    // Not in three's type declarations: the lighting context every light node writes to.
    const context = (builder as unknown as { context: { radiance: THREE.Node; leafBackIrradiance?: THREE.Node } }).context;
    if (LEAF_ENV_RADIANCE) context.radiance.addAssign(new IsolateNode(radiance));
    if (LEAF_ENV_BACK) context.leafBackIrradiance = new IsolateNode(back);
  }
}

class LeafLightingModel extends PhysicalLightingModel {
  constructor(private readonly transmittance: THREE.Node) {
    super(false, false, false, false, false, false);
  }

  override direct(lightData: DirectLight, builder: THREE.NodeBuilder): void {
    super.direct(lightData as never, builder);
    const { lightDirection, lightColor, reflectedLight } = lightData;
    // Light arriving on the face away from the viewer. `normalView` already
    // points at the viewer on a double-sided material, so −n·l > 0 is "behind".
    const backlit = (normalView.dot(lightDirection) as THREE.Node).negate().clamp();
    // Forward lobe: light continuing past the leaf along −l reaches a viewer
    // whose view direction v points back along it, cos θ = v · (−l).
    const cosTheta = positionViewDirection.dot(lightDirection).negate();
    const g = float(HG_G);
    const hg = float(1 - HG_G * HG_G).div(
      float(1).add(g.mul(g)).sub(g.mul(2).mul(cosTheta)).pow(1.5).mul(4 * Math.PI),
    );
    const phase = float((1 - HG_FRACTION) * RECIPROCAL_PI).add(hg.mul(HG_FRACTION));
    reflectedLight.directDiffuse.addAssign(backlit.mul(lightColor).mul(this.transmittance).mul(phase));
  }

  // Not in three's type declarations, but part of the runtime lighting model.
  indirectDiffuse(builder: THREE.NodeBuilder): void {
    (PhysicalLightingModel.prototype as unknown as { indirectDiffuse(b: THREE.NodeBuilder): void }).indirectDiffuse.call(this, builder);
    const context = (builder as unknown as {
      context: { irradiance?: THREE.Node; leafBackIrradiance?: THREE.Node; reflectedLight?: { indirectDiffuse: THREE.Node } };
    }).context;
    if (!context.reflectedLight) return;
    // Ambient/hemisphere lights, assumed the same on both faces of a thin sheet...
    if (context.irradiance) context.reflectedLight.indirectDiffuse.addAssign(context.irradiance.mul(this.transmittance).mul(float(RECIPROCAL_PI)));
    // ...and the sky seen from the far face, which is what lights an underside from below.
    if (context.leafBackIrradiance) context.reflectedLight.indirectDiffuse.addAssign(context.leafBackIrradiance.mul(this.transmittance).mul(float(RECIPROCAL_PI)));
  }
}

/**
 * Physical material whose vertex data carries the leaf's optics:
 * `color` = reflectance, `transmittance` = transmittance (both linear RGB).
 */
export class LeafNodeMaterial extends THREE.MeshPhysicalNodeMaterial {
  transmittanceNode: THREE.Node = vec3(0);

  override setupLightingModel(): PhysicalLightingModel {
    return new LeafLightingModel(this.transmittanceNode);
  }

  /**
   * The standard material wraps whatever `envNode` holds in an `EnvironmentNode`
   * that expects a texture. Ours is already a lighting node; hand it over as is.
   */
  override setupEnvironment(builder: THREE.NodeBuilder): THREE.EnvironmentNode | null {
    // Typed as EnvironmentNode upstream; NodeMaterial only asks for `isLightingNode`.
    return this.envNode ? (this.envNode as unknown as THREE.EnvironmentNode) : super.setupEnvironment(builder);
  }
}

export interface LeafMaterialOptions {
  surface: LeafSurface;
  /** Refractive index of the cuticle; sets the specular F0 ((n−1)/(n+1))². */
  ior: number;
  /** Mean reflectance, for anything that reads `material.color` (the GI tracer). */
  meanReflectance: [number, number, number];
  /** Mean photometric transmittance: the tracer's chance of a ray passing straight through. */
  meanTransmittance: number;
  /** Per-channel difference between a vein's R and T and the lamina's (`veinTint` in leafOptics). */
  veinTint: { dR: [number, number, number]; dT: [number, number, number] };
  /** Sky (equirectangular HDR) for the cuticle's specular reflection and back-face transmission. */
  environment?: THREE.Texture;
  name: string;
}

export function createLeafMaterial(options: LeafMaterialOptions): LeafNodeMaterial {
  const material = new LeafNodeMaterial();
  material.name = options.name;
  material.side = THREE.DoubleSide;
  material.metalness = 0;
  material.ior = options.ior;
  material.roughness = 1; // multiplied into roughnessNode by three; the node carries the value
  material.color.setRGB(options.meanReflectance[0], options.meanReflectance[1], options.meanReflectance[2], THREE.LinearSRGBColorSpace);
  const gloss = texture(options.surface.roughness, uv());
  // Veins hold less chlorophyll than the lamina: paler, yellower, more translucent.
  const vein = gloss.b;
  const transmittance = attribute('transmittance', 'vec3');
  material.colorNode = vertexColor().rgb.add(vec3(...options.veinTint.dR).mul(vein)).max(0);
  material.transmittanceNode = transmittance.add(vec3(...options.veinTint.dT).mul(vein)).max(0);
  // Opaque parts of the same mesh (rachis, petiole: transmittance exactly zero) are
  // wood, not cuticle: matte, so they do not mirror the sky like a blade.
  const opaque = transmittance.g.lessThan(0.0005);
  material.roughnessNode = opaque.select(float(0.8), mix(gloss.g, gloss.r, float(frontFacing)));
  // `normalMap` unpacks 0..1 → −1..1 itself; feeding it an unpacked vector tilts every texel by ~55°.
  material.normalNode = normalMap(texture(options.surface.normal, uv()).xyz);
  material.userData.giTransmission = options.meanTransmittance;
  if (options.environment) material.envNode = new LeafEnvironmentNode(options.environment);
  return material;
}

/** Vertex attributes a leaf geometry must carry for this material. */
export function leafAttributes(geometry: THREE.BufferGeometry, reflectance: number[], transmittance: number[]): void {
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(reflectance, 3));
  geometry.setAttribute('transmittance', new THREE.Float32BufferAttribute(transmittance, 3));
}
