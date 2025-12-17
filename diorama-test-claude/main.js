import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { Terrain } from './terrain.js';
import { River } from './river.js';
import { Clouds } from './clouds.js';
import { Trees } from './trees.js';
import { Grass } from './grass.js';
import { Weather } from './weather.js';
import { TimeOfDay } from './timeofday.js';

class Diorama {
    constructor() {
        this.container = document.getElementById('canvas-container');

        // Scene Setup
        this.scene = new THREE.Scene();
        this.scene.fog = new THREE.FogExp2(0x88ccff, 0.002);

        // Camera Setup
        this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
        this.camera.position.set(50, 40, 50);

        // Renderer Setup
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this.container.appendChild(this.renderer.domElement);

        // Controls
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.05;
        this.controls.maxPolarAngle = Math.PI / 2 - 0.05; // Prevent going below ground
        this.controls.target.set(0, 0, 0);

        // Initialize Systems
        this.timeOfDay = new TimeOfDay(this.scene, this.camera);
        this.terrain = new Terrain(this.scene);
        this.river = new River(this.scene);
        this.clouds = new Clouds(this.scene);
        this.trees = new Trees(this.scene);
        this.grass = new Grass(this.scene);
        this.weather = new Weather(this.scene);

        // State
        this.clock = new THREE.Clock();

        this.init();
        this.setupUI();
        this.animate();
    }

    init() {
        this.timeOfDay.init();
        this.terrain.init();
        this.river.init();
        this.clouds.init();
        this.trees.init();
        this.grass.init();
        this.weather.init();

        window.addEventListener('resize', this.onWindowResize.bind(this));
    }

    setupUI() {
        // Time Slider
        const timeSlider = document.getElementById('time-slider');
        const timeDisplay = document.getElementById('time-display');

        timeSlider.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            this.timeOfDay.update(val);

            // Format time string
            const hours = Math.floor(val);
            const minutes = Math.floor((val % 1) * 60);
            const timeString = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
            timeDisplay.textContent = timeString;
        });

        // Initialize time
        this.timeOfDay.update(parseFloat(timeSlider.value));

        // Wind Slider
        const windSlider = document.getElementById('wind-slider');
        windSlider.addEventListener('input', (e) => {
            const speed = parseFloat(e.target.value);
            // Propagate to relevant systems
            // this.grass.setWindSpeed(speed);
            // this.trees.setWindSpeed(speed);
            // this.clouds.setWindSpeed(speed);
            // this.weather.setWindSpeed(speed);
        });

        // Snow Slider
        const snowSlider = document.getElementById('snow-slider');
        snowSlider.addEventListener('input', (e) => {
            const intensity = parseFloat(e.target.value);
            this.weather.setSnowIntensity(intensity);
            if (this.terrain) this.terrain.setSnowIntensity(intensity);
        });
    }

    onWindowResize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
    }

    animate() {
        requestAnimationFrame(this.animate.bind(this));

        const time = this.clock.getElapsedTime();
        const deltaTime = this.clock.getDelta();

        this.controls.update();

        // Update systems
        // this.timeOfDay.update(deltaTime); // Time update handles day/night cycle progression if auto-playing
        this.terrain.update(deltaTime);
        this.river.update(deltaTime);
        this.clouds.update(time, deltaTime);
        this.trees.update(time, deltaTime);
        this.grass.update(time, deltaTime);
        this.weather.update(deltaTime);

        this.renderer.render(this.scene, this.camera);
    }
}

new Diorama();
