import { Canvas, useThree } from '@react-three/fiber'
import { Environment, OrbitControls, Sky, Cloud, CameraShake } from '@react-three/drei'
import { Suspense } from 'react'
import { MathUtils } from 'three'
import { Grass } from './Grass'
import { BlobGeometry } from './BlobGeometry'
import { Butterfly } from './Butterfly'
import { Particles } from './Particles'
import { button, useControls } from 'leva'
import Tag from './Tag'

const rand = new Array(15).fill(0).map(() => ({
  position: [
    MathUtils.randFloat(0.5, 0.7),
    MathUtils.randFloat(0.5, 0.7),
    MathUtils.randFloat(0.5, 0.7)
  ],
  scale: MathUtils.randFloat(0.5, 1)
}))

function Capture() {
  const gl = useThree((state) => state.gl)
  useControls({
    screenshot: button(() => {
      const link = document.createElement('a')
      link.setAttribute('download', 'canvas.png')
      link.setAttribute(
        'href',
        gl.domElement.toDataURL('image/png').replace('image/png', 'image/octet-stream')
      )
      link.click()
    })
  })

  return null
}

export const App = () => {
  return (
    <>
      <Canvas
        dpr={1.5}
        camera={{ position: [1, -1.25, 1] }} //
        // gl={{ preserveDrawingBuffer: true }}
      >
        <Suspense fallback={null}>
          <Grass>
            <BlobGeometry />
          </Grass>
          {rand.map((e, i) => (
            <Butterfly key={i} {...e} />
          ))}

          <Clouds />
          <Sky />
          <Environment preset="sunset" />
        </Suspense>
        <Particles />
        {/* <Capture /> */}

        <OrbitControls enableZoom={false} makeDefault autoRotate autoRotateSpeed={0.8} />
        {/* <OrbitControls makeDefault /> */}
        <CameraShake maxRoll={0.2} maxPitch={0.2} maxYaw={0.2} />
      </Canvas>
      <Tag />
    </>
  )
}

function Clouds() {
  return (
    <group>
      <Cloud position={[-10, -6, -10]} speed={0.2} opacity={0.4} />
      <Cloud position={[10, 6, -15]} speed={0.2} opacity={0.25} />
      <Cloud position={[0, 10, 0]} speed={0.2} opacity={0.2} />
      <Cloud position={[0, -10, 0]} speed={0.2} opacity={0.2} />
      <Cloud position={[-10, -6, 15]} speed={0.2} opacity={0.3} />
      <Cloud position={[10, 6, 10]} speed={0.2} opacity={0.25} />
    </group>
  )
}
