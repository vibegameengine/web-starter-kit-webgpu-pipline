import * as THREE from 'three';

/**
 * SkyAtmosphere — physically-based sky shader after UE's SkyAtmosphere
 * component (Hillaire 2020 model): Rayleigh + Mie scattering, ozone
 * absorption, an isotropic multiple-scattering term, ground albedo bounce
 * and a transmittance-tinted sun disc. No textures, no photos — pure math.
 *
 * Units are kilometres. Earth defaults match UE:
 *   ground radius 6360, atmosphere top 6460,
 *   βR = (5.802, 13.558, 33.1)e-3 /km   (scale height 8 km)
 *   βM = 3.996e-3 scatter + 4.4e-3 absorb /km (scale height 1.2 km, g 0.8)
 *   ozone tent centred at 25 km, half-width 15 km, β = (0.650, 1.881, 0.085)e-3
 */

const GLSL_COMMON = /* glsl */ `
  const float Rg = 6360.0;
  const float Rt = 6460.0;
  const vec3  BETA_R   = vec3( 5.802e-3, 13.558e-3, 33.1e-3 );
  const float BETA_M_S = 3.996e-3;
  const float BETA_M_A = 4.4e-3;
  const vec3  BETA_O   = vec3( 0.650e-3, 1.881e-3, 0.085e-3 );
  const float H_R = 8.0;
  const float H_M = 1.2;
  const float PI = 3.14159265358979;

  // scattering/extinction coefficients at height h (km above ground)
  void mediumSample( float h, out vec3 sR, out float sM, out vec3 extinction ) {
    float dR = exp( -h / H_R );
    float dM = exp( -h / H_M );
    float dO = max( 0.0, 1.0 - abs( h - 25.0 ) / 15.0 ); // ozone tent
    sR = BETA_R * dR;
    sM = BETA_M_S * dM;
    extinction = sR + vec3( ( BETA_M_S + BETA_M_A ) * dM ) + BETA_O * dO;
  }

  // distance to sphere of radius r (centre = planet origin); -1 if missed
  float raySphere( vec3 ro, vec3 rd, float r ) {
    float b = dot( ro, rd );
    float c = dot( ro, ro ) - r * r;
    float h = b * b - c;
    if ( h < 0.0 ) return -1.0;
    h = sqrt( h );
    float t = -b - h;
    if ( t > 0.0 ) return t;
    t = -b + h;
    return t > 0.0 ? t : -1.0;
  }

  // optical depth toward the sun (used for transmittance)
  vec3 sunTransmittance( vec3 p, vec3 sunDir ) {
    float tTop = raySphere( p, sunDir, Rt );
    if ( raySphere( p, sunDir, Rg ) > 0.0 ) return vec3( 0.0 ); // planet shadow
    const int N = 12;
    float seg = tTop / float( N );
    vec3 od = vec3( 0.0 );
    for ( int i = 0; i < N; i++ ) {
      vec3 sp = p + sunDir * ( ( float( i ) + 0.5 ) * seg );
      float h = length( sp ) - Rg;
      vec3 sR; float sM; vec3 ext;
      mediumSample( h, sR, sM, ext );
      od += ext * seg;
    }
    return exp( -od );
  }

  float phaseRayleigh( float mu ) {
    return 3.0 / ( 16.0 * PI ) * ( 1.0 + mu * mu );
  }
  float phaseMie( float mu ) {
    const float g = 0.8;
    float d = 1.0 + g * g - 2.0 * g * mu;
    return 3.0 / ( 8.0 * PI ) * ( 1.0 - g * g ) * ( 1.0 + mu * mu )
         / ( ( 2.0 + g * g ) * d * sqrt( d ) );
  }
`;

const VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize( position );
    vec4 mv = modelViewMatrix * vec4( position, 1.0 );
    gl_Position = projectionMatrix * mv;
    gl_Position.z = gl_Position.w; // far plane
  }
`;

const FRAG = /* glsl */ `
  varying vec3 vDir;
  uniform vec3  uSunDir;
  uniform float uSunIntensity;
  uniform vec3  uPsiMS;        // isotropic multiple-scattering (CPU-integrated)
  uniform float uGroundAlbedo;

  ${GLSL_COMMON}

  vec3 skyRadiance( vec3 rd, vec3 sunDir ) {
    vec3 ro = vec3( 0.0, Rg + 0.002, 0.0 );
    float tGround = raySphere( ro, rd, Rg );
    float tTop = raySphere( ro, rd, Rt );
    float tMax = tGround > 0.0 ? tGround : tTop;

    float mu = dot( rd, sunDir );
    float phR = phaseRayleigh( mu );
    float phM = phaseMie( mu );

    const int N = 32;
    float seg = tMax / float( N );
    vec3 L = vec3( 0.0 );
    vec3 T = vec3( 1.0 );

    for ( int i = 0; i < N; i++ ) {
      vec3 p = ro + rd * ( ( float( i ) + 0.5 ) * seg );
      float h = length( p ) - Rg;
      vec3 sR; float sM; vec3 ext;
      mediumSample( h, sR, sM, ext );

      vec3 sampleT = exp( -ext * seg );
      vec3 sunT = sunTransmittance( p, sunDir );

      // in-scatter: single (phase-weighted) + isotropic multiple scattering
      vec3 S = ( sR * phR + vec3( sM * phM ) ) * sunT
             + ( sR + vec3( sM ) ) * uPsiMS;

      // energy-conserving integration over the segment
      L += T * ( S - S * sampleT ) / ext;
      T *= sampleT;
    }

    // ground bounce when the ray hits the planet
    if ( tGround > 0.0 ) {
      vec3 gp = ro + rd * tGround;
      vec3 gn = normalize( gp );
      vec3 sunT = sunTransmittance( gp, uSunDir );
      float ndl = max( dot( gn, sunDir ), 0.0 );
      L += T * vec3( uGroundAlbedo / PI ) * sunT * ndl;
    }

    return L * uSunIntensity;
  }

  void main() {
    vec3 rd = normalize( vDir );
    vec3 col = skyRadiance( rd, uSunDir );

    // sun disc: angular radius 0.267 deg, limb darkening, transmittance tint
    float cosSun = dot( rd, uSunDir );
    float ang = acos( clamp( cosSun, -1.0, 1.0 ) );
    const float SUN_R = 0.004675; // radians
    if ( ang < SUN_R * 1.6 && raySphere( vec3( 0.0, Rg + 0.002, 0.0 ), rd, Rg ) < 0.0 ) {
      vec3 ro = vec3( 0.0, Rg + 0.002, 0.0 );
      vec3 T = sunTransmittance( ro, rd );
      float r = ang / SUN_R;
      float limb = sqrt( max( 0.0, 1.0 - r * r * 0.9 ) );          // limb darkening
      float edge = 1.0 - smoothstep( 0.92, 1.0, r );               // crisp rim
      col += T * uSunIntensity * 120.0 * edge * ( 0.6 + 0.4 * limb );
    }

    gl_FragColor = vec4( col, 1.0 );
  }
`;

// ── JS twins (same math, coarse steps) for light/fog/ambient colors ─────────
const Rg = 6360;
const Rt = 6460;
const BETA_R = [5.802e-3, 13.558e-3, 33.1e-3];
const BETA_M_S = 3.996e-3;
const BETA_M_A = 4.4e-3;
const BETA_O = [0.650e-3, 1.881e-3, 0.085e-3];
const H_R = 8;
const H_M = 1.2;

function medium(h: number): { sR: number[]; sM: number; ext: number[] } {
  const dR = Math.exp(-h / H_R);
  const dM = Math.exp(-h / H_M);
  const dO = Math.max(0, 1 - Math.abs(h - 25) / 15);
  const sR = BETA_R.map((b) => b * dR);
  const sM = BETA_M_S * dM;
  const ext = sR.map((s, i) => s + (BETA_M_S + BETA_M_A) * dM + BETA_O[i] * dO);
  return { sR, sM, ext };
}

function raySphereJS(ro: number[], rd: number[], r: number): number {
  const b = ro[0] * rd[0] + ro[1] * rd[1] + ro[2] * rd[2];
  const c = ro[0] ** 2 + ro[1] ** 2 + ro[2] ** 2 - r * r;
  let h = b * b - c;
  if (h < 0) return -1;
  h = Math.sqrt(h);
  let t = -b - h;
  if (t > 0) return t;
  t = -b + h;
  return t > 0 ? t : -1;
}

function sunTransmittanceJS(p: number[], sun: number[]): number[] {
  if (raySphereJS(p, sun, Rg) > 0) return [0, 0, 0];
  const tTop = raySphereJS(p, sun, Rt);
  const N = 16;
  const seg = tTop / N;
  const od = [0, 0, 0];
  for (let i = 0; i < N; i++) {
    const sp = [p[0] + sun[0] * (i + 0.5) * seg, p[1] + sun[1] * (i + 0.5) * seg, p[2] + sun[2] * (i + 0.5) * seg];
    const h = Math.hypot(sp[0], sp[1], sp[2]) - Rg;
    const { ext } = medium(h);
    od[0] += ext[0] * seg;
    od[1] += ext[1] * seg;
    od[2] += ext[2] * seg;
  }
  return od.map((o) => Math.exp(-o));
}

/**
 * Isotropic multiple-scattering term Ψms (Hillaire eq. 10 approximation):
 * integrate 2nd-order in-scatter over the sphere at ground level, then
 * amplify by the geometric series 1/(1-f_ms).
 */
function computePsiMS(sun: number[]): THREE.Vector3 {
  const ro = [0, Rg + 0.002, 0];
  const DIRS = 8;
  const lum = [0, 0, 0];
  const fms = [0, 0, 0];
  for (let d = 0; d < DIRS; d++) {
    // Fibonacci sphere directions
    const y = 1 - (2 * (d + 0.5)) / DIRS;
    const r = Math.sqrt(1 - y * y);
    const a = d * 2.399963;
    const rd = [r * Math.cos(a), y, r * Math.sin(a)];
    const tG = raySphereJS(ro, rd, Rg);
    const tMax = tG > 0 ? tG : raySphereJS(ro, rd, Rt);
    const N = 12;
    const seg = tMax / N;
    const T = [1, 1, 1];
    const mu = rd[0] * sun[0] + rd[1] * sun[1] + rd[2] * sun[2];
    const phR = (3 / (16 * Math.PI)) * (1 + mu * mu);
    const g = 0.8;
    const dd = 1 + g * g - 2 * g * mu;
    const phM = ((3 / (8 * Math.PI)) * ((1 - g * g) * (1 + mu * mu))) / ((2 + g * g) * dd * Math.sqrt(dd));
    for (let i = 0; i < N; i++) {
      const p = [ro[0] + rd[0] * (i + 0.5) * seg, ro[1] + rd[1] * (i + 0.5) * seg, ro[2] + rd[2] * (i + 0.5) * seg];
      const h = Math.hypot(p[0], p[1], p[2]) - Rg;
      const { sR, sM, ext } = medium(h);
      const sunT = sunTransmittanceJS(p, sun);
      for (let k = 0; k < 3; k++) {
        const sampleT = Math.exp(-ext[k] * seg);
        const S = (sR[k] * phR + sM * phM) * sunT[k];
        const Sf = sR[k] + sM; // isotropic re-scatter potential
        lum[k] += (T[k] * (S - S * sampleT)) / ext[k] / DIRS;
        fms[k] += (T[k] * (Sf - Sf * sampleT)) / ext[k] / DIRS;
        T[k] *= sampleT;
      }
    }
  }
  return new THREE.Vector3(
    lum[0] / (1 - Math.min(0.99, fms[0])),
    lum[1] / (1 - Math.min(0.99, fms[1])),
    lum[2] / (1 - Math.min(0.99, fms[2])),
  );
}

/** Sky radiance toward rd — coarse CPU twin for fog/ambient tints. */
function skyRadianceJS(rd: number[], sun: number[], psi: THREE.Vector3, intensity: number): THREE.Color {
  const ro = [0, Rg + 0.002, 0];
  const tG = raySphereJS(ro, rd, Rg);
  const tMax = tG > 0 ? tG : raySphereJS(ro, rd, Rt);
  const N = 16;
  const seg = tMax / N;
  const mu = rd[0] * sun[0] + rd[1] * sun[1] + rd[2] * sun[2];
  const phR = (3 / (16 * Math.PI)) * (1 + mu * mu);
  const g = 0.8;
  const dd = 1 + g * g - 2 * g * mu;
  const phM = ((3 / (8 * Math.PI)) * ((1 - g * g) * (1 + mu * mu))) / ((2 + g * g) * dd * Math.sqrt(dd));
  const L = [0, 0, 0];
  const T = [1, 1, 1];
  const psiArr = [psi.x, psi.y, psi.z];
  for (let i = 0; i < N; i++) {
    const p = [ro[0] + rd[0] * (i + 0.5) * seg, ro[1] + rd[1] * (i + 0.5) * seg, ro[2] + rd[2] * (i + 0.5) * seg];
    const h = Math.hypot(p[0], p[1], p[2]) - Rg;
    const { sR, sM, ext } = medium(h);
    const sunT = sunTransmittanceJS(p, sun);
    for (let k = 0; k < 3; k++) {
      const sampleT = Math.exp(-ext[k] * seg);
      const S = (sR[k] * phR + sM * phM) * sunT[k] + (sR[k] + sM) * psiArr[k];
      L[k] += (T[k] * (S - S * sampleT)) / ext[k];
      T[k] *= sampleT;
    }
  }
  return new THREE.Color(L[0] * intensity, L[1] * intensity, L[2] * intensity);
}

// ── component ────────────────────────────────────────────────────────────────
export class SkyAtmosphere {
  readonly skyMesh: THREE.Mesh;
  readonly sunLight: THREE.DirectionalLight;
  /** normalized, toward the sun */
  readonly sunDir = new THREE.Vector3(0, 1, 0);
  /** transmittance-tinted sun color (linear) */
  readonly sunColor = new THREE.Color(1, 1, 1);
  readonly zenithColor = new THREE.Color(0.2, 0.4, 0.8);
  readonly horizonColor = new THREE.Color(0.7, 0.8, 0.9);

  sunIntensity = 7.5;

  private uniforms = {
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunIntensity: { value: 7.5 },
    uPsiMS: { value: new THREE.Vector3(0, 0, 0) },
    uGroundAlbedo: { value: 0.3 },
  };
  private envRT: THREE.WebGLRenderTarget | null = null;

  constructor(private renderer: THREE.WebGLRenderer) {
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: this.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
    });
    this.skyMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), mat);
    this.skyMesh.scale.setScalar(1000);
    this.skyMesh.frustumCulled = false;

    this.sunLight = new THREE.DirectionalLight(0xffffff, 1);
    this.sunLight.castShadow = true;
  }

  /** Point the sun (degrees) and re-derive light color, IBL and tints. */
  setSun(elevationDeg: number, azimuthDeg: number, scene: THREE.Scene, sunLightIntensity = 4.0): void {
    const el = THREE.MathUtils.degToRad(elevationDeg);
    const az = THREE.MathUtils.degToRad(azimuthDeg);
    this.sunDir.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).normalize();
    this.uniforms.uSunDir.value.copy(this.sunDir);
    this.uniforms.uSunIntensity.value = this.sunIntensity;

    const sunArr = this.sunDir.toArray();
    this.uniforms.uPsiMS.value.copy(computePsiMS(sunArr));

    // directional light: transmittance-tinted
    const t = sunTransmittanceJS([0, Rg + 0.002, 0], sunArr);
    this.sunColor.setRGB(t[0], t[1], t[2]);
    this.sunLight.color.copy(this.sunColor);
    this.sunLight.intensity = sunLightIntensity;
    this.sunLight.position.copy(this.sunDir).multiplyScalar(120);

    // tints for fog & friends
    const psi = this.uniforms.uPsiMS.value;
    this.zenithColor.copy(skyRadianceJS([0, 1, 0], sunArr, psi, this.sunIntensity));
    const hor = new THREE.Color(0, 0, 0);
    for (const a of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      hor.add(skyRadianceJS([Math.sin(az + a) * 0.999, 0.045, Math.cos(az + a) * 0.999], sunArr, psi, this.sunIntensity));
    }
    hor.multiplyScalar(0.25);
    this.horizonColor.copy(hor);

    this.refreshIBL(scene);
  }

  /** SkyLight: PMREM-capture the shader sky for image-based lighting. */
  private refreshIBL(scene: THREE.Scene): void {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const skyScene = new THREE.Scene();
    const clone = new THREE.Mesh(this.skyMesh.geometry, this.skyMesh.material);
    clone.scale.setScalar(100);
    skyScene.add(clone);
    this.envRT?.dispose();
    this.envRT = pmrem.fromScene(skyScene, 0, 1, 200);
    scene.environment = this.envRT.texture;
    pmrem.dispose();
  }

  configureShadows(halfExtent = 24, far = 260): void {
    const cam = this.sunLight.shadow.camera;
    cam.left = -halfExtent;
    cam.right = halfExtent;
    cam.top = halfExtent;
    cam.bottom = -halfExtent;
    cam.near = 1;
    cam.far = far;
    cam.updateProjectionMatrix();
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.bias = -0.0002;
    this.sunLight.shadow.normalBias = 0.02;
  }
}
