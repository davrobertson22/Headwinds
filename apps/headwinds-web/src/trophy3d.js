// 3D trophies — a turntable viewer and a poster renderer for .glb models.
//
// three.js is NOT bundled. Like MapLibre on the globe (src/components/
// globeCore.js) it is loaded from a CDN the first time anyone opens a 3D
// trophy, so the lobby and the game never pay for it. jsDelivr's "+esm" build
// rewrites the addons' bare `three` import to the same core URL loaded here, so
// there is exactly one copy of three in the page.
//
// No React in this file: tools/event-worlds-test.mjs drives it in headless
// Chromium with a real WebGL context. Trophies.jsx wraps it.

export const THREE_VERSION = '0.169.0';
const CDN = `https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}`;
export const THREE_URLS = {
  core: `${CDN}/+esm`,
  gltf: `${CDN}/examples/jsm/loaders/GLTFLoader.js/+esm`,
  orbit: `${CDN}/examples/jsm/controls/OrbitControls.js/+esm`,
  room: `${CDN}/examples/jsm/environments/RoomEnvironment.js/+esm`,
};

let threePromise = null;
/** Load three + the three addons used here, once per page. */
export function loadThree(urls = THREE_URLS) {
  if (!threePromise) {
    threePromise = Promise.all([
      import(/* @vite-ignore */ urls.core),
      import(/* @vite-ignore */ urls.gltf),
      import(/* @vite-ignore */ urls.orbit),
      import(/* @vite-ignore */ urls.room),
    ]).then(([THREE, g, o, r]) => ({ THREE, GLTFLoader: g.GLTFLoader, OrbitControls: o.OrbitControls, RoomEnvironment: r.RoomEnvironment }))
      .catch((e) => { threePromise = null; throw e; });
  }
  return threePromise;
}

function makeRenderer(THREE, canvas, { width, height, preserve = false }) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: preserve });
  renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio || 1));
  renderer.setSize(width, height, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  return renderer;
}

function stage(three, renderer, gltfScene) {
  const { THREE, RoomEnvironment } = three;
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = env;
  // A softer environment keeps dark materials (a black plinth) dark.
  scene.environmentIntensity = 0.5;
  const key = new THREE.DirectionalLight(0xffffff, 1.1);
  key.position.set(3, 5, 4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffffff, 0.5);
  rim.position.set(-4, 3, -3);
  scene.add(rim);
  scene.add(gltfScene);
  pmrem.dispose();
  return { scene, env };
}

// Place the camera so the whole model fits, seen from azimuth/elevation (deg).
function frame(THREE, camera, object, { az = 35, el = 18, pad = 1.08 } = {}) {
  const box = new THREE.Box3().setFromObject(object);
  const center = box.getCenter(new THREE.Vector3());
  const radius = box.getBoundingSphere(new THREE.Sphere()).radius || 1;
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const dist = (radius * pad) / Math.sin(fov / 2);
  const a = THREE.MathUtils.degToRad(az), e = THREE.MathUtils.degToRad(el);
  camera.position.set(
    center.x + dist * Math.cos(e) * Math.sin(a),
    center.y + dist * Math.sin(e),
    center.z + dist * Math.cos(e) * Math.cos(a),
  );
  camera.near = dist / 100;
  camera.far = dist * 100;
  camera.updateProjectionMatrix();
  camera.lookAt(center);
  return { center, radius, dist };
}

async function parseGlb(three, source) {
  const loader = new three.GLTFLoader();
  if (typeof source === 'string') return loader.loadAsync(source);
  return new Promise((resolve, reject) => loader.parse(source, '', resolve, reject));
}

function disposeTree(root) {
  root.traverse((o) => {
    o.geometry?.dispose?.();
    for (const m of [].concat(o.material ?? [])) {
      for (const v of Object.values(m)) if (v?.isTexture) v.dispose();
      m.dispose?.();
    }
  });
}

/**
 * Mount a turntable viewer into `canvas`: drag to orbit, scroll/pinch to zoom,
 * slow auto-rotate until the viewer touches it. `source` is a URL or an
 * ArrayBuffer of a .glb. Returns { dispose }.
 */
export async function mountTrophyViewer(canvas, source, { autoRotate = true, three = null } = {}) {
  const t = three ?? await loadThree();
  const { THREE, OrbitControls } = t;
  const width = canvas.clientWidth || canvas.width || 480;
  const height = canvas.clientHeight || canvas.height || 480;
  const renderer = makeRenderer(THREE, canvas, { width, height });
  const gltf = await parseGlb(t, source);
  const { scene, env } = stage(t, renderer, gltf.scene);
  const camera = new THREE.PerspectiveCamera(30, width / height, 0.01, 1000);
  const { center, dist } = frame(THREE, camera, gltf.scene);
  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(center);
  controls.enableDamping = true;
  controls.autoRotate = autoRotate;
  controls.autoRotateSpeed = 1.6;
  controls.minDistance = dist * 0.35;
  controls.maxDistance = dist * 2.5;
  controls.addEventListener('start', () => { controls.autoRotate = false; });
  let raf = 0, alive = true;
  const loop = () => {
    if (!alive) return;
    controls.update();
    renderer.render(scene, camera);
    raf = requestAnimationFrame(loop);
  };
  loop();
  const onResize = () => {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  globalThis.addEventListener?.('resize', onResize);
  return {
    dispose() {
      alive = false;
      cancelAnimationFrame(raf);
      globalThis.removeEventListener?.('resize', onResize);
      controls.dispose();
      disposeTree(gltf.scene);
      env.dispose();
      renderer.dispose();
    },
  };
}

/**
 * Render a still of a .glb (ArrayBuffer or URL) on a transparent background,
 * trimmed to the model with a small margin, at most `size` px on its long edge.
 * Used as the trophy's picture when only a model was uploaded. → PNG data URL.
 */
export async function renderTrophyPoster(source, { size = 512, az = 35, el = 18, three = null } = {}) {
  const t = three ?? await loadThree();
  const { THREE } = t;
  const R = size * 2;
  const canvas = document.createElement('canvas');
  canvas.width = R; canvas.height = R;
  const renderer = makeRenderer(THREE, canvas, { width: R, height: R, preserve: true });
  renderer.setPixelRatio(1);
  renderer.setSize(R, R, false);
  const gltf = await parseGlb(t, source);
  const { scene, env } = stage(t, renderer, gltf.scene);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 1000);
  frame(THREE, camera, gltf.scene, { az, el, pad: 1.0 });
  renderer.render(scene, camera);

  // Trim the transparent margin, then fit into `size` with 4% padding.
  const read = document.createElement('canvas');
  read.width = R; read.height = R;
  const rctx = read.getContext('2d');
  rctx.drawImage(canvas, 0, 0);
  const px = rctx.getImageData(0, 0, R, R).data;
  let x0 = R, y0 = R, x1 = -1, y1 = -1;
  for (let y = 0; y < R; y++) {
    for (let x = 0; x < R; x++) {
      if (px[(y * R + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
  }
  disposeTree(gltf.scene); env.dispose(); renderer.dispose();
  if (x1 < 0) throw new Error('The model rendered empty');
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const scale = Math.min(1, (size * 0.92) / Math.max(w, h));
  const side = Math.round((Math.max(w, h) * scale) / 0.92);
  const out = document.createElement('canvas');
  out.width = side; out.height = side;
  const dw = Math.round(w * scale), dh = Math.round(h * scale);
  out.getContext('2d').drawImage(read, x0, y0, w, h, Math.round((side - dw) / 2), Math.round((side - dh) / 2), dw, dh);
  return out.toDataURL('image/png');
}
