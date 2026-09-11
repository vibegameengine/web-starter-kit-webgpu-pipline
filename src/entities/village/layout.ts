export interface VillageHouse {
  id: string;
  x: number;
  z: number;
  base: number;
  width: number;
  depth: number;
  height: number;
  wall: string;
  shutter: string;
  hip: boolean;
  roofRise: number;
}

export const VILLAGE_PLOT = { half: 10, bottom: -6.7, quay: 1.5, terrace: 2.9 };

export const VILLAGE_HOUSES: VillageHouse[] = [
  { id: 'yellow-house', x: -3.2, z: -6, base: 1.95, width: 3.6, depth: 3.9, height: 4.85, wall: '#e9bd60', shutter: '#366d55', hip: true, roofRise: 1 },
  { id: 'coral-house', x: .3, z: -4.6, base: 1.5, width: 3.2, depth: 3.4, height: 5, wall: '#d77f60', shutter: '#397260', hip: false, roofRise: 1.05 },
  { id: 'cream-house', x: 3.1, z: -6.45, base: 1.9, width: 2.3, depth: 3.8, height: 4.2, wall: '#e5ddc0', shutter: '#397e96', hip: false, roofRise: .9 },
  { id: 'blue-cafe', x: 7.45, z: -3.3, base: 1.5, width: 3.8, depth: 3.6, height: 4.6, wall: '#9fbed0', shutter: '#2c7b93', hip: true, roofRise: 1 },
  { id: 'rear-house', x: -.4, z: -8, base: 2.9, width: 3.8, depth: 3, height: 4.5, wall: '#d4ba91', shutter: '#527261', hip: false, roofRise: 1 },
];

export const VILLAGE_TERRACES = [
  { id: 'quay', x0: 2.8, x1: 10.025, z0: -6.9, z1: 1.25, top: 1.5 },
  { id: 'cove-quay', x0: -1.2, x1: 2.8, z0: -6.9, z1: -.2, top: 1.5 },
  { id: 'yellow-entry', x0: -5, x1: -1.2, z0: -7.5, z1: -2.75, top: 1.95 },
  { id: 'cream-entry', x0: 1.95, x1: 4.25, z0: -6.9, z1: -4.3, top: 1.9 },
  { id: 'pine-terrace', x0: -9.35, x1: -5, z0: -10.025, z1: -2.7, top: 2.9 },
  { id: 'rear-terrace', x0: -9.35, x1: 10.025, z0: -10.025, z1: -6.9, top: 2.9 },
];

export const VILLAGE_STAIRS = [
  { id: 'beach-flight', x: -1.9, z: .7, bottom: .1, top: 1.5, run: 2.8, width: 1.4, count: 9 },
  { id: 'pine-flight', x: -4.35, z: -3.3, bottom: 1.95, top: 2.9, run: 1.8, width: 1.2, count: 6 },
  { id: 'yellow-flight', x: -3.2, z: -2.1, bottom: 1.5, top: 1.95, run: .9, width: 1.5, count: 3 },
  { id: 'cream-flight', x: 3.1, z: -3.65, bottom: 1.5, top: 1.9, run: .9, width: 1.2, count: 3 },
  { id: 'cafe-alley', x: 4.9, z: -1.65, bottom: 1.5, top: 2.9, run: 5.25, width: 1.25, count: 9 },
];
