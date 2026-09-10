export function gravityWaveNumber(omega: number, depth: number): number {
  if (!Number.isFinite(omega) || omega < 0 || !Number.isFinite(depth) || depth <= 0) throw new RangeError('omega must be nonnegative and depth positive');
  if (omega === 0) return 0;
  const q = omega * omega * depth / 9.81;
  let x = Math.max(q, Math.sqrt(q));
  for (let iteration = 0; iteration < 4; iteration++) {
    const t = Math.tanh(x);
    x -= (x * t - q) / (t + x * (1 - t * t));
  }
  return x / depth;
}

export function waterRefractiveIndex(salinity: number, celsius: number, wavelengthNm: number): number {
  if (![salinity, celsius, wavelengthNm].every(Number.isFinite) || salinity < 0 || salinity > 35 || celsius < 0 || celsius > 30 || wavelengthNm < 400 || wavelengthNm > 700) throw new RangeError('Quan-Fry reference domain: S 0..35 PSU, T 0..30 C, wavelength 400..700 nm');
  return 1.31405 + (1.779e-4 - 1.05e-6 * celsius + 1.6e-8 * celsius ** 2) * salinity
    - 2.02e-6 * celsius ** 2 + (15.868 + 0.01155 * salinity - 0.00423 * celsius) / wavelengthNm
    - 4382 / wavelengthNm ** 2 + 1.1455e6 / wavelengthNm ** 3;
}

export function dielectricReflectance(cosIncident: number, incidentIndex: number, transmittedIndex: number): number {
  if (![cosIncident, incidentIndex, transmittedIndex].every(Number.isFinite) || cosIncident < 0 || cosIncident > 1 || incidentIndex <= 0 || transmittedIndex <= 0) throw new RangeError('Invalid dielectric interface');
  if (incidentIndex === transmittedIndex) return 0;
  const sinTransmittedSquared = (incidentIndex / transmittedIndex) ** 2 * (1 - cosIncident ** 2);
  if (sinTransmittedSquared >= 1) return 1;
  const cosTransmitted = Math.sqrt(1 - sinTransmittedSquared);
  const rs = (incidentIndex * cosIncident - transmittedIndex * cosTransmitted) / (incidentIndex * cosIncident + transmittedIndex * cosTransmitted);
  const rp = (transmittedIndex * cosIncident - incidentIndex * cosTransmitted) / (transmittedIndex * cosIncident + incidentIndex * cosTransmitted);
  return 0.5 * (rs * rs + rp * rp);
}

export const SEAWATER_INDEX_550_NM = waterRefractiveIndex(35, 20, 550);

export function eckvSpectrum(k: number, windAt10m: number, inverseWaveAge = 0.84) {
  if (![k, windAt10m, inverseWaveAge].every(Number.isFinite) || k <= 0 || windAt10m <= 0 || inverseWaveAge < 0.84 || inverseWaveAge > 5) throw new RangeError('Invalid ECKV reference parameters');
  const g = 9.82;
  const km = 370;
  const cm = 0.23;
  const frictionVelocity = Math.sqrt(0.00144) * windAt10m;
  const alphaM = 0.01 * (1 + (frictionVelocity <= cm ? 1 : 3) * Math.log(frictionVelocity / cm));
  if (alphaM < 0) throw new RangeError('ECKV high-frequency fit is negative at this wind speed');
  const kp = g / windAt10m ** 2 * inverseWaveAge ** 2;
  const cp = Math.sqrt(g / kp);
  const c = Math.sqrt(g / k * (1 + (k / km) ** 2));
  const gamma = inverseWaveAge <= 1 ? 1.7 : 1.7 + 6 * Math.log10(inverseWaveAge);
  const sigma = 0.08 * (1 + 4 * inverseWaveAge ** -3);
  const gammaExponent = Math.exp(-0.5 / sigma ** 2 * (Math.sqrt(k / kp) - 1) ** 2);
  const peak = Math.exp(-1.25 * (kp / k) ** 2) * gamma ** gammaExponent;
  const fp = peak * Math.exp(-0.3162 * inverseWaveAge * (Math.sqrt(k / kp) - 1));
  const fm = peak * Math.exp(-0.25 * (k / km - 1) ** 2);
  const bl = 0.5 * 0.006 * inverseWaveAge ** 0.55 * cp / c * fp;
  const bh = 0.5 * alphaM * cm / c * fm;
  const delta = Math.tanh(0.1733 + 4 * (c / cp) ** 2.5 + 0.13 * frictionVelocity / cm * (cm / c) ** 2.5);
  return { elevation: (bl + bh) / k ** 3, slope: (bl + bh) / k, spreadingDelta: delta, omega: k * c };
}
