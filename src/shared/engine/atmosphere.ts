import * as THREE from 'three';
import type { WorldContext } from './context';

/**
 * SkyAtmosphere: physically-based single scattering (Rayleigh + Mie),
 * the same model UE's SkyAtmosphere component solves.
 * The GLSL renders the sky dome; a JS twin of the same math samples
 * sun transmittance and sky tints so lights/fog/IBL all agree.
 */

// ── shared constants (Earth) ────────────────────────────────────────────────
const PLANET_R = 6371e3;
const ATMOS_R = 6471e3;
const BETA_R = new THREE.Vector3(5.5e-6, 13.0e-6, 22.4e-6);
const BETA_M = 21e-6;
const H_R = 8500;
const H_M = 1200;
const SUN_INTENSITY = 22.0;

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize( position );
    vec4 mv = modelViewMatrix * vec4( position, 1.0 );
    gl_Position = projectionMatrix * mv;
    gl_Position.z = gl_Position.w; // pin to far plane
  }
`;

const SKY_FRAG = /* glsl */ `
  varying vec3 vDir;
  uniform vec3 uSunDir;

  const float PLANET_R = ${PLANET_R.toFixed(1)};
  const float ATMOS_R  = ${ATMOS_R.toFixed(1)};
  const vec3  BETA_R   = vec3( 5.5e-6, 13.0e-6, 22.4e-6 );
  const float BETA_M   = 21e-6;
  const float H_R      = ${H_R.toFixed(1)};
  const float H_M      = ${H_M.toFixed(1)};
  const float SUN_I    = ${SUN_INTENSITY.toFixed(1)};
  const int   N_SAMPLES = 16;
  const int   N_LIGHT   = 8;

  // ray-sphere: returns near/far intersection distances (sphere at origin)
  vec2 raySphere( vec3 ro, vec3 rd, float r ) {
    float b = dot( ro, rd );
    float c = dot( ro, ro ) - r * r;
    float h = b * b - c;
    if ( h < 0.0 ) return vec2( 1e9, -1e9 );
    h = sqrt( h );
    return vec2( -b - h, -b + h );
  }

  vec3 atmosphere( vec3 rd, vec3 sunDir ) {
    vec3 ro = vec3( 0.0, PLANET_R + 2.0, 0.0 );
    vec2 hit = raySphere( ro, rd, ATMOS_R );
    if ( hit.x > hit.y ) return vec3( 0.0 );
    float tMax = hit.y;
    vec2 ground = raySphere( ro, rd, PLANET_R );
    if ( ground.x > 0.0 ) tMax = min( tMax, ground.x );

    float mu = dot( rd, sunDir );
    float phaseR = 3.0 / ( 16.0 * 3.14159265 ) * ( 1.0 + mu * mu );
    float g = 0.76;
    float phaseM = 3.0 / ( 8.0 * 3.14159265 ) * ( ( 1.0 - g * g ) * ( 1.0 + mu * mu ) )
                 / ( ( 2.0 + g * g ) * pow( 1.0 + g * g - 2.0 * g * mu, 1.5 ) );

    float segLen = tMax / float( N_SAMPLES );
    float t = 0.0;
    vec3 sumR = vec3( 0.0 );
    vec3 sumM = vec3( 0.0 );
    float odR = 0.0;
    float odM = 0.0;

    for ( int i = 0; i < N_SAMPLES; i++ ) {
      vec3 p = ro + rd * ( t + segLen * 0.5 );
      float h = length( p ) - PLANET_R;
      float dR = exp( -h / H_R ) * segLen;
      float dM = exp( -h / H_M ) * segLen;
      odR += dR;
      odM += dM;

      // optical depth toward the sun
      vec2 lHit = raySphere( p, sunDir, ATMOS_R );
      float lLen = lHit.y / float( N_LIGHT );
      float lt = 0.0;
      float lodR = 0.0;
      float lodM = 0.0;
      for ( int j = 0; j < N_LIGHT; j++ ) {
        vec3 lp = p + sunDir * ( lt + lLen * 0.5 );
        float lh = length( lp ) - PLANET_R;
        lodR += exp( -lh / H_R ) * lLen;
        lodM += exp( -lh / H_M ) * lLen;
        lt += lLen;
      }

      vec3 tau = BETA_R * ( odR + lodR ) + vec3( BETA_M * 1.1 ) * ( odM + lodM );
      vec3 attn = exp( -tau );
      sumR += attn * dR;
      sumM += attn * dM;
      t += segLen;
    }

    return SUN_I * ( sumR * BETA_R * phaseR + sumM * BETA_M * phaseM );
  }

  void main() {
    vec3 rd = normalize( vDir );
    vec3 col = atmosphere( rd, uSunDir );

    // sun disc with limb softening
    float mu = dot( rd, uSunDir );
    float disc = smoothstep( 0.9997, 0.99985, mu );
    if ( disc > 0.0 ) {
      // transmittance-tinted disc
      vec3 discCol = vec3( 40.0, 36.0, 30.0 );
      col += discCol * disc;
    }

    gl_FragColor = vec4( col, 1.0 );
  }
`;

// ── JS twin: sample transmittance & sky radiance for CPU consumers ──────────
function raySphereJS(ro: THREE.Vector3, rd: THREE.Vector3, r: number): [number, number] {
  const b = ro.dot(rd);
  const c = ro.dot(ro) - r * r;
  let h = b * b - c;
  if (h < 0) return [1e9, -1e9];
  h = Math.sqrt(h);
  return [-b - h, -b + h];
}

/** Transmittance from ground level toward `dir` (extinction only). */
function transmittance(dir: THREE.Vector3): THREE.Color {
  const ro = new THREE.Vector3(0, PLANET_R + 2, 0);
  const [, far] = raySphereJS(ro, dir, ATMOS_R);
  const N = 24;
  const seg = far / N;
  let odR = 0;
  let odM = 0;
  const p = new THREE.Vector3();
  for (let i = 0; i < N; i++) {
    p.copy(dir).multiplyScalar((i + 0.5) * seg).add(ro);
    const h = p.length() - PLANET_R;
    odR += Math.exp(-h / H_R) * seg;
    odM += Math.exp(-h / H_M) * seg;
  }
  return new THREE.Color(
    Math.exp(-(BETA_R.x * odR + BETA_M * 1.1 * odM)),
    Math.exp(-(BETA_R.y * odR + BETA_M * 1.1 * odM)),
    Math.exp(-(BETA_R.z * odR + BETA_M * 1.1 * odM)),
  );
}

/** Sky radiance toward `rd` — coarse JS port of the GLSL integrator. */
function skyRadiance(rd: THREE.Vector3, sunDir: THREE.Vector3): THREE.Color {
  const ro = new THREE.Vector3(0, PLANET_R + 2, 0);
  const [, tMax0] = raySphereJS(ro, rd, ATMOS_R);
  let tMax = tMax0;
  const [g0] = raySphereJS(ro, rd, PLANET_R);
  if (g0 > 0) tMax = Math.min(tMax, g0);

  const mu = rd.dot(sunDir);
  const phaseR = (3 / (16 * Math.PI)) * (1 + mu * mu);
  const g = 0.76;
  const phaseM =
    ((3 / (8 * Math.PI)) * ((1 - g * g) * (1 + mu * mu))) /
    ((2 + g * g) * Math.pow(1 + g * g - 2 * g * mu, 1.5));

  const N = 12;
  const NL = 6;
  const seg = tMax / N;
  let odR = 0;
  let odM = 0;
  const sumR = new THREE.Vector3();
  const sumM = new THREE.Vector3();
  const p = new THREE.Vector3();
  const lp = new THREE.Vector3();

  for (let i = 0; i < N; i++) {
    p.copy(rd).multiplyScalar((i + 0.5) * seg).add(ro);
    const h = p.length() - PLANET_R;
    const dR = Math.exp(-h / H_R) * seg;
    const dM = Math.exp(-h / H_M) * seg;
    odR += dR;
    odM += dM;

    const [, lFar] = raySphereJS(p, sunDir, ATMOS_R);
    const lSeg = lFar / NL;
    let lodR = 0;
    let lodM = 0;
    for (let j = 0; j < NL; j++) {
      lp.copy(sunDir).multiplyScalar((j + 0.5) * lSeg).add(p);
      const lh = lp.length() - PLANET_R;
      lodR += Math.exp(-lh / H_R) * lSeg;
      lodM += Math.exp(-lh / H_M) * lSeg;
    }
    const ax = Math.exp(-(BETA_R.x * (odR + lodR) + BETA_M * 1.1 * (odM + lodM)));
    const ay = Math.exp(-(BETA_R.y * (odR + lodR) + BETA_M * 1.1 * (odM + lodM)));
    const az = Math.exp(-(BETA_R.z * (odR + lodR) + BETA_M * 1.1 * (odM + lodM)));
    sumR.x += ax * dR; sumR.y += ay * dR; sumR.z += az * dR;
    sumM.x += ax * dM; sumM.y += ay * dM; sumM.z += az * dM;
  }

  return new THREE.Color(
    SUN_INTENSITY * (sumR.x * BETA_R.x * phaseR + sumM.x * BETA_M * phaseM),
    SUN_INTENSITY * (sumR.y * BETA_R.y * phaseR + sumM.y * BETA_M * phaseM),
    SUN_INTENSITY * (sumR.z * BETA_R.z * phaseR + sumM.z * BETA_M * phaseM),
  );
}

// ── public component ────────────────────────────────────────────────────────
export class Atmosphere {
  readonly skyMesh: THREE.Mesh;
  readonly sunLight: THREE.DirectionalLight;
  readonly ambient: THREE.HemisphereLight;
  private uniforms = { uSunDir: { value: new THREE.Vector3(0, 1, 0) } };
  private envRT: THREE.WebGLRenderTarget | null = null;

  constructor(private renderer: THREE.WebGLRenderer) {
    const mat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      uniforms: this.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
    });
    this.skyMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), mat);
    this.skyMesh.scale.setScalar(9000);
    this.skyMesh.frustumCulled = false;

    this.sunLight = new THREE.DirectionalLight(0xffffff, 1);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(4096, 4096);
    this.sunLight.shadow.bias = -0.0003;
    this.sunLight.shadow.normalBias = 0.4;

    this.ambient = new THREE.HemisphereLight(0xbcd0e8, 0x4c463a, 1);
  }

  /**
   * Position the sun and propagate physically-derived colors into the
   * context, the directional light, the hemisphere light and the sky IBL.
   */
  setSun(elevationDeg: number, azimuthDeg: number, ctx: WorldContext, scene: THREE.Scene): void {
    const el = THREE.MathUtils.degToRad(elevationDeg);
    const az = THREE.MathUtils.degToRad(azimuthDeg);
    ctx.sunDir.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).normalize();
    this.uniforms.uSunDir.value.copy(ctx.sunDir);

    // sun light: transmittance-tinted white, UE-like intensity in unitless HDR
    const trans = transmittance(ctx.sunDir);
    ctx.sunColor.copy(trans);
    this.sunLight.color.copy(trans);
    this.sunLight.intensity = 3.8 * Math.max(0.05, Math.min(1, ctx.sunDir.y * 4));
    this.sunLight.position.copy(ctx.sunDir).multiplyScalar(600);

    // sky tints for fog/ambient from the same scattering math
    const zen = skyRadiance(new THREE.Vector3(0, 1, 0), ctx.sunDir);
    // horizon: average radiance at ~2° elevation across a few azimuths
    const hor = new THREE.Color(0, 0, 0);
    const dirs = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
    for (const a of dirs) {
      const d = new THREE.Vector3(Math.sin(az + a), 0.035, Math.cos(az + a)).normalize();
      hor.add(skyRadiance(d, ctx.sunDir));
    }
    hor.multiplyScalar(1 / dirs.length);

    ctx.zenithColor.copy(zen);
    ctx.horizonColor.copy(hor);
    ctx.skyColor.copy(zen).lerp(hor, 0.5);

    this.ambient.color.copy(ctx.skyColor).multiplyScalar(0.5);
    this.ambient.groundColor.copy(new THREE.Color(0.35, 0.3, 0.24).multiply(ctx.skyColor).multiplyScalar(0.9));
    this.ambient.intensity = 1.05;

    this.refreshIBL(scene);
  }

  /** SkyLight: capture the sky dome into a PMREM env map. */
  private refreshIBL(scene: THREE.Scene): void {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const skyScene = new THREE.Scene();
    const clone = this.skyMesh.clone();
    clone.scale.setScalar(100);
    skyScene.add(clone);
    this.envRT?.dispose();
    this.envRT = pmrem.fromScene(skyScene, 0, 1, 200);
    scene.environment = this.envRT.texture;
    scene.environmentIntensity = 0.4;
    pmrem.dispose();
  }

  /** Configure the sun's shadow frustum around the play area. */
  fitShadows(halfExtent: number, far = 1400): void {
    const cam = this.sunLight.shadow.camera;
    cam.left = -halfExtent;
    cam.right = halfExtent;
    cam.top = halfExtent;
    cam.bottom = -halfExtent;
    cam.near = 1;
    cam.far = far;
    cam.updateProjectionMatrix();
  }
}
