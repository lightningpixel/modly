import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Canvas, useLoader } from '@react-three/fiber'
import * as THREE from 'three'

import LiveTexturePanel from '../src/areas/generate/components/LiveTexturePanel'
import '../src/styles/globals.css'
import './styles.css'

function ProofModel({ onObject }: { onObject: (object: THREE.Object3D) => void }): JSX.Element {
  const texture = useLoader(THREE.TextureLoader, '/paint.png')
  texture.colorSpace = THREE.SRGBColorSpace
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.NearestFilter
  texture.generateMipmaps = false

  return (
    <group ref={(value) => { if (value) onObject(value) }} rotation={[0.25, -0.55, 0]}>
      <mesh>
        <boxGeometry args={[2.5, 2.5, 2.5]} />
        <meshStandardMaterial map={texture} roughness={0.78} />
      </mesh>
    </group>
  )
}

function App(): JSX.Element {
  const [object, setObject] = useState<THREE.Object3D | null>(null)

  useEffect(() => {
    const report = (event: Event) => {
      const detail = (event as CustomEvent).detail as {
        savedAt?: number
        detectedAt: number
        appliedAt: number
        revision: number
      }
      const latency = detail.savedAt ? Math.round(detail.appliedAt - detail.savedAt) : null
      console.log(JSON.stringify({ event: 'texture-updated', latency, ...detail }))
    }
    window.addEventListener('modly:texture-updated', report)
    return () => window.removeEventListener('modly:texture-updated', report)
  }, [])

  return (
    <main
      className="relative overflow-hidden bg-zinc-900"
      style={{ width: '100vw', height: '100vh' }}
    >
      <div className="absolute left-5 top-5 z-10">
        <h1 className="text-base font-semibold text-white">Texture update proof</h1>
        <p className="mt-1 text-xs text-zinc-400">The cube changes when paint.png is saved.</p>
      </div>
      <Canvas camera={{ position: [0, 0.4, 6], fov: 42 }} dpr={1}>
        <color attach="background" args={['#18181b']} />
        <ambientLight intensity={1.2} />
        <directionalLight position={[4, 6, 5]} intensity={3} />
        <ProofModel onObject={setObject} />
      </Canvas>
      <LiveTexturePanel object={object} onApplied={() => undefined} />
      <p className="absolute bottom-5 left-1/2 -translate-x-1/2 text-xs text-zinc-500">
        Watching a file outside Modly
      </p>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
