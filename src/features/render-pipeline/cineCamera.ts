import * as THREE from 'three/webgpu';

export interface CineCamera {
  label: string;
  sensorWidthMm: number;
  sensorHeightMm: number;
  focalMm: number;
  shutterAngleDeg: number;
  iso: number;
  tStop: number;
  squeeze: number;
  note: string;
}

const REFERENCE = { iso: 800, tStop: 2.8, shutterAngleDeg: 180 };

/* @important Real sensor sizes and real lenses, from the manufacturers' own frame-size
   tables: the point of a preset is that a 32 mm on an ALEXA 35 frames what a 32 mm on an
   ALEXA 35 frames. Changing a number here changes what the shot looks like, so change it
   only against a spec sheet. */
export const CINE_CAMERAS: Record<string, CineCamera> = {
  'alexa35-32': {
    label: 'ARRI ALEXA 35 · Master Prime 32 mm',
    sensorWidthMm: 27.99, sensorHeightMm: 19.22, focalMm: 32, shutterAngleDeg: 180, iso: 800, tStop: 1.3, squeeze: 1,
    note: '4.6K 3:2 open gate, the current ARRI workhorse',
  },
  'alexa-lf-40': {
    label: 'ARRI ALEXA LF · Signature Prime 40 mm',
    sensorWidthMm: 36.70, sensorHeightMm: 25.54, focalMm: 40, shutterAngleDeg: 180, iso: 800, tStop: 1.8, squeeze: 1,
    note: 'large format, the wider look with the same framing',
  },
  'venice2-24': {
    label: 'Sony VENICE 2 · 24 mm',
    sensorWidthMm: 35.9, sensorHeightMm: 24.0, focalMm: 24, shutterAngleDeg: 172.8, iso: 800, tStop: 2.8, squeeze: 1,
    note: '8.6K full frame, 172.8° kills 50 Hz flicker',
  },
  'raptor-50': {
    label: 'RED V-RAPTOR 8K VV · 50 mm',
    sensorWidthMm: 40.96, sensorHeightMm: 21.60, focalMm: 50, shutterAngleDeg: 180, iso: 800, tStop: 2.0, squeeze: 1,
    note: '8K vista vision, 17:9, the long end of a two-lens kit',
  },
  'anamorphic-2x-40': {
    label: 'ALEXA Mini LF · Cooke Anamorphic 40 mm, 2x',
    sensorWidthMm: 31.68, sensorHeightMm: 18.00, focalMm: 40, shutterAngleDeg: 180, iso: 800, tStop: 2.3, squeeze: 2,
    note: 'the squeeze doubles the horizontal field the sensor sees',
  },
  'imax65-50': {
    label: 'IMAX MSM 9802 · 50 mm',
    sensorWidthMm: 70.41, sensorHeightMm: 52.63, focalMm: 50, shutterAngleDeg: 180, iso: 500, tStop: 2.8, squeeze: 1,
    note: '15/70 film, the widest gate in this list',
  },
};

export const DEFAULT_CINE_CAMERA = 'alexa35-32';

export function horizontalFovDeg(camera: CineCamera): number {
  return (2 * Math.atan((camera.sensorWidthMm * camera.squeeze) / (2 * camera.focalMm)) * 180) / Math.PI;
}

/* @important The stop difference is reported, never applied on its own. The camera in this
   project meters the scene itself, and the document's contract is that a preset does not
   silently take the exposure away from it; a person adds the stops through the Look when
   that is what they want. */
export function relativeStops(camera: CineCamera): number {
  return Math.log2(camera.iso / REFERENCE.iso) - 2 * Math.log2(camera.tStop / REFERENCE.tStop) + Math.log2(camera.shutterAngleDeg / REFERENCE.shutterAngleDeg);
}

export function applyCineCamera(camera: THREE.PerspectiveCamera, cine: CineCamera, focalMm = cine.focalMm): void {
  camera.filmGauge = cine.sensorWidthMm * cine.squeeze;
  camera.setFocalLength(focalMm);
  camera.updateProjectionMatrix();
}
