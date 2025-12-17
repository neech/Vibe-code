// Configuration
const config = {
    timeSpeed: 1.0,
    cloudDensity: 0.5,
    windSpeed: 0.3
};

// Scene setup
const canvas = document.getElementById('canvas');
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 1, 5000);
camera.position.set(0, 100, 400);

const renderer = new THREE.WebGLRenderer({
    canvas: canvas,
    antialias: true,
    alpha: false
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x87CEEB);

// Controls
const controls = new THREE.OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.minDistance = 100;
controls.maxDistance = 1000;
controls.maxPolarAngle = Math.PI * 0.85;
controls.target.set(0, 80, 0);

// Create sky dome
const skyGeometry = new THREE.SphereGeometry(2000, 32, 32);
const skyMaterial = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
        topColor: { value: new THREE.Color(0x0077ff) },
        bottomColor: { value: new THREE.Color(0xffffff) },
        offset: { value: 400 },
        exponent: { value: 0.6 }
    },
    vertexShader: `
        varying vec3 vWorldPosition;
        void main() {
            vec4 worldPosition = modelMatrix * vec4(position, 1.0);
            vWorldPosition = worldPosition.xyz;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,
    fragmentShader: `
        uniform vec3 topColor;
        uniform vec3 bottomColor;
        uniform float offset;
        uniform float exponent;
        varying vec3 vWorldPosition;
        
        void main() {
            float h = normalize(vWorldPosition + offset).y;
            gl_FragColor = vec4(mix(bottomColor, topColor, max(pow(max(h, 0.0), exponent), 0.0)), 1.0);
        }
    `
});
const sky = new THREE.Mesh(skyGeometry, skyMaterial);
scene.add(sky);

// Sun
const sunGeometry = new THREE.SphereGeometry(50, 32, 32);
const sunMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffcc,
    transparent: true,
    opacity: 0.9
});
const sun = new THREE.Mesh(sunGeometry, sunMaterial);
sun.position.set(500, 400, -800);
scene.add(sun);

// Sun glow
const glowGeometry = new THREE.SphereGeometry(80, 32, 32);
const glowMaterial = new THREE.MeshBasicMaterial({
    color: 0xffff88,
    transparent: true,
    opacity: 0.3
});
const glow = new THREE.Mesh(glowGeometry, glowMaterial);
glow.position.copy(sun.position);
scene.add(glow);

// Lighting
const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(ambientLight);

const directionalLight = new THREE.DirectionalLight(0xfff5e6, 1.2);
directionalLight.position.copy(sun.position);
scene.add(directionalLight);

// Cloud particle texture
function createCloudTexture() {
    const size = 256;
    const textureCanvas = document.createElement('canvas');
    textureCanvas.width = size;
    textureCanvas.height = size;
    const ctx = textureCanvas.getContext('2d');

    // Create radial gradient for soft cloud look
    const gradient = ctx.createRadialGradient(
        size / 2, size / 2, 0,
        size / 2, size / 2, size / 2
    );
    gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
    gradient.addColorStop(0.4, 'rgba(255, 255, 255, 0.8)');
    gradient.addColorStop(0.7, 'rgba(255, 255, 255, 0.3)');
    gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');

    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);

    return new THREE.CanvasTexture(textureCanvas);
}

const cloudTexture = createCloudTexture();

// Cloud class - uses multiple billboarded sprites
class Cloud {
    constructor(position, scale) {
        this.group = new THREE.Group();
        this.group.position.copy(position);
        this.baseY = position.y;
        this.offset = Math.random() * Math.PI * 2;
        this.scale = scale;

        // Create cloud from multiple overlapping sprites
        const numPuffs = 8 + Math.floor(Math.random() * 8);

        for (let i = 0; i < numPuffs; i++) {
            const puffMaterial = new THREE.SpriteMaterial({
                map: cloudTexture,
                transparent: true,
                opacity: 0.7 + Math.random() * 0.3,
                depthWrite: false,
                color: new THREE.Color(1, 1, 1)
            });

            const sprite = new THREE.Sprite(puffMaterial);

            // Random position within cloud bounds
            const spread = 60 * scale;
            sprite.position.set(
                (Math.random() - 0.5) * spread,
                (Math.random() - 0.5) * spread * 0.3,
                (Math.random() - 0.5) * spread * 0.5
            );

            // Random scale for each puff
            const puffScale = (40 + Math.random() * 40) * scale;
            sprite.scale.set(puffScale, puffScale, 1);

            this.group.add(sprite);
        }

        scene.add(this.group);
    }

    update(time, windSpeed) {
        // Gentle floating motion
        this.group.position.y = this.baseY + Math.sin(time * 0.3 + this.offset) * 5;

        // Drift with wind
        this.group.position.x += windSpeed * 0.5;

        // Wrap around when too far
        if (this.group.position.x > 600) {
            this.group.position.x = -600;
        }
    }
}

// Create multiple clouds
const clouds = [];
const cloudConfigs = [
    // Layer 1 - Low clouds
    { x: -300, y: 80, z: -200, scale: 1.5 },
    { x: 100, y: 90, z: -300, scale: 2.0 },
    { x: 350, y: 70, z: -150, scale: 1.3 },
    { x: -150, y: 85, z: 100, scale: 1.7 },
    { x: 250, y: 75, z: 50, scale: 1.4 },

    // Layer 2 - Mid clouds
    { x: -400, y: 120, z: -100, scale: 2.2 },
    { x: 0, y: 130, z: -250, scale: 2.5 },
    { x: 300, y: 110, z: -200, scale: 1.8 },
    { x: -200, y: 125, z: 150, scale: 2.0 },
    { x: 450, y: 115, z: 100, scale: 1.6 },

    // Layer 3 - High clouds (cirrus-like)
    { x: -350, y: 180, z: -50, scale: 3.0 },
    { x: 150, y: 200, z: -150, scale: 2.8 },
    { x: -100, y: 190, z: 50, scale: 2.5 },
    { x: 400, y: 170, z: -80, scale: 2.3 },

    // Additional scattered clouds
    { x: -500, y: 100, z: 200, scale: 1.9 },
    { x: 500, y: 95, z: -100, scale: 1.5 },
    { x: -250, y: 140, z: -300, scale: 2.1 },
    { x: 200, y: 160, z: 200, scale: 1.8 }
];

cloudConfigs.forEach(function (cfg) {
    const cloud = new Cloud(
        new THREE.Vector3(cfg.x, cfg.y, cfg.z),
        cfg.scale
    );
    clouds.push(cloud);
});

// Volumetric cloud layer using shader
const volumetricCloudMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
        uTime: { value: 0 },
        uDensity: { value: 0.5 },
        uSunPosition: { value: sun.position.clone().normalize() }
    },
    vertexShader: `
        varying vec2 vUv;
        varying vec3 vPosition;
        
        void main() {
            vUv = uv;
            vPosition = position;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,
    fragmentShader: `
        uniform float uTime;
        uniform float uDensity;
        uniform vec3 uSunPosition;
        
        varying vec2 vUv;
        varying vec3 vPosition;
        
        // Simple noise
        float hash(vec2 p) {
            return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }
        
        float noise(vec2 p) {
            vec2 i = floor(p);
            vec2 f = fract(p);
            f = f * f * (3.0 - 2.0 * f);
            
            float a = hash(i);
            float b = hash(i + vec2(1.0, 0.0));
            float c = hash(i + vec2(0.0, 1.0));
            float d = hash(i + vec2(1.0, 1.0));
            
            return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
        }
        
        float fbm(vec2 p) {
            float value = 0.0;
            float amplitude = 0.5;
            for (int i = 0; i < 5; i++) {
                value += amplitude * noise(p);
                p *= 2.0;
                amplitude *= 0.5;
            }
            return value;
        }
        
        void main() {
            vec2 uv = vUv;
            
            // Animate UVs
            vec2 animUv = uv + vec2(uTime * 0.02, uTime * 0.01);
            
            // Generate cloud pattern
            float n = fbm(animUv * 4.0);
            n = fbm(animUv * 4.0 + n * 0.5);
            
            // Cloud shape
            float cloud = smoothstep(0.4 - uDensity * 0.3, 0.6, n);
            
            // Edge fade
            float edgeFade = smoothstep(0.0, 0.2, vUv.x) * smoothstep(1.0, 0.8, vUv.x);
            edgeFade *= smoothstep(0.0, 0.2, vUv.y) * smoothstep(1.0, 0.8, vUv.y);
            cloud *= edgeFade;
            
            // Lighting
            float light = 0.7 + 0.3 * n;
            
            vec3 cloudColor = vec3(1.0, 1.0, 1.0) * light;
            vec3 shadowColor = vec3(0.7, 0.75, 0.85);
            vec3 finalColor = mix(shadowColor, cloudColor, light);
            
            gl_FragColor = vec4(finalColor, cloud * 0.6);
        }
    `
});

// Create volumetric cloud planes
for (let i = 0; i < 5; i++) {
    const planeGeo = new THREE.PlaneGeometry(800, 400);
    const planeMat = volumetricCloudMaterial.clone();
    const plane = new THREE.Mesh(planeGeo, planeMat);

    plane.position.set(
        (Math.random() - 0.5) * 600,
        150 + i * 30,
        -400 - i * 100
    );
    plane.rotation.x = -0.1;

    scene.add(plane);
}

// Ground plane
const groundGeometry = new THREE.PlaneGeometry(4000, 4000);
const groundMaterial = new THREE.MeshLambertMaterial({
    color: 0x4a7c3f
});
const ground = new THREE.Mesh(groundGeometry, groundMaterial);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -20;
scene.add(ground);

// Add some terrain variation
const hillGeometry = new THREE.SphereGeometry(200, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2);
const hillMaterial = new THREE.MeshLambertMaterial({ color: 0x5a8c4f });

for (let i = 0; i < 8; i++) {
    const hill = new THREE.Mesh(hillGeometry, hillMaterial);
    hill.position.set(
        (Math.random() - 0.5) * 1500,
        -20,
        (Math.random() - 0.5) * 1500
    );
    hill.scale.set(
        0.5 + Math.random() * 0.5,
        0.2 + Math.random() * 0.3,
        0.5 + Math.random() * 0.5
    );
    scene.add(hill);
}

// Atmospheric fog
scene.fog = new THREE.FogExp2(0xc4dff6, 0.0004);

// UI Controls
document.getElementById('timeSpeed').addEventListener('input', function (e) {
    config.timeSpeed = parseFloat(e.target.value);
});

document.getElementById('cloudDensity').addEventListener('input', function (e) {
    config.cloudDensity = parseFloat(e.target.value);
});

document.getElementById('windSpeed').addEventListener('input', function (e) {
    config.windSpeed = parseFloat(e.target.value);
});

// Handle window resize
window.addEventListener('resize', function () {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// Animation loop
const clock = new THREE.Clock();

function animate() {
    requestAnimationFrame(animate);

    const elapsedTime = clock.getElapsedTime() * config.timeSpeed;
    const windSpeed = config.windSpeed;

    // Update clouds
    clouds.forEach(function (cloud) {
        cloud.update(elapsedTime, windSpeed);
    });

    // Update volumetric cloud materials
    scene.traverse(function (obj) {
        if (obj.material && obj.material.uniforms) {
            if (obj.material.uniforms.uTime) {
                obj.material.uniforms.uTime.value = elapsedTime;
            }
            if (obj.material.uniforms.uDensity) {
                obj.material.uniforms.uDensity.value = config.cloudDensity;
            }
        }
    });

    controls.update();
    renderer.render(scene, camera);
}

animate();

console.log('☁️ Cloud Simulation loaded successfully!');
console.log('Clouds created:', clouds.length);
