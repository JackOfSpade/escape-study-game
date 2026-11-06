import {
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Points,
  PointsMaterial,
  SpotLight,
  SRGBColorSpace,
  type Texture,
} from "three";
import {
  buildInteriorLighting,
  fixtureIntensity,
  FIXTURE_RANGE,
  hasDeskStory,
  interiorHash,
  lightAt,
  PhoneLightState,
  type InteriorLighting,
} from "../interior-lighting";
import { CONFIG, type Floor, type Furniture, type Game } from "../model";
import { FLOOR_HEIGHT } from "../stair-route";
import { playerCanSee } from "../visibility";
import { furnitureHeightOf } from "./furniture-height";
import { dressingTop } from "../environment-surfaces";
import { InstancePool } from "./instances";
import { InteriorLightmap } from "./interior-lightmap";
import { outsideBuilding } from "./exterior-layout";
import type { RunStory } from "../run-design-contract.mjs";
import { AuthoredScene } from "./authored-scene";
import { EnvironmentSurfaces } from "./environment-surfaces";

interface Detail {
  slot: number;
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  color: string;
  story?: number;
  rotationX?: number;
}
interface Furnishing {
  object: Furniture;
  details: Detail[];
}
interface FloorAtmosphere {
  group: Group;
  plan: InteriorLighting;
  solids: InstancePool;
  tubes: InstancePool;
  cards: InstancePool[];
  /** Authored cards belong to this floor; legacy cards stay shared. */
  authoredMaterials?: MeshStandardMaterial[];
  authoredScene?: AuthoredScene;
  environmentSurfaces?: EnvironmentSurfaces;
  furnishings: Furnishing[];
}

const STORY_COUNT = 6;
const MAX_FURNISHINGS = 72;
const MAX_DESKS = 64;
const CARD_CAPACITY = 128;

function storyTexture(
  story: number,
  authored?: RunStory,
): CanvasTexture | undefined {
  if (typeof document === "undefined") return undefined;
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = story === 3 ? 288 : 640;
  const c = canvas.getContext("2d");
  if (!c) return undefined;
  const width = canvas.width,
    height = canvas.height;
  c.fillStyle = story === 3 ? "#d7e1d9" : "#ded8bf";
  c.fillRect(0, 0, width, height);
  c.strokeStyle = story === 3 ? "#64716e" : "#595e51";
  c.lineWidth = 12;
  c.strokeRect(6, 6, width - 12, height - 12);
  const line = (text: string, y: number, size = 30, color = "#2b3d3e") => {
    c.fillStyle = color;
    c.font = `${story === 3 ? "italic" : "600"} ${size}px sans-serif`;
    c.textAlign = "center";
    c.fillText(text, width / 2, y, width - 48);
  };
  if (authored) {
    // The bounded plain-text design is rendered directly, never parsed as HTML.
    // Wrap by measured width so long names and narrow whiteboards remain readable.
    const wrap = (text: string, size: number, maxLines: number) => {
      c.font = `${story === 3 ? "italic" : "600"} ${size}px sans-serif`;
      const lines: string[] = [];
      let row = "";
      for (const word of text.split(/\s+/)) {
        const candidate = row ? `${row} ${word}` : word;
        if (row && c.measureText(candidate).width > width - 60) {
          lines.push(row);
          row = word;
        } else row = candidate;
      }
      if (row) lines.push(row);
      return lines.length > maxLines
        ? [...lines.slice(0, maxLines - 1), lines.slice(maxLines - 1).join(" ")]
        : lines;
    };
    const titleSize = story === 3 ? 27 : 35,
      bodySize = story === 3 ? 21 : 28,
      title = wrap(authored.title, titleSize, 2),
      body = authored.lines.flatMap((text) => wrap(text, bodySize, 2)),
      titleTop = story === 3 ? 40 : 67,
      bodyTop = story === 3 ? 112 : 198,
      bodyStep = Math.min(
        story === 3 ? 20 : 48,
        (height - bodyTop - 35) / Math.max(1, body.length - 1),
      );
    title.forEach((text, i) =>
      line(text, titleTop + i * (titleSize + 8), titleSize, "#843f35"),
    );
    body.forEach((text, i) => line(text, bodyTop + i * bodyStep, bodySize));
  } else if (story === 0) {
    c.fillStyle = "#8b493b";
    c.fillRect(20, 24, width - 40, 94);
    line("BUILDING NOTICE", 85, 40, "#fff2cf");
    line("STREET EVACUATION", 188, 36);
    line("SUSPENDED", 242, 52, "#933d35");
    line("ROOF ASSEMBLY", 346, 43);
    line("↑", 444, 100);
    line("Bring medication. Leave bags.", 515, 26);
    line("Last update 06:40", 581, 27, "#6c5e4e");
  } else if (story === 1) {
    line("HAVE YOU SEEN MAYA?", 70, 36);
    c.fillStyle = "#9caaa2";
    c.fillRect(126, 110, 260, 274);
    c.fillStyle = "#373c3c";
    c.beginPath();
    c.arc(256, 215, 69, Math.PI, 0);
    c.fill();
    c.fillStyle = "#b88b6e";
    c.beginPath();
    c.ellipse(256, 219, 57, 72, 0, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = "#4a6471";
    c.beginPath();
    c.ellipse(256, 361, 99, 94, 0, Math.PI, Math.PI * 2);
    c.fill();
    c.fillStyle = "#283332";
    c.fillRect(232, 215, 8, 7);
    c.fillRect(273, 215, 8, 7);
    line("We waited at reception.", 454, 30);
    line("Please leave a message.", 505, 29);
    line("— Sam, floor 2", 575, 31);
  } else if (story === 2) {
    line("FRIDAY LUNCH", 100, 49);
    line("12:30 • BREAK ROOM", 178, 29);
    line("Bring something to share.", 241, 29);
    c.strokeStyle = "#775f40";
    c.lineWidth = 6;
    c.beginPath();
    c.ellipse(256, 374, 135, 34, 0, 0, Math.PI * 2);
    c.stroke();
    for (let i = 0; i < 3; i++) {
      c.beginPath();
      c.moveTo(207 + i * 48, 329);
      c.bezierCurveTo(170 + i * 48, 301, 246 + i * 48, 275, 204 + i * 48, 259);
      c.stroke();
    }
    c.save();
    c.translate(width / 2, 512);
    c.rotate(-0.13);
    c.font = "italic 58px sans-serif";
    c.fillStyle = "#963b30";
    c.fillText("CANCELLED", 0, 0);
    c.restore();
  } else if (story === 3) {
    c.textAlign = "left";
    c.fillStyle = "#3e686c";
    c.font = "italic 31px sans-serif";
    c.fillText("Monday — launch review", 31, 54);
    c.font = "italic 24px sans-serif";
    c.fillText("Budget ✓   Training ✓", 34, 100);
    c.fillText("Call home before leaving", 34, 140);
    c.fillStyle = "#943f36";
    c.font = "italic 30px sans-serif";
    c.fillText("DON'T USE THE LIFTS", 29, 199);
    c.font = "italic 27px sans-serif";
    c.fillText("ROOF ↑  GROUPS OF FOUR", 29, 249);
    c.strokeStyle = "#9a3d37";
    c.lineWidth = 3;
    c.beginPath();
    c.moveTo(40, 72);
    c.lineTo(465, 131);
    c.stroke();
  } else if (story === 4) {
    c.fillStyle = "#8da7a9";
    c.fillRect(22, 24, 468, 492);
    c.fillStyle = "#8d9b69";
    c.fillRect(22, 331, 468, 185);
    for (let i = 0; i < 3; i++) {
      c.fillStyle = ["#4b6571", "#896859", "#aa9c67"][i];
      c.fillRect(92 + i * 127, 260 + (i === 1 ? 40 : 0), 79, 180);
      c.fillStyle = "#c39b7b";
      c.beginPath();
      c.arc(132 + i * 127, 211 + (i === 1 ? 42 : 0), 46, 0, Math.PI * 2);
      c.fill();
    }
    line("LOVE YOU, DAD", 578, 37);
  } else {
    line("If you're reading this:", 119, 35);
    line("we went upstairs.", 229, 44);
    line("Please don't wait", 338, 36);
    line("for the lifts.", 390, 36);
    line("— M.", 531, 44);
    c.strokeStyle = "#735d45";
    c.lineWidth = 4;
    c.beginPath();
    c.moveTo(152, 557);
    c.lineTo(390, 549);
    c.stroke();
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function phoneScreenTexture(): CanvasTexture | undefined {
  if (typeof document === "undefined") return undefined;
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 512;
  const c = canvas.getContext("2d");
  if (!c) return undefined;
  c.fillStyle = "#14313a";
  c.fillRect(0, 0, 256, 512);
  c.fillStyle = "#a3c2c6";
  c.font = "600 48px sans-serif";
  c.fillText("06:40", 18, 64);
  c.fillStyle = "#7b9f9f";
  c.font = "20px sans-serif";
  c.fillText("NO SERVICE", 18, 103);
  c.strokeStyle = "#90bfbd";
  c.lineWidth = 7;
  c.beginPath();
  c.arc(128, 250, 43, Math.PI * 0.18, Math.PI * 0.82, true);
  c.stroke();
  c.beginPath();
  c.moveTo(96, 276);
  c.lineTo(102, 304);
  c.lineTo(154, 304);
  c.lineTo(160, 276);
  c.stroke();
  c.beginPath();
  c.moveTo(106, 320);
  c.lineTo(150, 320);
  c.stroke();
  for (const angle of [
    -Math.PI,
    -Math.PI * 0.75,
    -Math.PI / 2,
    -Math.PI * 0.25,
    0,
  ]) {
    c.beginPath();
    c.moveTo(128 + Math.cos(angle) * 60, 250 + Math.sin(angle) * 60);
    c.lineTo(128 + Math.cos(angle) * 75, 250 + Math.sin(angle) * 75);
    c.stroke();
  }
  c.fillStyle = "#8ab4b2";
  c.font = "600 28px sans-serif";
  c.textAlign = "center";
  c.fillText("LIGHT ON", 128, 415);
  c.fillStyle = "#365259";
  c.fillRect(75, 479, 106, 5);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/** Presentation-only office dressing. Geometry and text are shared/bounded;
 * movable objects retain their actual saved transform on every frame. */
export class InteriorAtmosphere {
  readonly group = new Group();
  readonly phone = new Group();
  readonly phoneState = new PhoneLightState();
  currentLight = 1;
  /** Baked light from every powered fixture, shared with world materials. */
  readonly lightmap = new InteriorLightmap();
  private practicalWeights = new Map<string, number>();
  private practicalFloor = -1;
  private floors = new Map<Floor, FloorAtmosphere>();
  private solidMaterial = new MeshStandardMaterial({
    color: "white",
    roughness: 0.87,
  });
  private tubeMaterial = new MeshStandardMaterial({
    color: "white",
    emissive: "#d2d8c2",
    emissiveIntensity: 0.7,
    roughness: 0.55,
  });
  private cardMaterials = Array.from(
    { length: STORY_COUNT },
    (_, i) =>
      new MeshStandardMaterial({
        color: "white",
        map: storyTexture(i) ?? null,
        roughness: 0.98,
      }),
  );
  private practicals = Array.from(
    { length: 3 },
    () => new PointLight("#edd3a2", 0, 7, 2),
  );
  // Physical inverse-square decay with a smooth finite eight-metre cutoff.
  // The phone never changes global fill, moonlight or world material emission.
  private phoneLight = new SpotLight("#d2e8f5", 0, 8, 0.72, 0.85, 2);
  // A small, local screen/reflected-light contribution keeps nearby routes and
  // wall edges legible outside the LED cone, including at arm's-length walls.
  // It also decays inversely with squared distance and cuts off at three metres.
  private phoneBounce = new PointLight("#b5cdd4", 0, 3, 2);
  private phoneTarget = new Object3D();
  private phoneMaterial = new MeshStandardMaterial({
    color: "#20282b",
    roughness: 0.4,
    metalness: 0.25,
  });
  private handMaterial = new MeshStandardMaterial({
    color: "#bb997f",
    roughness: 0.85,
  });
  private screenTexture = phoneScreenTexture();
  private screenMaterial = new MeshBasicMaterial({
    color: "#b6cac9",
    map: this.screenTexture ?? null,
    toneMapped: false,
  });
  private dustGeometry = new BufferGeometry();
  private dustMaterial = new PointsMaterial({
    color: "#d5cdb7",
    size: 0.017,
    transparent: true,
    opacity: 0.16,
    depthWrite: false,
  });
  private dust: Points;
  private disposed = false;
  private run?: Game;

  constructor() {
    this.group.name = "interior-atmosphere";
    this.phone.name = "automatic-phone-light";
    this.phone.visible = false;
    const part = (
      w: number,
      h: number,
      d: number,
      x: number,
      y: number,
      z: number,
      material = this.phoneMaterial,
    ) => {
      const mesh = new Mesh(new BoxGeometry(w, h, d), material);
      mesh.position.set(x, y, z);
      this.phone.add(mesh);
      return mesh;
    };
    part(0.086, 0.172, 0.014, 0, 0, 0);
    const screen = new Mesh(
      new PlaneGeometry(0.074, 0.145),
      this.screenMaterial,
    );
    screen.position.set(0, 0.003, 0.0075);
    screen.name = "phone-screen";
    this.phone.add(screen);
    part(0.024, 0.006, 0.002, 0, 0.078, 0.008);
    part(0.065, 0.075, 0.05, 0.022, -0.062, -0.014, this.handMaterial);
    part(0.018, 0.07, 0.024, -0.037, -0.037, 0.005, this.handMaterial);
    this.phone.rotation.set(-0.11, -0.12, 0.12);
    this.phoneLight.position.set(0.215, -0.139, -0.44);
    this.phoneTarget.position.set(0, 0, -7);
    this.phoneLight.target = this.phoneTarget;
    this.phoneBounce.name = "phone-screen-bounce";
    this.phoneLight.castShadow = false;
    this.group.add(...this.practicals);
    for (const light of this.practicals) light.castShadow = false;
    this.dustGeometry.setAttribute(
      "position",
      new Float32BufferAttribute(new Float32Array(48 * 3), 3),
    );
    for (const material of [
      this.solidMaterial,
      this.tubeMaterial,
      ...this.cardMaterials,
    ])
      this.lightmap.patch(material);
    this.dust = new Points(this.dustGeometry, this.dustMaterial);
    this.dust.name = "lit-office-dust";
    this.dust.frustumCulled = false;
    this.group.add(this.dust);
  }

  build(floor: Floor, seed: number) {
    if (this.disposed) return;
    const previous = this.floors.get(floor);
    if (previous) this.releaseFloor(previous);
    const group = new Group();
    group.name = `office-atmosphere-${floor.index}`;
    group.position.y = floor.index * FLOOR_HEIGHT;
    const plan = buildInteriorLighting(floor, seed),
      authoredMaterials = (
        floor.design && "stories" in floor.design
          ? floor.design.stories
          : undefined
      )?.map((story, i) => {
        const material = new MeshStandardMaterial({
          color: "white",
          map: storyTexture(i, story) ?? null,
          roughness: 0.98,
        });
        this.lightmap.patch(material);
        return material;
      }),
      solids = new InstancePool(
        group,
        new BoxGeometry(1, 1, 1),
        this.solidMaterial,
        2048,
        false,
      ),
      tubes = new InstancePool(
        group,
        new BoxGeometry(1, 1, 1),
        this.tubeMaterial,
        128,
        false,
      ),
      cards = (
        floor.environment ? [] : (authoredMaterials ?? this.cardMaterials)
      ).map(
        (material) =>
          new InstancePool(
            group,
            new PlaneGeometry(1, 1),
            material,
            CARD_CAPACITY,
            false,
          ),
      ),
      context: FloorAtmosphere = {
        group,
        plan,
        solids,
        tubes,
        cards,
        authoredMaterials,
        furnishings: [],
      };
    solids.mesh.name = "office-personal-effects-and-fixtures";
    tubes.mesh.name = "working-ceiling-lamps";
    cards.forEach((p, i) => {
      p.mesh.name = `office-story-surface-${i}`;
    });
    for (const fixture of plan.fixtures) {
      solids.set(
        solids.allocate(),
        fixture.x,
        2.785,
        fixture.y,
        0.58,
        0.05,
        1.14,
        0,
        "#515d5c",
      );
      if (fixture.level > 0.2)
        tubes.set(
          tubes.allocate(),
          fixture.x,
          2.751,
          fixture.y,
          0.46,
          0.018,
          0.99,
          0,
          fixture.color,
        );
      else {
        solids.set(
          solids.allocate(),
          fixture.x,
          2.751,
          fixture.y,
          0.46,
          0.018,
          0.99,
          0,
          "#69756f",
        );
        solids.set(
          solids.allocate(),
          fixture.x + 0.12,
          2.736,
          fixture.y + 0.24,
          0.035,
          0.016,
          0.4,
          0.3,
          "#303936",
        );
      }
    }
    for (const story of floor.environment ? [] : plan.stories) {
      const pool = cards[story.story];
      pool.set(
        pool.allocate(),
        story.x,
        1.69,
        story.y,
        story.width,
        story.height,
        1,
        -Math.atan2(story.nx, story.ny),
        "#ece5d3",
      );
    }
    const savedDeskIds = new Set(
        floor.environment?.surfaces
          .filter(
            (s) =>
              s.floor === floor.index &&
              (s.role === "desk-papers" || s.role === "desk-note") &&
              s.binding.kind === "furniture",
          )
          .map((s) => (s.binding as { furnitureId: string }).furnitureId),
      ),
      desks = floor.furniture
        .filter((object) =>
          floor.environment
            ? savedDeskIds.has(object.id)
            : !object.appearance && hasDeskStory(object),
        )
        .sort(
          (a, b) =>
            interiorHash(seed, floor.index, a.id) -
            interiorHash(seed, floor.index, b.id),
        )
        .slice(0, MAX_DESKS),
      boards = floor.furniture
        .filter(
          (o) =>
            !floor.environment &&
            !o.appearance &&
            o.kind === "whiteboard" &&
            !o.destroyed,
        )
        .slice(0, MAX_FURNISHINGS - desks.length);
    for (const object of [...desks, ...boards])
      context.furnishings.push({
        object,
        details: this.makeDetails(context, object),
      });
    if (floor.scene) {
      context.authoredScene = new AuthoredScene(floor, this.lightmap);
      group.add(context.authoredScene.group);
    }
    if (floor.environment) {
      context.environmentSurfaces = new EnvironmentSurfaces(
        floor,
        floor.environment,
        "interior",
        this.lightmap,
      );
      group.add(context.environmentSurfaces.group);
    }
    this.group.add(group);
    this.floors.set(floor, context);
    this.lightmap.build(floor.index, plan);
    if (floor.index === this.practicalFloor) this.practicalWeights.clear();
    this.syncFurnishings(context);
    for (const pool of [solids, tubes, ...cards]) pool.flush();
    group.userData = {
      zones: plan.zones.map((z) => ({ id: z.id, power: z.power })),
      fixtureCount: plan.fixtures.length,
      posterCount: plan.stories.length,
      furnishedObjects: context.furnishings.length,
    };
  }

  private makeDetails(context: FloorAtmosphere, object: Furniture) {
    const details: Detail[] = [],
      { plan } = context,
      roll = interiorHash(plan.seed, object.floor, object.id),
      top = dressingTop(object);
    const solid = (
      x: number,
      y: number,
      z: number,
      w: number,
      h: number,
      d: number,
      color: string,
    ) =>
      details.push({
        slot: context.solids.allocate(),
        x,
        y,
        z,
        w,
        h,
        d,
        color,
      });
    const card = (
      story: number,
      x: number,
      y: number,
      z: number,
      w: number,
      h: number,
      rotationX = 0,
    ) => {
      if (context.plan.floor.environment) return;
      details.push({
        slot: context.cards[story].allocate(),
        story,
        x,
        y,
        z,
        w,
        h,
        d: 1,
        rotationX,
        color: "#ffffff",
      });
    };
    if (object.kind === "whiteboard") {
      card(
        3,
        0,
        furnitureHeightOf(object) * 0.65,
        object.h * 0.52 + 0.045,
        object.w * 0.89,
        furnitureHeightOf(object) * 0.56,
      );
      return details;
    }
    const x = object.w * 0.22,
      z = -object.h * 0.19,
      pageW = Math.min(0.25, object.w * 0.32),
      pageD = Math.min(0.29, object.h * 0.38);
    solid(-x, top + 0.004, z, pageW, 0.008, pageD, "#b9b39c");
    solid(
      -x + 0.012,
      top + 0.01,
      z + 0.018,
      pageW * 0.95,
      0.005,
      pageD * 0.95,
      "#dfd9bd",
    );
    if (!context.plan.floor.environment)
      solid(
        -x,
        top + 0.016,
        z - pageD * 0.17,
        pageW * 0.7,
        0.002,
        0.006,
        "#657271",
      );
    solid(
      -x + pageW * 0.15,
      top + 0.018,
      z + pageD * 0.1,
      0.012,
      0.008,
      pageD * 0.63,
      roll % 2 ? "#724e44" : "#45596b",
    );
    if (roll % 3 !== 0) {
      const mugX = x,
        mugZ = object.h * 0.19;
      solid(
        mugX,
        top + 0.066,
        mugZ,
        0.105,
        0.13,
        0.105,
        roll % 2 ? "#9eaa9c" : "#b48a67",
      );
      solid(mugX, top + 0.133, mugZ, 0.078, 0.005, 0.078, "#332e25");
      solid(mugX + 0.072, top + 0.074, mugZ, 0.04, 0.019, 0.055, "#a2aa9a");
      solid(mugX + 0.083, top + 0.049, mugZ, 0.016, 0.043, 0.055, "#a2aa9a");
    }
    if (
      roll % 3 === 0 ||
      object.kind === "desk" ||
      object.kind === "reception"
    ) {
      solid(x, top + 0.11, z, 0.16, 0.22, 0.025, "#5c5446");
      card(4, x, top + 0.115, z + 0.0145, 0.136, 0.176);
    }
    if (roll % 4 === 1)
      card(
        5,
        -x,
        top + 0.023,
        z + pageD * 0.02,
        pageW * 0.82,
        pageD * 0.82,
        -Math.PI / 2,
      );
    if (roll % 5 === 2) {
      solid(x, top + 0.02, object.h * 0.12, 0.068, 0.032, 0.13, "#343e42");
      solid(x, top + 0.038, object.h * 0.12, 0.054, 0.004, 0.102, "#52666d");
    }
    return details;
  }

  private syncFurnishings(context: FloorAtmosphere) {
    context.authoredScene?.sync();
    context.environmentSurfaces?.sync();
    for (const { object, details } of context.furnishings) {
      const angle = object.angle ?? 0,
        c = Math.cos(angle),
        s = Math.sin(angle),
        present =
          !object.destroyed && context.plan.floor.furniture.includes(object);
      for (const p of details) {
        const pool =
          p.story === undefined ? context.solids : context.cards[p.story];
        if (!present) {
          pool.hide(p.slot);
          continue;
        }
        pool.set(
          p.slot,
          object.x + p.x * c - p.z * s,
          p.y,
          object.y + p.x * s + p.z * c,
          p.w,
          p.h,
          p.d,
          angle,
          p.color,
          0,
          p.rotationX ?? 0,
        );
      }
    }
    context.solids.flush();
    context.cards.forEach((p) => p.flush());
  }

  update(game: Game, camera: PerspectiveCamera, dt: number) {
    if (this.disposed) return;
    if (this.run !== game) {
      this.phoneState.reset();
      this.run = game;
    }
    for (const [other, context] of this.floors)
      if (!game.floors.includes(other)) {
        this.releaseFloor(context);
        this.floors.delete(other);
      }
    const player = game.survivors[0],
      floor = game.floors[player.floor];
    if (!this.floors.has(floor)) this.build(floor, game.seed);
    const active = this.floors.get(floor)!;
    for (const [other, context] of this.floors) {
      context.group.visible =
        other === floor || other.index === player.stairTravel?.toFloor;
      if (context.group.visible) this.syncFurnishings(context);
    }
    const feet = player.elevated?.feet ?? player.floor * FLOOR_HEIGHT,
      indoors =
        !outsideBuilding(floor, player.x, player.y) &&
        feet >= floor.index * FLOOR_HEIGHT - 0.3 &&
        feet < floor.index * FLOOR_HEIGHT + 2.82;
    this.currentLight = indoors ? lightAt(active.plan, player) : 1;
    const nearby = this.updatePracticals(game, floor, active, dt);
    if (this.phone.parent !== camera) camera.add(this.phone);
    // Keep the light in the scene even at zero intensity: hiding the phone
    // must not change shader light counts and recompile every world material.
    if (this.phoneLight.parent !== camera)
      camera.add(this.phoneLight, this.phoneTarget, this.phoneBounce);
    const raised = this.phoneState.update(
        this.currentLight,
        dt,
        player.alive && !player.escaped && game.status === "playing",
      ),
      lift = raised * raised * (3 - 2 * raised);
    this.phone.position.set(0.18, -0.49 + lift * 0.28, -0.43);
    this.phoneLight.position.set(0.215, this.phone.position.y + 0.071, -0.44);
    this.phoneBounce.position.set(0.12, -0.1, -0.18);
    this.phone.visible = raised > 0;
    this.phoneLight.intensity = raised * 14;
    this.phoneBounce.intensity = raised * 0.85;
    this.phone.userData = {
      raised: this.phoneState.raised,
      mix: raised,
      illumination: this.currentLight,
    };
    this.group.userData = {
      currentLight: this.currentLight,
      phoneRaised: this.phoneState.raised,
      practicalLights: nearby,
    };
    this.updateDust(
      game,
      floor,
      (this.currentLight < 0.5 && raised > 0.2) || nearby > 0,
    );
  }

  /** The nearest visible lamps get real point lights for close shading. Each
   * fades in over the last 1.5 m of practical range, and the baked lightmap
   * gives up exactly the share the point light takes, on the floor, ceiling
   * and walls alike, so the total light a lamp casts never depends on where
   * the player stands. */
  private updatePracticals(
    game: Game,
    floor: Floor,
    active: FloorAtmosphere,
    dt: number,
  ) {
    const player = game.survivors[0],
      enabled =
        floor.index < CONFIG.floors &&
        !outsideBuilding(floor, player.x, player.y),
      range = FIXTURE_RANGE - 0.5,
      fade = 1.5;
    if (this.practicalFloor !== floor.index) {
      this.lightmap.setPracticals(this.practicalFloor, new Map());
      this.practicalWeights.clear();
      this.practicalFloor = floor.index;
    }
    const targets = new Map<string, number>();
    if (enabled)
      active.plan.fixtures
        .filter(
          (f) =>
            f.level > 0.2 &&
            Math.hypot(f.x - player.x, f.y - player.y) < range &&
            playerCanSee(floor, player, f, range),
        )
        .sort(
          (a, b) =>
            Math.hypot(a.x - player.x, a.y - player.y) -
            Math.hypot(b.x - player.x, b.y - player.y),
        )
        .slice(0, this.practicals.length)
        .forEach((f) => {
          const d = Math.hypot(f.x - player.x, f.y - player.y),
            t = Math.min(1, Math.max(0, (range - d) / fade));
          targets.set(f.id, t * t * (3 - 2 * t));
        });
    const ease = 1 - Math.exp(-Math.max(0, dt) * 8),
      next = new Map<string, number>();
    for (const id of new Set([
      ...this.practicalWeights.keys(),
      ...targets.keys(),
    ])) {
      const current = this.practicalWeights.get(id) ?? 0,
        target = targets.get(id) ?? 0,
        weight = dt > 0 ? current + (target - current) * ease : target;
      if (weight > 0.002) next.set(id, weight);
    }
    // Only as many fixtures as there are point lights can hand over light.
    const chosen = [...next.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, this.practicals.length);
    this.practicalWeights = new Map(chosen);
    this.lightmap.setPracticals(floor.index, this.practicalWeights);
    const surge = game.surge.state === "active" ? 0.75 : 1;
    this.practicals.forEach((light, i) => {
      const entry = chosen[i],
        fixture = entry && active.plan.fixtures.find((f) => f.id === entry[0]);
      if (!fixture || !entry) {
        light.intensity = 0;
        return;
      }
      light.position.set(
        fixture.x,
        floor.index * FLOOR_HEIGHT + 2.59,
        fixture.y,
      );
      light.color.set(fixture.color);
      light.intensity = fixtureIntensity(fixture) * surge * entry[1];
    });
    return chosen.length;
  }

  private updateDust(game: Game, floor: Floor, lit: boolean) {
    this.dust.visible =
      lit &&
      floor.index < CONFIG.floors &&
      !outsideBuilding(floor, game.survivors[0].x, game.survivors[0].y);
    if (!this.dust.visible) return;
    const a = game.survivors[0],
      position = this.dustGeometry.getAttribute("position"),
      time = game.settings.reducedFlash ? 0 : game.time;
    for (let i = 0; i < position.count; i++) {
      const cellX = Math.floor(a.x / 2) + (i % 4) - 2,
        cellZ = Math.floor(a.y / 2) + (Math.floor(i / 4) % 4) - 2,
        h = interiorHash(
          game.seed,
          floor.index,
          `dust-${cellX}-${cellZ}-${Math.floor(i / 16)}`,
        ),
        x = cellX * 2 + ((h & 1023) / 1023) * 2,
        z = cellZ * 2 + (((h >>> 10) & 1023) / 1023) * 2,
        y = 0.25 + ((((h >>> 20) / 4095) * 2.3 + time * 0.018) % 2.3);
      position.setXYZ(
        i,
        x,
        floor.tiles[Math.floor(z)]?.[Math.floor(x)] === 0
          ? floor.index * FLOOR_HEIGHT + y
          : -100,
        z,
      );
    }
    position.needsUpdate = true;
  }

  private releaseFloor(context: FloorAtmosphere) {
    context.authoredScene?.dispose();
    context.environmentSurfaces?.dispose();
    this.lightmap.clear(context.plan.floor.index);
    for (const pool of [context.solids, context.tubes, ...context.cards])
      pool.dispose(false);
    for (const material of context.authoredMaterials ?? []) {
      material.map?.dispose();
      material.dispose();
    }
    context.group.removeFromParent();
  }

  /** New runs release every floor/instance allocation while retaining the
   * small shared material/texture set and the camera-bound phone object. */
  reset() {
    this.floors.forEach((context) => this.releaseFloor(context));
    this.floors.clear();
    this.lightmap.reset();
    this.practicalWeights.clear();
    this.practicalFloor = -1;
    this.phoneState.reset();
    this.phone.visible = false;
    this.phoneLight.intensity = 0;
    this.phoneBounce.intensity = 0;
    this.practicals.forEach((light) => {
      light.intensity = 0;
    });
    this.dust.visible = false;
    this.currentLight = 1;
    this.group.userData = {
      currentLight: 1,
      phoneRaised: false,
      practicalLights: 0,
    };
    this.phone.userData = { raised: false, mix: 0, illumination: 1 };
    this.run = undefined;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.reset();
    this.phone.removeFromParent();
    this.phoneLight.removeFromParent();
    this.phoneTarget.removeFromParent();
    this.phoneBounce.removeFromParent();
    this.phone.traverse((node) => {
      if (node instanceof Mesh) node.geometry.dispose();
    });
    this.group.removeFromParent();
    this.dustGeometry.dispose();
    this.dustMaterial.dispose();
    const textures = new Set<Texture>();
    for (const material of this.cardMaterials) {
      if (material.map) textures.add(material.map);
      material.dispose();
    }
    textures.forEach((texture) => texture.dispose());
    for (const material of [
      this.solidMaterial,
      this.tubeMaterial,
      this.phoneMaterial,
      this.handMaterial,
      this.screenMaterial,
    ])
      material.dispose();
    this.practicals.forEach((light) => {
      light.dispose();
      light.removeFromParent();
    });
    this.phoneLight.dispose();
    this.phoneBounce.dispose();
    this.lightmap.dispose();
    this.screenTexture?.dispose();
  }
}
