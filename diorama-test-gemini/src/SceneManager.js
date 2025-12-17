import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import GUI from 'lil-gui';
import { Environment } from './components/Environment.js';
import { Terrain } from './components/Terrain.js';
import { Water } from './components/Water.js';
import { Vegetation } from './components/Vegetation.js';
import { Weather } from './components/Weather.js';

export class SceneManager {
    constructor(container) {
        this.container = container;
        this.scene = new THREE.Scene();
        this.clock = new THREE.Clock();

        this.initRenderer();
        this.initCamera();
        this.initControls();

        // Debug GUI
        this.gui = new GUI();

        // Components container
        this.components = [];

        // Initialize Components
        this.environment = new Environment(this.scene, this.gui);
        this.components.push(this.environment);

        this.terrain = new Terrain(this.scene);
        this.components.push(this.terrain);

        this.water = new Water(this.scene);
        this.components.push(this.water);

        this.vegetation = new Vegetation(this.scene, this.terrain.geometry);
        this.components.push(this.vegetation);

        this.weather = new Weather(this.scene, this.gui);
        this.components.push(this.weather);

        window.addEventListener('resize', this.onWindowResize.bind(this));

        this.animate();
    }

    initRenderer() {
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.container.appendChild(this.renderer.domElement);
    }

    initCamera() {
        this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
        this.camera.position.set(10, 8, 10);
        this.camera.lookAt(0, 0, 0);
    }

    initControls() {
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.05;
        this.controls.maxPolarAngle = Math.PI / 2 - 0.1;
    }

    onWindowResize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
    }

    animate() {
        requestAnimationFrame(this.animate.bind(this));

        const delta = this.clock.getDelta();
        const elapsedTime = this.clock.getElapsedTime();

        this.controls.update();

        // Update all components
        this.components.forEach(component => component.update(elapsedTime, delta));

        // Global Uniform Updates
        const snowLevel = this.weather.params.snowAccumulation;

        // Update Terrain
        if (this.terrain.material.uniforms.uSnowAccumulation) {
            this.terrain.material.uniforms.uSnowAccumulation.value = snowLevel;
        }

        // Update Vegetation (Grass + Trees)
        if (this.vegetation) {
            this.vegetation.updateSnow(snowLevel);
        }

        this.renderer.render(this.scene, this.camera);
    }
}
