import * as THREE from 'three/webgpu';
import { Discard, Fn, abs, cameraFar, cameraNear, cameraPosition, clamp, dot, exp, float, fwidth, max, mix, mx_fractal_noise_float, mx_noise_float, mx_worley_noise_vec2, normalWorld, normalize, perspectiveDepthToViewZ, pmremTexture, positionLocal, positionView, positionWorld, reflect, screenUV, select, smoothstep, texture, transformNormalToView, uniform, uv, vec2, vec3, vec4, } from 'three/tsl';
import type { IslandField } from '../island/heightField.ts';
import { WATER_ABSORB } from './medium.ts';
import { SurfaceField } from './surfaceField.ts';
import { Spray } from './spray.ts';
import { ShallowWater } from './shallowWater.ts';
import { WorkerWaterSim } from './simHost.ts';
import type { WaterSim } from './waterSim.ts';
import { WaterInspector } from './waterInspector.ts';
import type { WindWaveOptions } from './windWaves.ts';
import { OceanSpectrum } from './oceanSpectrum.ts';
import { OceanDetail } from './oceanDetail.ts';
import { SEAWATER_INDEX_550_NM } from './physicsReference.ts';
import { WaterReflection } from './planarReflection.ts';
import { waterRefraction } from './refraction.ts';
import { WaterTransmission } from './transmission.ts';
import { WaterRayScene } from './rayScene.ts';
import { SurfaceRaycaster } from './surfaceRaycaster.ts';
import { WaveReflectionPass } from './waveReflectionPass.ts';
import { visibleWaterNormal } from './visibleNormal.ts';
import { If, cross, dFdx, dFdy } from 'three/tsl';
export interface WaterOptions {
    rayScene: WaterRayScene;
    spectrum?: WindWaveOptions;
    maximumWaveHeight?: number;
    inverseWaveAge?: number;
    renderer: THREE.WebGPURenderer;
    field: IslandField;
    environment: THREE.Texture;
    sun: THREE.DirectionalLight;
    cutDepth?: number;
    bathymetry?: THREE.Texture;
    simulationFrames?: number;
    offThread?: boolean;
}
class SolverBed {
    private grid: Float32Array | null = null;
    private size = 0;
    private reading = false;
    constructor(private readonly renderer: THREE.WebGPURenderer, private readonly bathymetry: THREE.Texture, private readonly field: IslandField) { }
    request(): void {
        const target = this.bathymetry.userData.renderTarget as THREE.RenderTarget | undefined;
        if (this.grid || this.reading || !target)
            return;
        this.reading = true;
        setTimeout(() => {
            void this.renderer.readRenderTargetPixelsAsync(target, 0, 0, target.width, target.height).then((raw) => {
                const decode = raw instanceof Uint16Array ? (v: number) => THREE.DataUtils.fromHalfFloat(v) : (v: number) => v;
                const grid = new Float32Array(target.width * target.height);
                for (let i = 0; i < grid.length; i++)
                    grid[i] = decode(raw[i * 4]);
                this.size = target.width;
                this.grid = grid;
            }).catch(() => undefined);
        }, 0);
    }
    at(x: number, z: number): number {
        const { grid, size } = this;
        if (!grid)
            return this.field.obstacleHeight(x, z);
        const half = this.field.half;
        const i = Math.max(0, Math.min(size - 1, Math.round(((x + half) / (2 * half)) * size - 0.5)));
        const j = Math.max(0, Math.min(size - 1, Math.round(((z + half) / (2 * half)) * size - 0.5)));
        return grid[j * size + i];
    }
}
export interface WaterFields {
    sampleSurface(x: number, z: number): Promise<{
        eta: number;
        slopeX: number;
        slopeZ: number;
    }>;
    bedAt(x: number, z: number): number;
    waterLevel: number;
    half: number;
}
export interface Water {
    reflection: WaterReflection;
    transmission: WaterTransmission;
    renderReflections(camera: THREE.Camera): void;
    group: THREE.Group;
    fields: WaterFields;
    onStep: ((simDelta: number) => void) | null;
    uniforms: {
        waveStrength: ReturnType<typeof uniform>;
        absorb: ReturnType<typeof uniform>;
        scatter: ReturnType<typeof uniform>;
        scatterStrength: ReturnType<typeof uniform>;
        envStrength: ReturnType<typeof uniform>;
        foamStrength: ReturnType<typeof uniform>;
        causticStrength: ReturnType<typeof uniform>;
        refractionStrength: ReturnType<typeof uniform>;
        sunColor: ReturnType<typeof uniform>;
        sunDir: ReturnType<typeof uniform>;
        scatteringCoefficient: ReturnType<typeof uniform>;
        sunIrradiance: ReturnType<typeof uniform>;
    };
    bindScreen(color: THREE.Texture, depth: THREE.Texture, normal: THREE.Texture): void;
    controls: {
        swellAmplitude: number;
        swellPeriod: number;
        swellDirection: number;
        windSpeed: number;
        windDirection: number;
        manning: number;
        apply(): void;
    };
    update(elapsedSeconds: number): void;
    setRunning(running: boolean): void;
    ready: Promise<void>;
    onField?: (field: THREE.Texture) => void;
    readFoamField(): Promise<{
        size: number;
        foam: Float32Array;
        wetness: Float32Array;
    }>;
}
export function createWater(options: WaterOptions): Water {
    const { renderer, field, environment, sun, cutDepth = 3.0, bathymetry, simulationFrames = Infinity, offThread = true } = options;
    let stepsLeft = simulationFrames;
    const half = field.half;
    const heightTexture = bathymetry ?? field.toTexture(512);
    if (!bathymetry)
        heightTexture.name = 'islandHeight';
    const sandTexture = field.toTexture(128, true);
    sandTexture.name = 'islandSand';
    const uniforms = {
        waveStrength: uniform(1),
        absorb: uniform(WATER_ABSORB.clone()),
        scatter: uniform(new THREE.Color(0.012, 0.10, 0.10)),
        scatterStrength: uniform(1.0),
        envStrength: uniform(1),
        foamStrength: uniform(1.0),
        causticStrength: uniform(1.0),
        refractionStrength: uniform(0.12),
        sunColor: uniform(new THREE.Color(1, 0.95, 0.85)),
        sunDir: uniform(new THREE.Vector3(0, 1, 0)),
        scatteringCoefficient: uniform(new THREE.Vector3(0.035, 0.035, 0.035)),
        sunIrradiance: uniform(new THREE.Color()),
    };
    const waterLevel = uniform(field.waterLevel);
    const planarReflection = new WaterReflection(field.waterLevel);
    const transmission = new WaterTransmission(field.waterLevel);
    const slabHalf = uniform(half);
    const params = new URLSearchParams(window.location.search);
    const debugMode = params.get('waterDebug');
    const faceDepth = { x: 0, z: 0 };
    for (let k = 0; k < 64; k++) {
        const s = -half + ((k + 0.5) / 64) * 2 * half;
        faceDepth.x += Math.max(0, field.waterLevel - field.obstacleHeight(-half + 0.05, s)) / 64;
        faceDepth.z += Math.max(0, field.waterLevel - field.obstacleHeight(s, half - 0.05)) / 64;
    }
    const SIM_SIZE = 384;
    const PREROLL_SECONDS = 6.0;
    const simSetup = { renderer, bathymetry: heightTexture, half, waterLevel: field.waterLevel, size: SIM_SIZE, faceDepth };
    const workerSim = offThread ? new WorkerWaterSim({ ...simSetup, swellAmplitude: 0.06, swellPeriod: 3.2, swellDirection: Math.atan2(-1, 1), prerollSeconds: PREROLL_SECONDS }) : null;
    const sim: WaterSim = workerSim ?? new ShallowWater(simSetup);
    const windSpeed = Number(params.get('wind') ?? options.spectrum?.windSpeed ?? 4.5);
    const geometryWavelength = Math.max(half * 16 / 512, options.spectrum?.minWavelength ?? 0.07);
    const wind = new OceanSpectrum({ windSpeed: Number.isFinite(windSpeed) ? windSpeed : 4.5, longestWave: half * 2, geometryWavelength, depth: options.spectrum?.referenceDepth ?? 1.2, inverseWaveAge: options.inverseWaveAge ?? 1 });
    const oceanDetail = new OceanDetail({ renderer, clock: wind.clock, windSpeed: wind.windSpeed, windDirection: wind.windDirection, inverseWaveAge: options.inverseWaveAge ?? 1, depth: options.spectrum?.referenceDepth ?? 1.2, longestWavelength: geometryWavelength, domainLength: 2 * half });
    const windCap = options.maximumWaveHeight ?? 0.12;
    if (!workerSim)
        (sim as ShallowWater).preroll(PREROLL_SECONDS);
    const sandHeight = Fn(([xz]: [
        ReturnType<typeof vec2>
    ]) => {
        const uvCoord = xz.div(slabHalf).mul(0.5).add(0.5);
        return texture(heightTexture, uvCoord).r;
    });
    const rimMask = Fn(([xz]: [
        ReturnType<typeof vec2>
    ]) => {
        const edge = max(abs(xz.x), abs(xz.y));
        return smoothstep(slabHalf, slabHalf.sub(0.06), edge);
    });
    const simBase = Fn(([xz]: [
        ReturnType<typeof vec2>
    ]) => {
        const q = sim.uvOf(xz) as unknown as ReturnType<typeof vec2>;
        const h = float(0.5 / sim.size);
        const etaTap = (o: ReturnType<typeof vec2>) => {
            const uv = q.add(o);
            const d = ((sim.stateNode.sample(uv) as typeof sim.stateNode).level(float(0.0)) as ReturnType<typeof vec4>).r;
            const b = (texture(heightTexture, uv).level(float(0.0)) as ReturnType<typeof vec4>).r;
            return b.add(d);
        };
        return etaTap(vec2(h, h)).add(etaTap(vec2(h.negate(), h))).add(etaTap(vec2(h, h.negate()))).add(etaTap(vec2(h.negate(), h.negate()))).mul(0.25);
    });
    const windAt = Fn(([xz]: [
        ReturnType<typeof vec2>
    ]) => {
        const depth = waterLevel.sub(sandHeight(xz));
        const alive = smoothstep(0.0, 0.08, depth).mul(rimMask(xz));
        return oceanDetail.geometry(xz).mul(alive);
    });
    const filmAt = Fn(([xz]: [
        ReturnType<typeof vec2>
    ]) => {
        const n = float(sim.size);
        const tc = (sim.uvOf(xz) as unknown as ReturnType<typeof vec2>).mul(n).sub(0.5);
        const base = tc.floor();
        const f = tc.sub(base);
        const weights = (t: ReturnType<typeof float>) => {
            const t2 = t.mul(t);
            const t3 = t2.mul(t);
            return [
                float(1.0).sub(t).pow(3.0).div(6.0),
                t3.mul(3.0).sub(t2.mul(6.0)).add(4.0).div(6.0),
                t3.mul(-3.0).add(t2.mul(3.0)).add(t.mul(3.0)).add(1.0).div(6.0),
                t3.div(6.0),
            ];
        };
        const wx = weights(f.x);
        const wz = weights(f.y);
        const sum = float(0.0).toVar();
        for (let j = 0; j < 4; j++) {
            for (let i = 0; i < 4; i++) {
                const tap = base.add(vec2(i - 1, j - 1)).add(0.5).div(n);
                const d = ((sim.stateNode.sample(tap as unknown as ReturnType<typeof vec2>) as typeof sim.stateNode).level(float(0.0)) as ReturnType<typeof vec4>).r;
                sum.addAssign(d.mul(wx[i]).mul(wz[j]));
            }
        }
        return sum;
    });
    const surface = new SurfaceField({ renderer, size: 512, half, waterLevel: field.waterLevel, simHeight: simBase, wind: windAt, rim: rimMask, windCap, film: filmAt as unknown as (xz: THREE.Node) => THREE.Node });
    const surfaceRays = new SurfaceRaycaster(surface.node.value, 512, half, field.waterLevel, uniforms.waveStrength);
    let waveReflectionPass: WaveReflectionPass | undefined;
    const fieldAt = (xz: THREE.Node) => (surface.node.sample(surface.uvOf(xz) as unknown as ReturnType<typeof vec2>) as typeof surface.node).level(float(0.0)) as unknown as ReturnType<typeof vec4>;
    const caustic = Fn(([xz, depth]: [
        ReturnType<typeof vec2>,
        ReturnType<typeof float>
    ]) => {
        const t = wind.clock;
        const q1 = vec3(xz.x.mul(6.5).add(t.mul(0.12)), xz.y.mul(6.5).sub(t.mul(0.09)), t.mul(0.30));
        const q2 = vec3(xz.x.mul(9.0).sub(t.mul(0.08)), xz.y.mul(9.0).add(t.mul(0.13)), t.mul(0.24).add(5.0));
        const w1 = mx_worley_noise_vec2(q1, 1.0);
        const w2 = mx_worley_noise_vec2(q2, 1.0);
        const line1 = smoothstep(0.10, 0.0, w1.y.sub(w1.x));
        const line2 = smoothstep(0.10, 0.0, w2.y.sub(w2.x));
        const filaments = line1.mul(0.6).add(line2.mul(0.6)).add(line1.mul(line2).mul(1.8)).sub(0.45).mul(0.55);
        const fade = smoothstep(0.0, 0.05, depth).mul(exp(depth.mul(-1.5)));
        return filaments.mul(fade);
    });
    const FOAM_SIZE = 1024;
    const makeFoamTarget = () => {
        const target = new THREE.RenderTarget(FOAM_SIZE, FOAM_SIZE, {
            type: THREE.HalfFloatType,
            format: THREE.RGBAFormat,
            depthBuffer: false,
            generateMipmaps: true,
        });
        target.texture.minFilter = THREE.LinearMipmapLinearFilter;
        target.texture.magFilter = THREE.LinearFilter;
        target.texture.wrapS = target.texture.wrapT = THREE.ClampToEdgeWrapping;
        return target;
    };
    let foamRead = makeFoamTarget();
    let foamWrite = makeFoamTarget();
    const foamPrev = texture(foamRead.texture);
    const foamField = texture(foamRead.texture);
    const foamDt = uniform(1 / 60);
    const foamDecaySeconds = uniform(2.8);
    const foamSim = new THREE.MeshBasicNodeMaterial();
    foamSim.name = 'lagoonFoamField';
    foamSim.blending = THREE.NoBlending;
    foamSim.depthTest = false;
    foamSim.depthWrite = false;
    foamSim.toneMapped = false;
    foamSim.fragmentNode = Fn(() => {
        const q = uv();
        const waveMotion = vec3(oceanDetail.transport(q.sub(0.5).mul(2 * half))).mul(uniforms.waveStrength);
        const flow: THREE.Node = sim.stateNode.sample(q).gb.add(waveMotion.xy).mul(foamDt);
        const from = q.sub((flow as ReturnType<typeof vec2>).div(slabHalf.mul(2.0)));
        const texel = float(1.5 / FOAM_SIZE);
        const center = foamPrev.sample(from).r;
        const laplacian = foamPrev.sample(from.add(vec2(texel, 0.0))).r
            .add(foamPrev.sample(from.sub(vec2(texel, 0.0))).r)
            .add(foamPrev.sample(from.add(vec2(0.0, texel))).r)
            .add(foamPrev.sample(from.sub(vec2(0.0, texel))).r).sub(center.mul(4));
        const spread = center.add(laplacian.mul(foamDt.mul(0.02 / (3 * half / FOAM_SIZE) ** 2).min(0.24)));
        const depthHere = sim.stateNode.sample(q).r;
        const onWater = smoothstep(0.0008, 0.004, depthHere);
        const tauWet = mix(float(1.5), foamDecaySeconds, smoothstep(0.01, 0.08, depthHere));
        const tau = mix(float(0.5), tauWet, onWater);
        const decayed = spread.mul(exp(foamDt.negate().div(tau)));
        const crest = sim.stateNode.sample(q).a;
        const whitecap = smoothstep(oceanDetail.breakingThreshold, oceanDetail.breakingThreshold.add(oceanDetail.breakingWidth), waveMotion.z.negate()).mul(onWater);
        const foam = max(max(decayed, crest.mul(0.85)), whitecap);
        const standing = smoothstep(0.0005, 0.005, sim.stateNode.sample(q).r);
        const wt = float(0.6 / FOAM_SIZE);
        const wetPrev = foamPrev.sample(q).g.mul(0.4)
            .add(foamPrev.sample(q.add(vec2(wt, 0.0))).g.mul(0.15))
            .add(foamPrev.sample(q.sub(vec2(wt, 0.0))).g.mul(0.15))
            .add(foamPrev.sample(q.add(vec2(0.0, wt))).g.mul(0.15))
            .add(foamPrev.sample(q.sub(vec2(0.0, wt))).g.mul(0.15));
        const wetness = max(standing, wetPrev.mul(exp(foamDt.negate().div(28.0))));
        const state = sim.stateNode.sample(q);
        const tb = float(1.0 / 512);
        const bL = texture(heightTexture, q.sub(vec2(tb, 0.0))).r;
        const bR = texture(heightTexture, q.add(vec2(tb, 0.0))).r;
        const bB = texture(heightTexture, q.sub(vec2(0.0, tb))).r;
        const bF = texture(heightTexture, q.add(vec2(0.0, tb))).r;
        const gradB = vec2(bR.sub(bL), bF.sub(bB)).div(float(2 * (2 * half) / 512));
        const climb = state.g.mul(gradB.x).add(state.b.mul(gradB.y));
        const steep = smoothstep(0.6, 1.4, gradB.length());
        const flowStep = vec2(state.g, state.b).div(max(vec2(state.g, state.b).length(), 1e-3)).mul(tb);
        const bedAhead = max(max(texture(heightTexture, q.add(flowStep.mul(3.0))).r, texture(heightTexture, q.add(flowStep.mul(7.0))).r), texture(heightTexture, q.add(flowStep.mul(12.0))).r);
        const emergent = smoothstep(-0.06, 0.0, bedAhead.sub(waterLevel));
        const impact = smoothstep(0.3, 1.2, climb).mul(steep).mul(smoothstep(0.01, 0.05, state.r)).mul(emergent);
        const foamOut = max(foam, impact.mul(0.9));
        return vec4(foamOut, wetness, impact, foamOut.mul(float(1.0).sub(onWater)));
    })();
    const foamQuad = new THREE.QuadMesh(foamSim);
    const spray = new Spray({ renderer, half, waterLevel: field.waterLevel, foamField, simState: sim.stateNode, surface: surface.node, sunDir: uniforms.sunDir, sunColor: uniforms.sunColor, test: Number(params.get('sprayTest') ?? 0) });
    const stepFoam = (dt: number) => {
        if (dt <= 0) return;
        foamDt.value = dt;
        foamPrev.value = foamRead.texture;
        const previousTarget = renderer.getRenderTarget();
        renderer.setRenderTarget(foamWrite);
        foamQuad.render(renderer);
        renderer.setRenderTarget(previousTarget);
        const swap = foamRead;
        foamRead = foamWrite;
        foamWrite = swap;
        foamField.value = foamRead.texture;
        sim.setSaturation(foamRead.texture);
        water.onField?.(foamRead.texture);
    };
    function buildMaterial(screen: {
        color: THREE.Texture;
        depth: THREE.Texture;
        normal: THREE.Texture;
    }, top: boolean): THREE.MeshStandardNodeMaterial {
        const material = new THREE.MeshStandardNodeMaterial();
        material.name = top ? 'lagoonWaterSurface' : 'lagoonWaterCut';
        material.transparent = false;
        material.side = THREE.FrontSide;
        material.color = new THREE.Color(0.02, 0.1, 0.12);
        material.metalness = 0;
        material.roughness = 0.07;
        material.colorNode = vec3(0.0);
        material.metalnessNode = float(0.0);
        const p = positionWorld;
        const t = wind.clock;
        if (!top) {
            const ride = smoothstep(waterLevel.sub(0.4), waterLevel, positionLocal.y);
            material.positionNode = positionLocal.add(vec3(0.0, fieldAt(positionLocal.xz).x.add(0.004).mul(ride), 0.0));
        }
        if (top) {
            material.positionNode = vec3(positionLocal.x, waterLevel.add(fieldAt(positionLocal.xz).x.mul(uniforms.waveStrength)).add(0.0005), positionLocal.z);
        }
        const micro = top ? oceanDetail.sample(p.xz) : vec3(0);
        const nWorld = Fn(() => {
            if (!top)
                return normalWorld;
            const slope = surface.node.sample(surface.uvOf(p.xz)).yz.add(micro.xy).mul(uniforms.waveStrength);
            const shading = normalize(vec3(slope.x.negate(), 1.0, slope.y.negate()));
            const geometric = normalize(cross(dFdx(p), dFdy(p)));
            return visibleWaterNormal({ shading, geometric: select(geometric.y.lessThan(0), geometric.negate(), geometric), view: normalize(cameraPosition.sub(p)) });
        })();
        const nView = transformNormalToView(nWorld);
        material.normalNode = nView;
        const roughness = top ? micro.z.mul(uniforms.waveStrength.pow(2)).add(0.00000625).pow(0.25).clamp(0.05, 0.5) : float(0.1);
        material.roughnessNode = roughness;
        const viewZ = positionView.z;
        const depthAt = (uvNode: THREE.Node) => texture(screen.depth, uvNode as ReturnType<typeof vec2>).x;
        const sceneDepth0 = depthAt(screenUV);
        const sceneZ0 = perspectiveDepthToViewZ(sceneDepth0, cameraNear, cameraFar);
        const behindScene = viewZ.sub(sceneZ0).lessThan(-0.06);
        const screenRefraction = waterRefraction(screen, nWorld, waterLevel, slabHalf);
        const { floor0 } = screenRefraction;
        const { floorWorld, pathLength, verticalDepth, sceneColor } = top ? transmission.sample(p, nWorld, slabHalf) : screenRefraction;
        const sunDir = vec3(uniforms.sunDir);
        const sunUp = clamp(sunDir.y, 0.0, 1.0);
        const sunLight = vec3(uniforms.sunColor).mul(sunUp.mul(1.6).add(0.5));
        const causticMask = Fn(() => {
            const value = float(0).toVar();
            If(uniforms.causticStrength.greaterThan(0), () => { value.assign(caustic(floorWorld.xz, verticalDepth).mul(sunUp)); });
            return value;
        })();
        const transmittance = exp(vec3(uniforms.absorb).add(uniforms.scatteringCoefficient).mul(pathLength).negate());
        const scatterAmount = float(1.0).sub(exp(pathLength.mul(-0.3)));
        const scatter = vec3(uniforms.scatter).mul(0.5).mul(scatterAmount).mul(uniforms.scatterStrength);
        const viewDir = normalize(p.sub(cameraPosition));
        const reflected = reflect(viewDir, nWorld);
        const reflectedUp = vec3(reflected.x, abs(reflected.y), reflected.z);
        const sky = pmremTexture(environment, reflectedUp, roughness).rgb;
        const cosTheta = clamp(dot(nWorld, viewDir.negate()), 0.0, 1.0);
        const transmittedCosine = float(1).sub(float(1).sub(cosTheta.pow(2)).div(SEAWATER_INDEX_550_NM ** 2)).sqrt();
        const rs = cosTheta.sub(transmittedCosine.mul(SEAWATER_INDEX_550_NM)).div(cosTheta.add(transmittedCosine.mul(SEAWATER_INDEX_550_NM)));
        const rp = cosTheta.mul(SEAWATER_INDEX_550_NM).sub(transmittedCosine).div(cosTheta.mul(SEAWATER_INDEX_550_NM).add(transmittedCosine));
        const fresnel = rs.pow(2).add(rp.pow(2)).mul(0.5);
        if (top) {
            waveReflectionPass?.dispose();
            waveReflectionPass = new WaveReflectionPass(renderer, topMesh.geometry, material.positionNode!, nWorld, roughness, {
                scene: options.rayScene, surface: surfaceRays, half,
                environment, absorption: uniforms.absorb, volumeRadiance: vec3(uniforms.scatter).mul(sunLight).mul(uniforms.scatterStrength),
                scattering: uniforms.scatteringCoefficient, sunDirection: uniforms.sunDir, sunIrradiance: uniforms.sunIrradiance,
            });
        }
        const reflectedScene = top ? texture(waveReflectionPass!.target.texture, screenUV).rgb : sky;
        const reflection = reflectedScene.mul(fresnel).mul(uniforms.envStrength);
        const directScatter = top ? texture(waveReflectionPass!.volume.texture, screenUV).rgb : vec3(0);
        const under = sceneColor.mul(float(1.0).add(causticMask.mul(uniforms.causticStrength))).mul(transmittance).add(scatter).add(directScatter);
        const foamFootprint = max(fwidth(p.x), fwidth(p.z));
        const foamMask = Fn(() => {
            if (!top)
                return float(0.0);
            const field = foamField.sample(p.xz.div(slabHalf.mul(2.0)).add(0.5)).r;
            const result = float(0).toVar();
            If(field.greaterThan(0.001), () => {
            const lace = mx_fractal_noise_float(vec3(p.x.mul(5.0), p.z.mul(5.0), t.mul(0.45)), 4, 2.3, 0.55);
            const fine = mx_noise_float(vec3(p.x.mul(22.0), p.z.mul(22.0), t.mul(0.8)));
            const coverage = field.clamp(0, 1);
            const footprint = foamFootprint;
            const detail = lace.mul(smoothstep(0.5, 0.05, footprint)).mul(0.45).add(fine.mul(smoothstep(0.08, 0.005, footprint)).mul(0.25));
            const holes = smoothstep(-0.2, 0.2, lace.add(fine.mul(0.3)).add(coverage.mul(0.45)).sub(0.1));
            const drifting = coverage.mul(mix(holes, float(1), smoothstep(0.05, 0.5, footprint))).mul(float(1).add(detail));
            result.assign(clamp(drifting, 0.0, 1.0).mul(uniforms.foamStrength));
            });
            return result;
        })();
        const foamLight = vec3(uniforms.sunColor).mul(sunUp.mul(1.3)).add(vec3(0.35, 0.4, 0.45));
        const froth = Fn(() => {
            const value = float(1).toVar();
            If(foamMask.greaterThan(0.001), () => {
                const grain = mx_fractal_noise_float(vec3(p.x.mul(30.0), p.z.mul(30.0), t.mul(0.9)), 3, 2.1, 0.6);
                value.assign(smoothstep(-0.6, 0.5, grain).mul(0.35).add(0.7));
            });
            return value;
        })();
        const foamColor = vec3(0.92, 0.95, 0.96).mul(foamLight).mul(froth);
        const shaded: THREE.Node = mix(under.mul(float(1).sub(fresnel)).add(reflection), foamColor, foamMask);
        const simState = sim.stateNode.sample(sim.uvOf(p.xz) as unknown as ReturnType<typeof vec2>) as ReturnType<typeof vec4>;
        const groundHere = sandHeight(p.xz);
        const gs = float(2.0 / 512);
        const gUv = p.xz.div(slabHalf).mul(0.5).add(0.5);
        const gradGround = vec2(texture(heightTexture, gUv.add(vec2(gs, 0.0))).r.sub(texture(heightTexture, gUv.sub(vec2(gs, 0.0))).r), texture(heightTexture, gUv.add(vec2(0.0, gs))).r.sub(texture(heightTexture, gUv.sub(vec2(0.0, gs))).r)).div(float(4 * (2 * half) / 512));
        const steepGround = smoothstep(0.35, 0.9, gradGround.length());
        const needed = float(0.0015).add(max(groundHere.sub(waterLevel), 0.0).mul(steepGround));
        const floor0Outside = max(abs(floor0.x), abs(floor0.z)).greaterThan(slabHalf.add(0.6));
        const sheetAboveFloor = select(floor0Outside, float(1.0), p.y.sub(floor0.y));
        const bareSand = texture(sandTexture, p.xz.div(slabHalf).mul(0.5).add(0.5)).r;
        const cutDry = bareSand.greaterThan(waterLevel.sub(0.01));
        const gateOn = params.get('waterFilm') !== '0';
        const filmDepth = fieldAt(p.xz).w;
        const edge = (value: THREE.Node, at: number) => clamp((value as ReturnType<typeof float>).sub(at).div(max(fwidth(value as ReturnType<typeof float>), 1e-5)).add(0.5), 0.0, 1.0);
        const filmCoverage = edge(filmDepth.sub(needed), 0);
        const floorCoverage = edge(sheetAboveFloor, 0.0005);
        const contact = smoothstep(0.0, 0.06, viewZ.sub(sceneZ0));
        const covered = filmCoverage.mul(floorCoverage);
        const thinFilm = !gateOn ? float(0.0).greaterThan(1.0) : top ? covered.lessThanEqual(0.0) : cutDry;
        const filmFade = !gateOn ? float(1.0) : top ? covered.mul(contact) : contact;
        if (params.get('waterWire') === '1')
            material.wireframe = true;
        const debug: THREE.Node | null = debugMode === 'eta' ? vec3(p.y.sub(waterLevel).mul(6.0).add(0.5), float(0.5), float(0.5))
            : debugMode === 'depth' ? vec3(verticalDepth.mul(0.5))
                : debugMode === 'path' ? vec3(pathLength.mul(0.3))
                    : debugMode === 'foam' ? vec3(foamMask)
                        : debugMode === 'impact' ? vec3(foamField.sample(p.xz.div(slabHalf.mul(2.0)).add(0.5)).b, simState.a, 0.0)
                            : debugMode === 'sim' ? vec3(p.y.sub(waterLevel).mul(8.0).add(0.5), simState.gb.abs().mul(0.5))
                                : null;
        const sceneHere = texture(screen.color, screenUV).rgb;
        const shown = debug ?? mix(sceneHere, shaded, filmFade);
        material.emissiveNode = Fn(() => {
            Discard(behindScene.or(thinFilm));
            return shown;
        })();
        return material;
    }
    const group = new THREE.Group();
    group.name = 'water';
    if (params.get('spray') !== '0')
        group.add(spray.mesh);
    const top = new THREE.PlaneGeometry(2 * half, 2 * half, 512, 512);
    top.rotateX(-Math.PI / 2);
    top.translate(0, field.waterLevel, 0);
    const topMesh = new THREE.Mesh(top);
    topMesh.name = 'waterSurface';
    topMesh.frustumCulled = false;
    group.add(topMesh);
    const skin = 0.004;
    const wantCuts = new URLSearchParams(window.location.search).get('waterCuts') !== '0';
    const front = new THREE.PlaneGeometry(2 * half, cutDepth, 96, 24);
    front.translate(0, field.waterLevel - cutDepth / 2, half + skin);
    const frontMesh = new THREE.Mesh(front);
    frontMesh.name = 'waterCutFront';
    group.add(frontMesh);
    const left = new THREE.PlaneGeometry(2 * half, cutDepth, 96, 24);
    left.rotateY(-Math.PI / 2);
    left.translate(-half - skin, field.waterLevel - cutDepth / 2, 0);
    const leftMesh = new THREE.Mesh(left);
    leftMesh.name = 'waterCutLeft';
    group.add(leftMesh);
    const back = new THREE.PlaneGeometry(2 * half, cutDepth, 96, 24);
    back.rotateY(Math.PI);
    back.translate(0, field.waterLevel - cutDepth / 2, -half - skin);
    const backMesh = new THREE.Mesh(back);
    backMesh.name = 'waterCutBack';
    group.add(backMesh);
    const right = new THREE.PlaneGeometry(2 * half, cutDepth, 96, 24);
    right.rotateY(Math.PI / 2);
    right.translate(half + skin, field.waterLevel - cutDepth / 2, 0);
    const rightMesh = new THREE.Mesh(right);
    rightMesh.name = 'waterCutRight';
    group.add(rightMesh);
    if (!wantCuts)
        group.remove(frontMesh, leftMesh, backMesh, rightMesh);
    for (const mesh of [topMesh, frontMesh, leftMesh, backMesh, rightMesh]) {
        mesh.castShadow = false;
        mesh.receiveShadow = true;
        mesh.userData.giExclude = true;
    }
    const placeholderDepth = new THREE.DepthTexture(1, 1);
    const placeholderColor = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    placeholderColor.needsUpdate = true;
    let materials: THREE.MeshStandardNodeMaterial[] = [];
    const bindScreen = (color: THREE.Texture, depth: THREE.Texture, normal: THREE.Texture) => {
        spray.bindScreen(color, depth);
        const previous = materials;
        const surface = buildMaterial({ color, depth, normal }, true);
        const cut = buildMaterial({ color, depth, normal }, false);
        topMesh.material = surface;
        frontMesh.material = cut;
        leftMesh.material = cut;
        backMesh.material = cut;
        rightMesh.material = cut;
        materials = [surface, cut];
        for (const m of previous)
            m.dispose();
    };
    bindScreen(placeholderColor, placeholderDepth, placeholderColor);
    (window as unknown as Record<string, unknown>).__lagoon = {
        bootTimings: workerSim?.bootTimings,
        get waveReflectionPass() { return waveReflectionPass; },
        surfaceRays,
        oceanDetail,
        spectrum: () => ({ ...wind.moments }),
        simStats: async () => sim.readStats(),
        simProbe: async () => sim.readProbe(),
        sprayStats: async () => spray.readStats(),
        profile: (z: number) => {
            const out: number[][] = [];
            for (let x = -half; x <= half; x += 0.1)
                out.push([Number(x.toFixed(2)), Number((field.height(x, z) - field.waterLevel).toFixed(3))]);
            return out;
        },
        depthRow: async (z: number) => {
            const size = sim.size;
            const j = Math.max(0, Math.min(size - 1, Math.floor(((z + half) / (2 * half)) * size)));
            return { size, cell: (2 * half) / size, depth: Array.from(await sim.readRow(j)) };
        },
        simRow: async (z: number) => {
            const size = sim.size;
            const j = Math.max(0, Math.min(size - 1, Math.floor(((z + half) / (2 * half)) * size)));
            const depth = await sim.readRow(j);
            let edge = 2;
            for (let i = 2; i < size - 4; i++) {
                if (depth[i] > 0.001)
                    edge = i;
                else if (depth[i + 1] <= 0.001 && depth[i + 2] <= 0.001 && i > size * 0.3)
                    break;
            }
            const cell = (2 * half) / size;
            const edgeX = -half + (edge + 0.5) * cell;
            const back = Math.max(0, edge - Math.round(0.3 / cell));
            let hNearShore = 0;
            for (let i = back; i <= edge; i++)
                hNearShore = Math.max(hNearShore, depth[i]);
            const slope = Math.abs(field.height(edgeX + 0.25, z) - field.height(edgeX - 0.25, z)) / 0.5;
            return { edgeX, hNearShore, slope };
        },
        controls: () => water.controls,
        foamDebug: () => ({ isRenderTarget: (foamRead as unknown as {
                isRenderTarget?: boolean;
            }).isRenderTarget, textures: foamRead.textures?.length, width: foamRead.width }),
        foamStats: async () => {
            const { size, foam, wetness } = await water.readFoamField();
            let foamMax = 0, wetMax = 0, wetCount = 0;
            for (let i = 0; i < size * size; i++) {
                foamMax = Math.max(foamMax, foam[i]);
                wetMax = Math.max(wetMax, wetness[i]);
                if (wetness[i] > 0.2)
                    wetCount++;
            }
            return { foamMax, wetMax, wetFraction: wetCount / (size * size) };
        },
        simClock: () => ({ simTime: sim.simTime, now: performance.now() }),
        shoreSnapshot: async (z: number) => {
            const [state, fieldData] = await Promise.all([sim.readState(), water.readFoamField()]);
            const simTimeAt = sim.simTime;
            const size = state.size;
            const cell = (2 * half) / size;
            const j = Math.max(1, Math.min(size - 2, Math.floor(((z + half) / (2 * half)) * size)));
            const fs = fieldData.size;
            const jf = Math.max(0, Math.min(fs - 1, Math.floor(((z + half) / (2 * half)) * fs)));
            const w = [1 / 6, 4 / 6, 1 / 6];
            const rows: number[][] = [];
            for (let i = 0; i < size; i++) {
                let film = 0;
                for (let b = -1; b <= 1; b++) {
                    for (let a = -1; a <= 1; a++) {
                        const ii = Math.max(0, Math.min(size - 1, i + a));
                        film += state.depth[(j + b) * size + ii] * w[a + 1] * w[b + 1];
                    }
                }
                const x = -half + (i + 0.5) * cell;
                const fi = Math.max(0, Math.min(fs - 1, Math.floor(((x + half) / (2 * half)) * fs)));
                const k = jf * fs + fi;
                const c = j * size + i;
                rows.push([x, state.depth[c], film, state.u[c], state.v[c], state.foam[c], fieldData.foam[k], fieldData.wetness[k], field.height(x, z) - field.waterLevel]);
            }
            return { simTime: simTimeAt, now: performance.now(), z, cell, level: field.waterLevel, rows };
        },
    };
    const inspectParam = params.get('waterInspect');
    const inspector = inspectParam
        ? new WaterInspector(renderer, sim, field, { sectionZ: inspectParam.startsWith('z:') ? Number(inspectParam.slice(2)) : undefined, readFoam: () => water.readFoamField(), bathymetry: heightTexture })
        : null;
    const sunDirection = new THREE.Vector3();
    let previousSimTime = sim.simTime;
    let previousTime = -1;
    const controls: Water['controls'] = {
        swellAmplitude: sim.swellAmplitude.value as number,
        swellPeriod: sim.swellPeriod.value as number,
        swellDirection: -45,
        windSpeed: wind.windSpeed,
        windDirection: (wind.windDirection * 180) / Math.PI,
        manning: sim.manning.value as number,
        apply() {
            sim.swellAmplitude.value = controls.swellAmplitude;
            sim.swellPeriod.value = controls.swellPeriod;
            sim.setSwellDirection((controls.swellDirection * Math.PI) / 180);
            sim.manning.value = controls.manning;
            wind.setWind(controls.windSpeed, (controls.windDirection * Math.PI) / 180);
            oceanDetail.setWind(controls.windSpeed, (controls.windDirection * Math.PI) / 180);
        },
    };
    (window as unknown as Record<string, unknown>).__water = () => ({
        simTime: sim.simTime, offThread: workerSim !== null, size: sim.size, stepsLeft, cost: workerSim?.cost ?? null,
    });
    (window as unknown as Record<string, unknown>).__waterRun = (running: boolean) => sim.setRunning?.(running);
    if (workerSim && params.get('still') === '1')
        void workerSim.firstFieldReady.then(() => workerSim.setRunning(false));
    const solverBed = new SolverBed(renderer, heightTexture, field);
    const water: Water = {
        reflection: planarReflection,
        renderReflections: (camera) => waveReflectionPass?.update(renderer, camera, topMesh),
        transmission,
        group,
        fields: {
            sampleSurface: async (x, z) => { const sample = await surface.readAt(x, z); return { ...sample, eta: field.waterLevel + sample.eta * Number(uniforms.waveStrength.value), slopeX: sample.slopeX * Number(uniforms.waveStrength.value), slopeZ: sample.slopeZ * Number(uniforms.waveStrength.value) }; },
            bedAt: (x, z) => { solverBed.request(); return solverBed.at(x, z); },
            waterLevel: field.waterLevel,
            half,
        },
        onStep: null,
        ready: workerSim ? workerSim.firstFieldReady : Promise.resolve(),
        async readFoamField() {
            const raw = await renderer.readRenderTargetPixelsAsync(foamRead, 0, 0, FOAM_SIZE, FOAM_SIZE);
            const n = FOAM_SIZE * FOAM_SIZE;
            const foam = new Float32Array(n);
            const wetness = new Float32Array(n);
            const decode = raw instanceof Uint16Array ? (x: number) => THREE.DataUtils.fromHalfFloat(x) : (x: number) => x;
            for (let i = 0; i < n; i++) {
                foam[i] = decode(raw[i * 4]);
                wetness[i] = decode(raw[i * 4 + 1]);
            }
            return { size: FOAM_SIZE, foam, wetness };
        },
        uniforms,
        bindScreen,
        controls,
        setRunning: (running) => sim.setRunning?.(running),
        update(elapsedSeconds) {
            const dt = previousTime < 0 ? 1 / 60 : elapsedSeconds - previousTime;
            previousTime = elapsedSeconds;
            if (stepsLeft <= 0) {
                if (stepsLeft === 0) {
                    sim.setRunning?.(false);
                    stepsLeft = -1;
                }
                sunDirection.copy(sun.position).sub(sun.target.position).normalize();
                (uniforms.sunDir.value as THREE.Vector3).copy(sunDirection);
                (uniforms.sunColor.value as THREE.Color).copy(sun.color).multiplyScalar(Math.min(1.5, sun.intensity * 0.5));
                return;
            }
            stepsLeft--;
            sim.step(Math.min(0.05, Math.max(0.001, dt)));
            const simDelta = Math.max(0, sim.simTime - previousSimTime);
            previousSimTime = sim.simTime;
            wind.clock.value = sim.simTime;
            oceanDetail.update();
            surface.update();
            surfaceRays.update(renderer);
            inspector?.update(performance.now());
            stepFoam(simDelta);
            spray.update(simDelta);
            water.onStep?.(simDelta);
            sunDirection.copy(sun.position).sub(sun.target.position).normalize();
            (uniforms.sunDir.value as THREE.Vector3).copy(sunDirection);
            (uniforms.sunIrradiance.value as THREE.Color).copy(sun.color).multiplyScalar(sun.intensity);
            (uniforms.sunColor.value as THREE.Color).copy(sun.color).multiplyScalar(Math.min(1.5, sun.intensity * 0.5));
        },
    };
    return water;
}

