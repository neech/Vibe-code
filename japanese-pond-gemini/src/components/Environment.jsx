export const Environment = () => {
    return (
        <group>
            {/* Rocks around the edge */}
            <mesh position={[4, 0, 0]} castShadow receiveShadow>
                <dodecahedronGeometry args={[0.8, 1]} />
                <meshStandardMaterial color="#666" roughness={0.8} />
            </mesh>
            <mesh position={[-3, 0.2, 2]} castShadow receiveShadow>
                <dodecahedronGeometry args={[1.2, 1]} />
                <meshStandardMaterial color="#555" roughness={0.9} />
            </mesh>
            <mesh position={[2, -0.1, -4]} castShadow receiveShadow>
                <dodecahedronGeometry args={[0.9, 1]} />
                <meshStandardMaterial color="#777" roughness={0.7} />
            </mesh>

            {/* Lily Pads */}
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[2, -0.09, 1]}>
                <circleGeometry args={[0.4, 32]} />
                <meshStandardMaterial color="#4a8" />
            </mesh>
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[-1.5, -0.09, -2]}>
                <circleGeometry args={[0.3, 32]} />
                <meshStandardMaterial color="#396" />
            </mesh>
        </group>
    )
}
