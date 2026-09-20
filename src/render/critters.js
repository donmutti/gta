// Small walking life: a dog mesh the simulation walks and turns, and a pigeon fleet in the
// instanced style with a peck/alert/fly mode per bird. Meshes here; behaviour is Padawan's.
import * as THREE from 'three';

// --- dog: low-poly but not a box — body capsule, head, snout, four legs, tail ---------------
export function makeDog(coat = 0x8a6a44) {
  const g = new THREE.Group();
  const fur = new THREE.MeshStandardMaterial({color: coat, roughness: 0.9});
  const dark = new THREE.MeshStandardMaterial({color: 0x2a2018, roughness: 0.9});
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 0.42, 3, 8).rotateZ(Math.PI / 2), fur);
  body.position.set(0, 0.34, 0);
  const chest = new THREE.Mesh(new THREE.SphereGeometry(0.17, 8, 6), fur); chest.position.set(0.28, 0.34, 0);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.19, 0.18), fur); head.position.set(0.42, 0.44, 0);
  const snout = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.10, 0.11), dark); snout.position.set(0.52, 0.40, 0);
  const earL = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.10, 0.07), fur); earL.position.set(0.40, 0.55, 0.07);
  const earR = earL.clone(); earR.position.z = -0.07;
  g.add(body, chest, head, snout, earL, earR);
  // named leg pivots so the sim can trot them; static mid-stride if it does not
  const legGeo = new THREE.BoxGeometry(0.06, 0.28, 0.06);
  const legs = [['legFL', 0.26, 0.11], ['legFR', 0.26, -0.11], ['legRL', -0.20, 0.11], ['legRR', -0.20, -0.11]];
  for (const [name, x, z] of legs) {
    const pivot = new THREE.Group(); pivot.name = name; pivot.position.set(x, 0.28, z);
    const leg = new THREE.Mesh(legGeo, dark); leg.position.y = -0.14; pivot.add(leg);
    g.add(pivot);
  }
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.05, 0.05), fur);
  tail.position.set(-0.34, 0.42, 0); tail.rotation.z = 0.5; g.add(tail);
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  g.scale.setScalar(0.9);
  return g;
}

// --- pigeon fleet: instanced body+head, mode 0 peck / 1 alert / 2 flying -------------------
// Body pitches down to peck, up when alert, and the whole bird lifts with spread wings in fly.
export function makePigeonFleet(count) {
  const bodyG = new THREE.SphereGeometry(0.09, 6, 5); bodyG.scale(1.5, 0.9, 0.9);
  const wingG = new THREE.PlaneGeometry(0.26, 0.10);
  const grey = new THREE.MeshStandardMaterial({color: 0x8891a0, roughness: 0.8});
  const wingM = new THREE.MeshStandardMaterial({color: 0x9aa2b0, roughness: 0.8, side: THREE.DoubleSide});
  const bodies = new THREE.InstancedMesh(bodyG, grey, count);
  const wings = new THREE.InstancedMesh(wingG, wingM, count * 2);
  const group = new THREE.Group(); group.add(bodies, wings);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1,1,1), e = new THREE.Euler();
  // setAt: x,z ground pos, heading, mode 0/1/2, and a flap phase (sim ticks it for flyers)
  const setAt = (i, x, z, rotY, mode = 0, y = 0, flap = 0) => {
    const pitch = mode === 0 ? 0.5 : mode === 1 ? -0.25 : -0.1;
    const yy = mode === 2 ? 0.6 + y : 0.12;
    e.set(pitch, rotY, 0); q.setFromEuler(e); m.compose(new THREE.Vector3(x, yy, -z), q, s);
    bodies.setMatrixAt(i, m);
    const wingLift = mode === 2 ? Math.sin(flap) * 0.9 : (mode === 1 ? 0.2 : 0.05);
    for (const [k, sign] of [[0, 1], [1, -1]]) {
      e.set(0, rotY, sign * (0.3 + wingLift)); q.setFromEuler(e);
      m.compose(new THREE.Vector3(x, yy + 0.02, -z), q, new THREE.Vector3(1, 1, sign));
      wings.setMatrixAt(i * 2 + k, m);
    }
    bodies.instanceMatrix.needsUpdate = true; wings.instanceMatrix.needsUpdate = true;
  };
  bodies.castShadow = true;
  return {group, setAt, count};
}
