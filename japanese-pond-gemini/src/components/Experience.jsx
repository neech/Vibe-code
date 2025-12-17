import { OrbitControls, Environment } from '@react-three/drei'
import { EffectComposer, Bloom, Vignette } from '@react-three/postprocessing'
import { Pond } from './Pond'
import { Environment as SceneEnvironment } from './Environment'
import { Koi } from './Koi'

export const Experience = () => {
    return (
        <>
            <OrbitControls makeDefault maxPolarAngle={Math.PI / 2 - 0.1} />

            {/* Lighting */}
            <Environment preset="sunset" background blur={0.6} />
            <directionalLight
                position={[10, 10, 5]}
                intensity={1.5}
                castShadow
                shadow-mapSize={[2048, 2048]}
            />
            <ambientLight intensity={0.4} />

            {/* Scene Components */}
            <Pond />
            <SceneEnvironment />
            <Koi position={[0, -0.2, 0]} color="#ff4400" />
            <Koi position={[0, -0.3, 0]} color="#ffffff" />
            <Koi position={[0, -0.2, 0]} color="#ffaa00" />
            <Koi position={[0, -0.25, 0]} color="#aa2200" />

            <EffectComposer>
                <Bloom luminanceThreshold={1} intensity={1.5} levels={9} mipmapBlur />
                <Vignette eskil={false} offset={0.1} darkness={1.1} />
            </EffectComposer>
        </>
    )
}
