import * as THREE from 'three/webgpu';
import { mix, normalWorldGeometry, normalize, positionWorld, smoothstep, transformNormalToView } from 'three/tsl';

export function applyVillageHeadlandSurface(sand: THREE.Mesh, rock: THREE.MeshStandardNodeMaterial): void {
  const material=sand.material as THREE.MeshStandardNodeMaterial;
  const region=smoothstep(-4.3,-6.1,positionWorld.x).mul(smoothstep(.75,-1.5,positionWorld.z));
  const slope=smoothstep(.94,.62,normalWorldGeometry.y);
  const exposure=region.mul(slope.mul(.35).add(.65));
  sand.geometry.setAttribute('crevice',new THREE.Float32BufferAttribute(new Float32Array(sand.geometry.getAttribute('position').count),1));
  material.colorNode=mix(material.colorNode!,rock.colorNode!,exposure);
  material.normalNode=normalize(mix(material.normalNode!,transformNormalToView(normalWorldGeometry),exposure));
}
