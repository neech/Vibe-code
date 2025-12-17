import { useRef } from 'react'
import { MeshTransmissionMaterial } from '@react-three/drei'
import { Color } from 'three'

export const Pond = () => {
    return (
        <group>
            {/* Water Surface */}
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.1, 0]}>
                <planeGeometry args={[15, 15, 32, 32]} />
                <MeshTransmissionMaterial
                    backside
                    samples={4}
                    resolution={512}
                    thickness={0.5}
                    roughness={0.2}
                    ior={1.5}
                    chromaticAberration={0.05}
                    anisotropy={0.1}
                    distortion={0.5}
                    distortionScale={0.5}
                    temporalDistortion={0.2}
                    color="#aaddff"
                    attenuationColor="#ffffff"
                    attenuationDistance={1}
                />
            </mesh>

            {/* Pond Bed */}
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.5, 0]} receiveShadow>
                <planeGeometry args={[15, 15]} />
                <meshStandardMaterial color="#554433" roughness={0.8} />
            </mesh>
        </group>
    )
}
