import * as THREE from 'three/webgpu';
import { texture } from 'three/tsl';

export function createVillageMaterialReview(roots: THREE.Object3D[]) {
  const original=new Map<THREE.Mesh,THREE.Material|THREE.Material[]>();
  const stripped=new Map<THREE.Material,THREE.MeshStandardNodeMaterial>();
  const withoutMaps=(source:THREE.Material)=>{
    const cached=stripped.get(source);
    if(cached)return cached;
    const lit=source as THREE.MeshStandardNodeMaterial;
    const albedo=lit.color?.clone()??new THREE.Color('#c1b7a3');
    const highest=Math.max(albedo.r,albedo.g,albedo.b);
    if(highest>1)albedo.multiplyScalar(.65/highest);
    const material=new THREE.MeshStandardNodeMaterial({color:albedo,roughness:.92,side:source.side,vertexColors:source.vertexColors,alphaTest:source.alphaTest});
    if(lit.map&&source.alphaTest>0)material.opacityNode=texture(lit.map).a;
    material.name=`review-no-maps:${source.name}`;
    stripped.set(source,material);
    return material;
  };
  return (mode:'textured'|'no-maps')=>{
    if(mode==='textured') {
      original.forEach((material,mesh)=>{mesh.material=material;});
      original.clear();
      return;
    }
    roots.forEach(root=>root.traverse(object=>{
      const mesh=object as THREE.Mesh;
      if(!mesh.isMesh||original.has(mesh))return;
      original.set(mesh,mesh.material);
      mesh.material=Array.isArray(mesh.material)?mesh.material.map(withoutMaps):withoutMaps(mesh.material);
    }));
  };
}
