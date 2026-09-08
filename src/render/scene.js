// Three.js scene: dusk sky, lights, shadows, chase camera. Render only.

import * as THREE from 'three';

export function createScene(container, { test = false, shadows = true, maxWidth = 640, maxHeight = 360 } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: !test, powerPreference: 'high-performance' });
  renderer.setPixelRatio(test ? 1 : Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = shadows;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const horizon = new THREE.Color(0xff7a45);
  const zenith = new THREE.Color(0x1b1440);
  scene.fog = new THREE.Fog(new THREE.Color(0x6a3a5a), 140, 900);
  renderer.setClearColor(horizon, 1);

  // Sky dome: vertical gradient, unaffected by fog.
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(1400, 24, 12),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: { horizon: { value: horizon }, zenith: { value: zenith }, glow: { value: new THREE.Color(0xffc077) } },
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform vec3 horizon; uniform vec3 zenith; uniform vec3 glow; varying vec3 vDir;
        void main(){ float h = clamp(vDir.y, -0.05, 1.0); vec3 c = mix(horizon, zenith, pow(h, 0.55));
        float sun = pow(max(0.0, dot(normalize(vDir), normalize(vec3(-0.6, 0.12, -0.78)))), 40.0);
        c += glow * sun * 0.9; gl_FragColor = vec4(c, 1.0); }`,
    })
  );
  scene.add(sky);

  const hemi = new THREE.HemisphereLight(0x8a70c0, 0x3a2a30, 0.55);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffb070, 2.2);
  sun.castShadow = shadows;
  const shadowSize = test ? 1024 : 2048;
  sun.shadow.mapSize.set(shadowSize, shadowSize);
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = 600;
  const ext = 110;
  sun.shadow.camera.left = -ext;
  sun.shadow.camera.right = ext;
  sun.shadow.camera.top = ext;
  sun.shadow.camera.bottom = -ext;
  sun.shadow.bias = -0.0008;
  sun.shadow.normalBias = 0.6;
  scene.add(sun);
  scene.add(sun.target);

  const camera = new THREE.PerspectiveCamera(62, 1, 0.5, 2500);
  const camPos = new THREE.Vector3(0, 30, -40);
  const camLook = new THREE.Vector3();

  function resize() {
    const w = test ? Math.min(container.clientWidth, maxWidth) : container.clientWidth;
    const h = test ? Math.min(container.clientHeight, maxHeight) : container.clientHeight;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  const sunDir = new THREE.Vector3(-0.6, 0.32, -0.78).normalize();

  return {
    renderer,
    scene,
    camera,
    sun,
    /** Chase camera + moving shadow volume around the followed kart. */
    follow(kart, dt, mode = 'chase') {
      const fx = Math.sin(kart.heading), fz = Math.cos(kart.heading);
      const back = 7.5 + Math.abs(kart.speed) * 0.08;
      let tx, ty, tz;
      if (mode === 'intro') {
        tx = kart.x - fx * 18 + fz * 9;
        ty = kart.y + 7;
        tz = kart.z - fz * 18 - fx * 9;
      } else {
        tx = kart.x - fx * back;
        ty = kart.y + 3.4;
        tz = kart.z - fz * back;
      }
      const k = 1 - Math.pow(0.001, dt);
      camPos.lerp(new THREE.Vector3(tx, ty, tz), k);
      camLook.lerp(new THREE.Vector3(kart.x + fx * 6, kart.y + 1.2, kart.z + fz * 6), k);
      camera.position.copy(camPos);
      camera.lookAt(camLook);
      sun.target.position.set(kart.x, kart.y, kart.z);
      sun.position.copy(sun.target.position).addScaledVector(sunDir, 260);
      sky.position.copy(camera.position);
    },
    render() {
      renderer.render(scene, camera);
    },
  };
}
