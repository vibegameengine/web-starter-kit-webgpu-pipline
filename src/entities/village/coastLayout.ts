import { seededRandom } from '../../shared/lib/noise.ts';

export interface CoastalRock {
  id: string;
  x: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  yaw: number;
  roll: number;
  buried: number;
  kind: 'outcrop' | 'rubble' | 'reef' | 'pebble';
}

export function villageRockLayout(): CoastalRock[] {
  const random=seededRandom(91743);
  const rocks:CoastalRock[]=[];
  const add=(x:number,z:number,sx:number,sy:number,sz:number,kind:CoastalRock['kind'],buried=.3,orientation?:number)=>{
    const yaw=orientation??random()*.8-.4,roll=random()*.24-.12;
    const ex=sx*Math.cos(yaw)+sz*Math.abs(Math.sin(yaw))+sy*Math.abs(Math.sin(roll));
    const ez=sz*Math.cos(yaw)+sx*Math.abs(Math.sin(yaw))+sy*Math.abs(Math.sin(roll));
    const safeX=Math.max(-9.98+ex,Math.min(9.98-ex,x));
    const safeZ=Math.max(-9.98+ez,Math.min(9.98-ez,z));
    rocks.push({id:`${kind}-${rocks.length}`,x:safeX,z:safeZ,sx,sy,sz,yaw,roll,buried,kind});
  };
  [
    [-9.12,-7.8,.68,.95,1.5],[-9.1,-5.85,.82,1.05,1.32],[-9.15,-3.8,.73,.94,1.35],
    [-8.4,-2.3,1.05,.95,1.2],[-8.8,-.5,.83,.65,1.12],[-7.8,.35,1.12,.55,.9],
    [-5.65,-2.2,.61,1.03,.7],[-5.12,-1.35,.68,.91,.76],[-4.45,-.4,.59,.6,.72],
    [-8.75,1.15,.63,.45,.63],[-5.1,.65,.72,.44,.82],
    [9.2,1.55,.64,.55,.52],
  ].forEach(([x,z,sx,sy,sz])=>add(x,z,sx,sy,sz,'outcrop',-.12));
  for(let i=0;i<55;i++) {
    const x=-9.5+random()*5.8;
    const z=-3.35+random()*5;
    if(Math.abs(x+6.8)<.95 && z<.25)continue;
    const size=.16+random()*.31;
    add(x,z,size*(.85+random()*.5),size*(.6+random()*.4),size,'rubble',.25);
  }
  const reefs=[[-6.9,6.85,2.8],[-2.5,8.45,2.25],[6.2,5.2,2.1]];
  reefs.forEach(([cx,cz,r],cluster)=>{
    for(let i=0;i<16;i++) {
      const angle=random()*Math.PI*2,dist=Math.sqrt(random())*r;
      const x=cx+Math.cos(angle)*dist,z=cz+Math.sin(angle)*dist*.7;
      if(Math.abs(x)>9.55 || z>9.6)continue;
      const size=.26+random()*.64;
      add(x,z,size*(1+random()*.6),size*(.4+random()*.6),size*(.65+random()*.6),'reef',.1,cluster*.5+(random()-.5)*.4);
    }
  });
  for(let i=0;i<260;i++) {
    const x=-4.1+random()*6.6,z=.2+random()*2.3;
    const size=.025+random()*.055;
    add(x,z,size*(.9+random()*.5),size*.6,size,'pebble',.25);
  }
  return rocks;
}
