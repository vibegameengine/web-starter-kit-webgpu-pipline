// @ts-nocheck -- TSL storage indexing, shared by motion and its gather consumers.
import { int, storage } from 'three/tsl';
import type { SurfelPool } from './surfelPool';

/** The pinned prefix and an inactive anchor field both read the immutable null slot. */
export function bindSurfelAnchors(pool: SurfelPool, readOnly = true) {
  const attribute = pool.getAnchorAttr();
  const start = pool.getAnchorStart(), count = attribute.count / 2 - 1;
  const buffer = storage(attribute, 'vec4', attribute.count);
  if (readOnly) buffer.toReadOnly();
  const index = sid => int(sid).sub(start).add(1).clamp(0, count).mul(2);
  return { start, count, position: sid => buffer.element(index(sid)),
    normal: sid => buffer.element(index(sid).add(1)) };
}
