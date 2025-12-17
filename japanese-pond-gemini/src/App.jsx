import { Canvas } from '@react-three/fiber'
import { Experience } from './components/Experience'
import './index.css'

function App() {
  return (
    <div style={{ width: '100vw', height: '100vh', background: '#111' }}>
      <Canvas shadows camera={{ position: [5, 5, 5], fov: 35 }}>
        <Experience />
      </Canvas>
    </div>
  )
}

export default App
