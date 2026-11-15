import {
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  SRGBColorSpace,
} from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { devPass, type Game } from "../model";
import {
  COLUMN_SIZE,
  DECK_THICKNESS,
  exteriorStructure,
  stairAccessPortals,
  type StairAccessPortal,
} from "../exterior-structure";
import {
  buildStairRoute,
  cityStairBase,
  STAIR_ROUTE_WIDTH,
} from "../stair-route";

/** A closed concrete foundation fills the lowest flight down to the street.
 * Its upper slope stays inside the tread boxes; recessed sides and ends avoid
 * duplicate planes while leaving all twenty walking surfaces uncovered. */
export function buildCityStairFoundation(game: Game) {
  const base = cityStairBase(game);
  if (!base) return undefined;
  const inset = 0.005,
    length = base.h - inset * 2,
    geometry = new BoxGeometry(base.w - 0.02, 1, length),
    positions = geometry.getAttribute("position"),
    color = new Color("#61736d"),
    colors = new Float32Array(positions.count * 3);
  for (let i = 0; i < positions.count; i++) {
    const z = base.start.y + inset + positions.getZ(i) + length / 2;
    positions.setXYZ(
      i,
      base.x + positions.getX(i),
      positions.getY(i) > 0 ? ((z - base.start.y) / base.h) * base.rise : -0.06,
      z,
    );
    color.toArray(colors, i * 3);
  }
  geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  return geometry;
}

/** The visible structure uses the exact route used by the walking motor. */
export class StairGallery {
  readonly group = new Group();
  private concrete = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.87,
  });
  private metal = new MeshStandardMaterial({
    color: "#8caaa6",
    roughness: 0.6,
    metalness: 0.3,
  });
  private glass = new MeshStandardMaterial({
    color: "#88b2b7",
    transparent: true,
    opacity: 0.12,
    depthWrite: false,
    roughness: 0.4,
  });
  private signs: MeshBasicMaterial[] = [];
  private accessFields: { portal: StairAccessPortal; mesh: Mesh }[] = [];
  private field = new MeshStandardMaterial({
    color: "#ff6274",
    emissive: "#b4283d",
    emissiveIntensity: 0.5,
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
    roughness: 0.55,
    side: DoubleSide,
  });
  private tint = new Color();
  constructor() {
    this.group.name = "continuous-stair-gallery";
  }

  build(game: Game) {
    this.clear();
    if (!game.floors[0]?.boundary) return;
    const decks: BufferGeometry[] = [],
      rails: BufferGeometry[] = [],
      glazing: BufferGeometry[] = [],
      supports: BufferGeometry[] = [],
      structure = exteriorStructure(game);
    const box = (
      out: BufferGeometry[],
      x: number,
      y: number,
      z: number,
      w: number,
      h: number,
      d: number,
      color?: string,
      angle = 0,
    ) => {
      const g = new BoxGeometry(w, h, d).rotateY(angle).translate(x, y, z);
      if (color) {
        this.tint.set(color);
        const c = new Float32Array(g.getAttribute("position").count * 3);
        for (let i = 0; i < c.length; i += 3) this.tint.toArray(c, i);
        g.setAttribute("color", new Float32BufferAttribute(c, 3));
      }
      out.push(g);
    };
    // Render the exact slabs and guard bays used by elevated-body collision.
    for (const slab of structure.slabs) {
      const length = slab.halfLength * 2,
        angle = -Math.atan2(slab.uy, slab.ux);
      for (let j = 0; j < slab.steps; j++) {
        const along = -slab.halfLength + (length * (j + 0.5)) / slab.steps,
          top = slab.top + (slab.rise * (j + 1)) / slab.steps;
        box(
          decks,
          slab.x + slab.ux * along,
          top - DECK_THICKNESS / 2,
          slab.y + slab.uy * along,
          length / slab.steps,
          DECK_THICKNESS,
          slab.halfWidth * 2,
          j % 2 ? "#7c8c87" : slab.color,
          angle,
        );
        if (slab.rise) {
          const edge = -slab.halfLength + (length * (j + 1)) / slab.steps;
          box(
            rails,
            slab.x + slab.ux * edge,
            top + 0.008,
            slab.y + slab.uy * edge,
            0.035,
            0.016,
            STAIR_ROUTE_WIDTH,
            undefined,
            angle,
          );
        }
      }
    }
    const posts = new Set<string>();
    for (const bay of structure.guards) {
      if (!bay.corner)
        for (const [x, z, base] of [
          [bay.x1, bay.y1, bay.base1],
          [bay.x2, bay.y2, bay.base2],
        ]) {
          const key = `${x}/${z}/${base}`;
          if (posts.has(key)) continue;
          posts.add(key);
          box(rails, x, base + 0.58, z, 0.055, 1.16, 0.055);
        }
      // Storm damage removes the entire glass and rail bay but leaves posts.
      if (bay.broken) continue;
      const dx = bay.x2 - bay.x1,
        dz = bay.y2 - bay.y1,
        run = Math.hypot(dx, dz),
        rise = bay.base2 - bay.base1,
        angle = -Math.atan2(dz, dx),
        x = (bay.x1 + bay.x2) / 2,
        z = (bay.y1 + bay.y2) / 2,
        base = (bay.base1 + bay.base2) / 2;
      rails.push(
        new BoxGeometry(
          Math.hypot(run, rise) + (bay.corner ? 0 : 0.04),
          0.055,
          0.055,
        )
          .rotateZ(Math.atan2(rise, run))
          .rotateY(angle)
          .translate(x, base + 1.14, z),
      );
      const pane = new BoxGeometry(
          Math.max(0.05, run - (bay.corner ? 0.1 : 0.08)),
          0.92,
          0.018,
        ),
        vertices = pane.getAttribute("position");
      for (let i = 0; i < vertices.count; i++)
        vertices.setY(i, vertices.getY(i) + (vertices.getX(i) * rise) / run);
      pane.computeVertexNormals();
      glazing.push(pane.rotateY(angle).translate(x, base + 0.52, z));
    }
    for (const column of structure.columns)
      box(
        supports,
        column.x,
        column.top / 2,
        column.y,
        COLUMN_SIZE,
        column.top,
        COLUMN_SIZE,
        "#4f6265",
      );
    for (let level = 0; level < game.floors.length - 1; level++) {
      const route = buildStairRoute(game, {
          fromFloor: level,
          toFloor: level + 1,
          origin: game.floors[level].stairs,
          destination: game.floors[level + 1].entry,
          until: 0,
        }),
        north = route.points[1],
        south = route.points[5];
      // An interior stair core has no outside gallery to signpost.
      if (!south) continue;
      this.sign(
        north.x + 0.65,
        north.y + 1.6,
        north.z - 0.7,
        `FLOOR ${level + 2}  →`,
        "EMERGENCY STAIR / EAST GALLERY",
        0,
      );
      this.sign(
        south.x,
        south.y + 1.6,
        south.z + 0.75,
        `←  FLOOR ${level + 2}`,
        "RECEPTION / KEEP MOVING",
        Math.PI,
      );
    }
    for (const portal of stairAccessPortals(game)) {
      const mesh = new Mesh(
        new PlaneGeometry(portal.width, portal.height),
        this.field,
      );
      mesh.name = `stair-access-field-${portal.kind}-${portal.floor}`;
      mesh.position.set(portal.x, portal.base + portal.height / 2, portal.y);
      mesh.rotation.y = portal.axis === "x" ? Math.PI / 2 : 0;
      mesh.userData = { ...portal, oneWay: true };
      this.group.add(mesh);
      this.accessFields.push({ portal, mesh });
    }
    this.update(game);
    const foundation = buildCityStairFoundation(game);
    if (foundation) {
      const mesh = new Mesh(foundation, this.concrete);
      mesh.name = "ground-stair-concrete-base";
      this.group.add(mesh);
      const base = cityStairBase(game)!;
      const signX = base.x + STAIR_ROUTE_WIDTH / 2 + 0.9;
      box(rails, signX, 0.85, base.start.y - 0.3, 0.06, 1.7, 0.06);
      this.sign(
        signX,
        1.5,
        base.start.y - 0.3,
        "PERSONAL STAIR ACCESS",
        "SOLVE A FLOOR TERMINAL BEFORE ASCENDING",
        Math.PI,
      );
    }
    this.merge(decks, this.concrete, "stair-decks-and-treads");
    this.merge(supports, this.concrete, "stair-support-columns");
    this.merge(rails, this.metal, "stair-handrails");
    this.merge(glazing, this.glass, "stair-glass-guards");
  }

  /** Personal permission can change while this persistent gallery is visible. */
  update(game: Game) {
    const human = game.survivors[0];
    for (const { portal, mesh } of this.accessFields)
      mesh.visible =
        !!human && !devPass(human) && !human.access.includes(portal.floor);
  }

  private sign(
    x: number,
    y: number,
    z: number,
    text: string,
    detail: string,
    yaw: number,
  ) {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 128;
    const c = canvas.getContext("2d")!;
    c.fillStyle = "#193f3b";
    c.fillRect(0, 0, 512, 128);
    c.strokeStyle = "#b4ccb3";
    c.lineWidth = 5;
    c.strokeRect(4, 4, 504, 120);
    c.fillStyle = "#e0e9cc";
    c.textAlign = "center";
    c.font = "bold 44px sans-serif";
    c.fillText(text, 256, 60);
    c.font = "18px sans-serif";
    c.fillText(detail, 256, 99);
    const map = new CanvasTexture(canvas);
    map.colorSpace = SRGBColorSpace;
    const material = new MeshBasicMaterial({ map });
    this.signs.push(material);
    const sign = new Mesh(new PlaneGeometry(1.6, 0.4), material);
    sign.position.set(x, y, z);
    sign.rotation.y = yaw;
    this.group.add(sign);
  }

  private merge(
    parts: BufferGeometry[],
    material: MeshStandardMaterial,
    name: string,
  ) {
    if (!parts.length) return;
    const mesh = new Mesh(mergeGeometries(parts)!, material);
    for (const g of parts) g.dispose();
    mesh.name = name;
    this.group.add(mesh);
  }
  private clear() {
    for (const c of [...this.group.children]) {
      (c as Mesh).geometry.dispose();
      c.removeFromParent();
    }
    for (const m of this.signs) {
      m.map?.dispose();
      m.dispose();
    }
    this.signs.length = 0;
    this.accessFields.length = 0;
  }
  dispose() {
    this.clear();
    this.concrete.dispose();
    this.metal.dispose();
    this.glass.dispose();
    this.field.dispose();
  }
}
