/**
 * @deprecated LEGACY entry.
 *
 * The real app is **webgiya** (`vendor/webgiya`).
 *   npm run dev          → http://127.0.0.1:5188  (webgiya surfel GI)
 *   npm run dev:legacy   → this file (broken experimental path)
 *
 * See docs/PIPELINE.md
 */
console.error(
  '[legacy] This is NOT the render pipeline. Run `npm run dev` (webgiya), not dev:legacy.',
);
document.getElementById('boot')!.textContent =
  'Legacy entry. Use npm run dev → webgiya at :5188';
