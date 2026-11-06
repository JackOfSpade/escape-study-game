import {
  type BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
} from "three";

/** Stable slots keep world objects in a handful of draw calls. Freed slots are
 * reused and hidden objects retain their slot until they leave the floor. */
export class InstancePool {
  readonly mesh: InstancedMesh<
    BufferGeometry,
    MeshStandardMaterial | MeshBasicMaterial
  >;
  private free: number[] = [];
  private transform = new Object3D();
  private hidden = new Matrix4().makeScale(0, 0, 0);
  private white = new Color(1, 1, 1);
  private colors = new Map<string, Color>();
  private poses: Float64Array;
  private shown: Uint8Array;
  private matrixFirst = Infinity;
  private matrixLast = -1;
  private colorFirst = Infinity;
  private colorLast = -1;
  private matrixRange = { start: 0, count: 0 };
  private colorRange = { start: 0, count: 0 };

  constructor(
    scene: Object3D,
    geometry: BufferGeometry,
    material: MeshStandardMaterial | MeshBasicMaterial,
    capacity: number,
    shadow = true,
  ) {
    this.mesh = new InstancedMesh(geometry, material, capacity);
    this.mesh.count = 0;
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = shadow;
    this.mesh.receiveShadow = shadow;
    this.poses = new Float64Array(capacity * 10);
    this.shown = new Uint8Array(capacity);
    scene.add(this.mesh);
  }

  allocate() {
    const recycled = this.free.pop(),
      slot = recycled ?? this.mesh.count;
    if (slot >= this.mesh.instanceMatrix.count)
      throw new Error("First-person instance capacity exceeded");
    if (recycled === undefined) {
      this.mesh.count++;
      // InstancedMesh starts with identity matrices, so the first hide is dirty.
      this.shown[slot] = 1;
    }
    this.hide(slot);
    this.setColor(slot, this.white);
    return slot;
  }

  release(slot: number) {
    this.hide(slot);
    this.free.push(slot);
  }

  hide(slot: number) {
    if (!this.shown[slot]) return;
    this.shown[slot] = 0;
    this.mesh.setMatrixAt(slot, this.hidden);
    this.matrixFirst = Math.min(this.matrixFirst, slot);
    this.matrixLast = Math.max(this.matrixLast, slot);
  }

  set(
    slot: number,
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    angle: number,
    color: Color | string,
    lean = 0,
    rotationX = 0,
    rollOuter = false,
  ) {
    const offset = slot * 10,
      poses = this.poses;
    if (
      !this.shown[slot] ||
      poses[offset] !== x ||
      poses[offset + 1] !== y ||
      poses[offset + 2] !== z ||
      poses[offset + 3] !== w ||
      poses[offset + 4] !== h ||
      poses[offset + 5] !== d ||
      poses[offset + 6] !== angle ||
      poses[offset + 7] !== lean ||
      poses[offset + 8] !== rotationX ||
      poses[offset + 9] !== (rollOuter ? 1 : 0)
    ) {
      this.shown[slot] = 1;
      poses[offset] = x;
      poses[offset + 1] = y;
      poses[offset + 2] = z;
      poses[offset + 3] = w;
      poses[offset + 4] = h;
      poses[offset + 5] = d;
      poses[offset + 6] = angle;
      poses[offset + 7] = lean;
      poses[offset + 8] = rotationX;
      poses[offset + 9] = rollOuter ? 1 : 0;
      this.transform.position.set(x, y, z);
      // Yaw surrounds the local limb rotations, so a forward swing follows
      // the person's facing at every heading on the floor.
      // A composed part tips by pitch, then roll, then turns with the object:
      // yaw outside roll outside pitch ("YZX"), the order partReach assumes.
      this.transform.rotation.set(
        rotationX,
        -angle,
        lean,
        rollOuter ? "YZX" : "YXZ",
      );
      this.transform.scale.set(w, h, d);
      this.transform.updateMatrix();
      this.mesh.setMatrixAt(slot, this.transform.matrix);
      this.matrixFirst = Math.min(this.matrixFirst, slot);
      this.matrixLast = Math.max(this.matrixLast, slot);
    }
    let tint = color;
    if (typeof tint === "string") {
      let cached = this.colors.get(tint);
      if (!cached) {
        cached = new Color(tint);
        this.colors.set(tint, cached);
      }
      tint = cached;
    }
    this.setColor(slot, tint);
  }

  private setColor(slot: number, tint: Color) {
    const attribute = this.mesh.instanceColor,
      offset = slot * 3;
    if (
      attribute &&
      attribute.array[offset] === Math.fround(tint.r) &&
      attribute.array[offset + 1] === Math.fround(tint.g) &&
      attribute.array[offset + 2] === Math.fround(tint.b)
    )
      return;
    this.mesh.setColorAt(slot, tint);
    this.mesh.instanceColor!.setUsage(DynamicDrawUsage);
    this.colorFirst = Math.min(this.colorFirst, slot);
    this.colorLast = Math.max(this.colorLast, slot);
  }

  /** Call once after scene synchronization, before renderer.render(). Three
   * clears uploaded ranges; untouched pools do not bump attribute versions. */
  flush() {
    if (this.matrixLast >= 0) {
      const attribute = this.mesh.instanceMatrix;
      this.queueRange(
        attribute,
        this.matrixRange,
        this.matrixFirst * 16,
        (this.matrixLast - this.matrixFirst + 1) * 16,
      );
      attribute.needsUpdate = true;
      this.matrixFirst = Infinity;
      this.matrixLast = -1;
    }
    if (this.colorLast >= 0) {
      const attribute = this.mesh.instanceColor!;
      this.queueRange(
        attribute,
        this.colorRange,
        this.colorFirst * 3,
        (this.colorLast - this.colorFirst + 1) * 3,
      );
      attribute.needsUpdate = true;
      this.colorFirst = Infinity;
      this.colorLast = -1;
    }
  }

  private queueRange(
    attribute: BufferAttribute,
    range: { start: number; count: number },
    start: number,
    count: number,
  ) {
    if (attribute.updateRanges.includes(range)) {
      const end = Math.max(range.start + range.count, start + count);
      range.start = Math.min(range.start, start);
      range.count = end - range.start;
    } else {
      range.start = start;
      range.count = count;
      // addUpdateRange allocates a fresh object; reuse this pool's record after
      // Three clears the consumed array at the end of each WebGL upload.
      attribute.updateRanges.push(range);
    }
  }

  /** Floor changes own geometry/instance buffers; shared materials can survive
   * until the entire view is disposed. Standalone pools own materials by default. */
  dispose(disposeMaterial = true) {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    if (disposeMaterial) this.mesh.material.dispose();
    this.mesh.dispose();
  }
}
