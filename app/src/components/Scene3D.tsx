// Lazy-loaded 3D preview: consumes the renderer-agnostic SceneSpec and draws
// it with three.js (orbit camera, sun + sky light). The 2D app never pays for
// three — this chunk loads on first open of the 3D view.
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { useCst } from '../store';
import { buildScene } from '../scene3d/buildScene';

// World is metres, y-down (plan). Three is y-up: world (x, y) → three (x, h, y).
// Shapes are built in XY and rotated flat, so geometry code stays 2D.
function prismMesh(polygon: number[], base: number, height: number, color: string): THREE.Mesh | null {
  if (polygon.length < 6) return null;
  const shape = new THREE.Shape();
  shape.moveTo(polygon[0], polygon[1]);
  for (let i = 2; i + 1 < polygon.length; i += 2) shape.lineTo(polygon[i], polygon[i + 1]);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
  const mat = new THREE.MeshLambertMaterial({ color: new THREE.Color(color) });
  const mesh = new THREE.Mesh(geo, mat);
  // XY shape → XZ ground plane; extrusion (+Z) becomes +Y (up)
  mesh.rotation.x = Math.PI / 2;
  mesh.scale.z = -1; // keep up positive after the rotation
  mesh.position.y = base;
  return mesh;
}

export default function Scene3D({ onClose }: { onClose: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current!;
    const s = useCst.getState();
    const spec = buildScene(
      { nodes: s.nodes, edges: s.edges, nextNodeNum: 0, nextEdgeNum: 0 },
      s.junctionDesigns,
      Object.values(s.elements),
      Object.values(s.patches),
      s.vertexOverrides,
      s.settings.junctionBlend,
      s.meshEdits,
    );

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(host.clientWidth, host.clientHeight);
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#dfe9f0');

    const b = spec.bounds;
    const cx = b ? (b.minX + b.maxX) / 2 : 0;
    const cy = b ? (b.minY + b.maxY) / 2 : 0;
    const span = b ? Math.max(b.maxX - b.minX, b.maxY - b.minY, 60) : 200;

    const camera = new THREE.PerspectiveCamera(50, host.clientWidth / host.clientHeight, 0.1, span * 12);
    camera.position.set(cx + span * 0.35, span * 0.45, cy + span * 0.55);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(cx, 0, cy);
    controls.maxPolarAngle = Math.PI / 2 - 0.03; // never dive below ground
    controls.update();

    scene.add(new THREE.HemisphereLight('#ffffff', '#c8bfa8', 1.1));
    const sun = new THREE.DirectionalLight('#fff4e0', 1.6);
    sun.position.set(cx + span, span * 0.9, cy - span * 0.6);
    scene.add(sun);

    // ground
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(span * 6, span * 6),
      new THREE.MeshLambertMaterial({ color: '#e8e2d2' }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(cx, -0.02, cy);
    scene.add(ground);

    for (const p of spec.prisms) {
      const m = prismMesh(p.polygon, p.base, p.height, p.color);
      if (m) scene.add(m);
    }

    // posts: shared geometries/materials, one mesh each (fine at these counts)
    const trunkGeo = new THREE.CylinderGeometry(0.12, 0.16, 2.4, 6);
    const canopyGeo = new THREE.SphereGeometry(1.7, 10, 8);
    const poleGeo = new THREE.CylinderGeometry(0.06, 0.08, 5, 6);
    const lampGeo = new THREE.SphereGeometry(0.22, 8, 6);
    const boxGeo = new THREE.BoxGeometry(0.8, 0.9, 0.8);
    const trunkMat = new THREE.MeshLambertMaterial({ color: '#5d4327' });
    const canopyMat = new THREE.MeshLambertMaterial({ color: '#4a7c3f' });
    const poleMat = new THREE.MeshLambertMaterial({ color: '#38404a' });
    const lampMat = new THREE.MeshBasicMaterial({ color: '#ffe9a8' });
    const boxMat = new THREE.MeshLambertMaterial({ color: '#7a5230' });
    for (const post of spec.posts) {
      const g = new THREE.Group();
      if (post.kind === 'tree') {
        const trunk = new THREE.Mesh(trunkGeo, trunkMat);
        trunk.position.y = 1.2;
        const canopy = new THREE.Mesh(canopyGeo, canopyMat);
        canopy.position.y = 3.2;
        g.add(trunk, canopy);
      } else if (post.kind === 'streetlight') {
        const pole = new THREE.Mesh(poleGeo, poleMat);
        pole.position.y = 2.5;
        const lamp = new THREE.Mesh(lampGeo, lampMat);
        lamp.position.y = 5;
        g.add(pole, lamp);
      } else {
        const box = new THREE.Mesh(boxGeo, boxMat);
        box.position.y = 0.45;
        g.add(box);
      }
      g.position.set(post.x, 0, post.y);
      scene.add(g);
    }

    let raf = 0;
    const tick = () => {
      controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    tick();

    const onResize = () => {
      camera.aspect = host.clientWidth / host.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(host.clientWidth, host.clientHeight);
    };
    window.addEventListener('resize', onResize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      controls.dispose();
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat?.dispose();
      });
      renderer.dispose();
      host.removeChild(renderer.domElement);
    };
  }, []);

  return (
    <div className="scene3d" ref={hostRef}>
      <button className="scene3d-close" onClick={onClose} title="Back to plan (Esc)">
        ✕ Plan view
      </button>
      <div className="scene3d-hint">Drag to orbit · scroll/pinch to zoom · right-drag to pan · heights: 150 mm kerbs</div>
    </div>
  );
}
