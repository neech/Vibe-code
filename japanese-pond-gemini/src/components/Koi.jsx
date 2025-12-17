import { useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'

const KoiBody = ({ color }) => (
    <group>
        {/* Main Body */}
        <mesh castShadow position={[0, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
            <capsuleGeometry args={[0.15, 0.6, 4, 16]} />
            <meshStandardMaterial color={color} roughness={0.3} />
        </mesh>

        {/* Tail connection */}
        <mesh position={[-0.4, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
            <coneGeometry args={[0.1, 0.3, 16]} />
            <meshStandardMaterial color={color} roughness={0.3} />
        </mesh>

        {/* Top Fin */}
        <mesh position={[0, 0.2, 0]} rotation={[0, 0, -Math.PI / 4]} castShadow>
            <boxGeometry args={[0.2, 0.1, 0.02]} />
            <meshStandardMaterial color={color} transparent opacity={0.8} />
        </mesh>

        {/* Side Fins */}
        <mesh position={[0.1, 0, 0.15]} rotation={[Math.PI / 3, Math.PI / 4, 0]} castShadow>
            <boxGeometry args={[0.15, 0.08, 0.02]} />
            <meshStandardMaterial color={'white'} transparent opacity={0.6} />
        </mesh>
        <mesh position={[0.1, 0, -0.15]} rotation={[-Math.PI / 3, Math.PI / 4, 0]} castShadow>
            <boxGeometry args={[0.15, 0.08, 0.02]} />
            <meshStandardMaterial color={'white'} transparent opacity={0.6} />
        </mesh>

        {/* Tail Fin */}
        <mesh position={[-0.6, 0, 0]} rotation={[0, 0, 0]}>
            <boxGeometry args={[0.2, 0.25, 0.02]} />
            <meshStandardMaterial color={'white'} transparent opacity={0.6} />
        </mesh>

        {/* Eyes */}
        <mesh position={[0.35, 0.05, 0.08]}>
            <sphereGeometry args={[0.02, 8, 8]} />
            <meshStandardMaterial color="black" />
        </mesh>
        <mesh position={[0.35, 0.05, -0.08]}>
            <sphereGeometry args={[0.02, 8, 8]} />
            <meshStandardMaterial color="black" />
        </mesh>
    </group>
)

export const Koi = ({ position = [0, 0, 0], color = '#ff5500' }) => {
    const group = useRef()
    // Random starting offset for movement
    const offset = useMemo(() => Math.random() * 100, [])
    const speed = useMemo(() => 0.5 + Math.random() * 0.5, [])
    const radius = useMemo(() => 2 + Math.random() * 2, [])

    useFrame(({ clock }) => {
        const t = clock.getElapsedTime() * speed + offset
        // Simple circular motion with some noise
        const x = Math.sin(t) * radius
        const z = Math.cos(t) * radius * 0.8 // Slightly elliptical

        if (group.current) {
            group.current.position.x = x
            group.current.position.z = z

            // Face direction of movement
            // Tangent vector is (cos(t), -sin(t))
            const angle = Math.atan2(-Math.sin(t) * 0.8, Math.cos(t))
            group.current.rotation.y = angle

            // Minimal vertical bobbing
            group.current.position.y = position[1] + Math.sin(t * 2) * 0.05
        }
    })

    return (
        <group ref={group} position={position}>
            <KoiBody color={color} />
        </group>
    )
}
