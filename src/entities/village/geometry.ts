import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { VillageHouse } from './layout.ts';
import { ARCHED_DOOR, doorwayContour, usesArchedEntry } from './doorGeometry.ts';

export function houseWallGeometry(h: VillageHouse): THREE.BufferGeometry {
  const thickness=.22;
  const wall=(width:number,openings:number[][],archedEntry=false)=>{
    const shape=new THREE.Shape();
    shape.moveTo(-width/2,0);shape.lineTo(width/2,0);shape.lineTo(width/2,h.height);shape.lineTo(-width/2,h.height);shape.closePath();
    for(const [x,y,w,height] of openings) {
      const hole=new THREE.Path();
      hole.moveTo(x-w/2,y-height/2);hole.lineTo(x-w/2,y+height/2);hole.lineTo(x+w/2,y+height/2);hole.lineTo(x+w/2,y-height/2);hole.closePath();
      shape.holes.push(hole);
    }
    if(archedEntry) {
      const points=doorwayContour().getPoints(32).map(point=>new THREE.Vector2(point.x*ARCHED_DOOR.scale+h.width*.23,point.y*ARCHED_DOOR.scale+.04));
      shape.holes.push(new THREE.Path(points.reverse()));
    }
    return new THREE.ExtrudeGeometry(shape,{depth:thickness,bevelEnabled:false});
  };
  const upper=h.height-1.25;
  const front=[[-h.width*.25,upper,.55,.98],[h.width*.25,upper,.55,.98]];
  if(h.id!=='blue-cafe') {
    front.push([-h.width*.25,1.35,.44,.93]);
    if(!usesArchedEntry(h.id))front.push([h.width*.23,1.035,.81,1.94]);
  }
  const pieces=[
    wall(h.width,front,usesArchedEntry(h.id)).translate(0,0,h.depth/2-thickness),
    wall(h.width,[[-h.width*.25,upper,.44,.89],[h.width*.25,upper,.44,.89]]).rotateY(Math.PI).translate(0,0,-h.depth/2+thickness),
    ...[-1,1].map(side=>wall(h.depth,[[0,upper,.47,.98]]).rotateY(side*Math.PI/2).translate(side*(h.width/2-thickness),0,0)),
    new THREE.BoxGeometry(h.width,.12,h.depth).toNonIndexed().translate(0,.06,0),
    new THREE.BoxGeometry(h.width,.12,h.depth).toNonIndexed().translate(0,h.height-.06,0),
  ];
  const result=mergeGeometries(pieces);
  pieces.forEach(p=>p.dispose());
  return result;
}

export function roofGeometry(w: number, d: number, rise: number, hip: boolean): THREE.BufferGeometry {
  if (!hip) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([-w/2,0,d/2, w/2,0,d/2, w/2,0,-d/2, -w/2,0,-d/2, 0,rise,d/2, 0,rise,-d/2],3));
    geometry.setAttribute('uv',new THREE.Float32BufferAttribute([0,0,1,0,1,1,0,1,.5,0,.5,1],2));
    geometry.setIndex([0,4,5,0,5,3,4,1,2,4,2,5]);
    const result=geometry.toNonIndexed();
    result.computeVertexNormals();
    geometry.dispose();
    return result;
  }
  const ridge = hip ? Math.max(0, w / 2 - d * .42) : w / 2;
  const corners = [[-w / 2, 0, d / 2], [w / 2, 0, d / 2], [w / 2, 0, -d / 2], [-w / 2, 0, -d / 2], [-ridge, rise, 0], [ridge, rise, 0]];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(corners.flat(), 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(corners.flatMap(([x, , z]) => [x / w + .5, z / d + .5]), 2));
  geometry.setIndex([0, 1, 5, 0, 5, 4, 2, 3, 4, 2, 4, 5, 3, 0, 4, 1, 2, 5]);
  const result = geometry.toNonIndexed();
  result.computeVertexNormals();
  geometry.dispose();
  return result;
}

export function gableGeometry(w: number, d: number, rise: number): THREE.BufferGeometry {
  const shape=new THREE.Shape();
  shape.moveTo(-w/2,0);shape.lineTo(w/2,0);shape.lineTo(0,rise);shape.closePath();
  return new THREE.ExtrudeGeometry(shape,{depth:d,bevelEnabled:false}).translate(0,0,-d/2);
}
