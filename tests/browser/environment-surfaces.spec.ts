import { mkdir, writeFile } from "node:fs/promises";
import { expect, test } from "./helpers/offline-test";

test("every saved environmental surface renders unique writing and structured art across movement, destruction and reload", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.routeWebSocket("**/*", () => {});
  await page.goto("/lab.html");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const proof = await page.evaluate(async () => {
    const [
      { FirstPersonView },
      { createPlayableGame },
      { parseRunDesign, runDesignFingerprint },
      { expandContentText },
      { surfaceWorldPose },
      { encode, decode },
      { solid },
      { Matrix4, Vector3 },
    ] = await Promise.all([
      import("/src/view3d/scene.ts" as string),
      import("/src/world.ts" as string),
      import("/src/run-design-contract.mjs" as string),
      import("/src/environment-contract.mjs" as string),
      import("/src/environment-surfaces.ts" as string),
      import("/src/persistence.ts" as string),
      import("/src/spatial.ts" as string),
      import("/node_modules/three/build/three.module.js" as string),
    ]);
    const roadmap = await (await fetch("/curriculum.json")).json(),
      rawDesign = await (
        await fetch("/tests/fixtures/run-designs/harbor-inscriptions.json")
      ).json(),
      longSlot = rawDesign.environment.surfaces.find(
        (s: any) => s.floor === 0 && s.role === "wall-poster",
      ),
      longEntry = rawDesign.environment.entries.find(
        (e: any) => e.surfaceId === longSlot.id,
      ),
      longTitle = "UninterruptedEnvironmentalInscriptionForTomorrow",
      longBody =
        "Keep the blue notebooks with the radio team. Each page records a safe meeting place, name, and a promise to return before dawn. Please leave this last light on.";
    // Exercise both real surface budgets, including wrapping a single 48-char
    // token. This is accepted by the full strict design validator before build.
    longEntry.title = [{ text: longTitle }];
    longEntry.body = [{ text: longBody }];
    longEntry.layout = longEntry.drawing ? "mixed" : "text";
    const design = parseRunDesign(rawDesign),
      game = createPlayableGame(42, roadmap, undefined, {
        version: 1,
        source: "fixture",
        requestId: "environment-browser",
        generationId: "environment-browser",
        fingerprint: runDesignFingerprint(design),
        design,
      }),
      canvas = document.createElement("canvas"),
      gallery = document.createElement("div"),
      texts = new WeakMap<HTMLCanvasElement, string[]>(),
      paints = new WeakMap<
        HTMLCanvasElement,
        { text: string; size: number; color: string; x: number; y: number }[]
      >(),
      fillText = CanvasRenderingContext2D.prototype.fillText;
    canvas.style.cssText = "position:fixed;inset:0;width:960px;height:650px";
    canvas.width = 960;
    canvas.height = 650;
    document.body.append(canvas);
    gallery.id = "environment-gallery";
    gallery.style.cssText =
      "position:fixed;inset:0;z-index:100000;overflow:auto;background:#142128;padding:16px;display:grid;grid-template-columns:repeat(2,1fr);gap:12px;align-content:start";
    document.body.append(gallery);
    CanvasRenderingContext2D.prototype.fillText = function (
      value: string,
      ...args: [number, number, number?]
    ) {
      const rows = texts.get(this.canvas) ?? [];
      rows.push(value);
      texts.set(this.canvas, rows);
      const transform = this.getTransform(),
        records = paints.get(this.canvas) ?? [];
      records.push({
        text: value,
        size: Number(this.font.match(/[\d.]+(?=px)/)?.[0]),
        color: String(this.fillStyle),
        x: transform.e + args[0],
        y: transform.f + args[1],
      });
      paints.set(this.canvas, records);
      return fillText.call(this, value, ...args);
    };
    const view = new FirstPersonView(canvas),
      pictures: { name: string; image: string }[] = [];
    game.status = "playing";
    game.zombies = [];
    game.survivors = [game.survivors[0]];
    game.settings.reducedFlash = true;
    const surfaces = design.environment.surfaces,
      entries = new Map(
        design.environment.entries.map((e: any) => [e.surfaceId, e]),
      );
    const show = (name: string, image: string) => {
      const figure = document.createElement("figure"),
        caption = document.createElement("figcaption"),
        img = document.createElement("img");
      figure.style.cssText = "margin:0";
      caption.textContent = name;
      caption.style.cssText =
        "font:14px sans-serif;color:#e9e1cb;margin-bottom:5px";
      img.src = image;
      img.style.cssText =
        "display:block;width:100%;max-height:400px;object-fit:contain";
      figure.append(caption, img);
      gallery.append(figure);
      pictures.push({ name, image });
    };
    const look = (current: any, slot: any) => {
      const floor = current.floors[slot.floor],
        pose = surfaceWorldPose(floor, slot),
        target = { x: pose.x, y: pose.y },
        normal = { x: -Math.sin(pose.yaw), y: Math.cos(pose.yaw) },
        candidates = [1.05, 1.4, 1.8, 2.2]
          .map(
            (distance) => distance + Math.max(0, slot.binding.width * 0.7 - 1),
          )
          .flatMap((distance) =>
            [0, 0.4, -0.4].map((offset) => ({
              x: target.x + normal.x * distance + normal.y * offset,
              y: target.y + normal.y * distance - normal.x * offset,
            })),
          ),
        position =
          candidates.find((p) => !solid(floor, p, 0.26)) ?? candidates[0],
        actor = current.survivors[0];
      Object.assign(actor, position, { floor: slot.floor });
      delete actor.elevated;
      delete actor.stairTravel;
      const yaw = Math.atan2(target.y - actor.y, target.x - actor.x),
        pitch = Math.atan2(
          pose.z - 1.6,
          Math.hypot(target.x - actor.x, target.y - actor.y),
        );
      for (let i = 0; i < 3; i++) view.render(current, yaw, pitch, 0.1);
      return { yaw, pitch };
    };
    const allPages = () => {
      const result: any[] = [];
      (view as any).atmosphere.group.traverse((node: any) => {
        if (node.name.startsWith("environment-atlas-page-")) result.push(node);
      });
      (view as any).exterior.group.traverse((node: any) => {
        if (node.name.startsWith("environment-atlas-page-")) result.push(node);
      });
      return result;
    };
    const loadFloors = (current: any) => {
      for (let floor = 0; floor < 4; floor++)
        look(
          current,
          surfaces.find(
            (s: any) => s.floor === floor && s.role === "wall-poster",
          ),
        );
    };
    const snapshot = async () =>
      Promise.all(
        allPages().map(async (mesh) => {
          const image = mesh.material.map.image as HTMLCanvasElement,
            digest = await crypto.subtle.digest(
              "SHA-256",
              image
                .getContext("2d")!
                .getImageData(0, 0, image.width, image.height).data,
            ),
            pixelHash = Array.from(new Uint8Array(digest), (n) =>
              n.toString(16).padStart(2, "0"),
            ).join("");
          return {
            ids: mesh.userData.surfaceIds,
            width: image.width,
            height: image.height,
            pixelHash,
            text: texts.get(image) ?? [],
            uv: Array.from(mesh.geometry.getAttribute("environmentUv").array),
            matrices: Array.from(
              mesh.instanceMatrix.array.slice(0, mesh.count * 16),
            ),
          };
        }),
      );
    try {
      loadFloors(game);
      const before = await snapshot(),
        longMesh = allPages().find((p) =>
          p.userData.surfaceIds.includes(longSlot.id),
        ),
        longIndex = longMesh.userData.surfaceIds.indexOf(longSlot.id),
        longUv = longMesh.geometry.getAttribute("environmentUv"),
        longImage = longMesh.material.map.image as HTMLCanvasElement,
        longRect = {
          x: longUv.getX(longIndex) * longImage.width,
          width: longUv.getZ(longIndex) * longImage.width,
          y:
            (1 - longUv.getY(longIndex) - longUv.getW(longIndex)) *
            longImage.height,
          height: longUv.getW(longIndex) * longImage.height,
        },
        longPaints = paints
          .get(longImage)!
          .filter(
            (p) =>
              p.x >= longRect.x &&
              p.x < longRect.x + longRect.width &&
              p.y >= longRect.y &&
              p.y < longRect.y + longRect.height,
          ),
        sampleMargin = Math.min(longRect.width, longRect.height) * 0.055 * 0.75,
        paper = Array.from(
          longImage
            .getContext("2d")!
            .getImageData(
              longRect.x + sampleMargin,
              longRect.y + sampleMargin,
              1,
              1,
            ).data,
        ).slice(0, 3),
        ink = longPaints[0].color
          .match(/[a-f0-9]{2}/gi)!
          .map((n) => parseInt(n, 16)),
        luminance = (rgb: number[]) =>
          rgb
            .map((n) => {
              const c = n / 255;
              return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
            })
            .reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i], 0),
        longText = {
          titleChars: longTitle.length,
          bodyChars: longBody.length,
          maxTitle: longSlot.maxTitle,
          maxBody: longSlot.maxBody,
          minimumFont: Math.min(...longPaints.map((p) => p.size)),
          lines: longPaints.length,
          printed: longPaints.map((p) => p.text).join(""),
          expected: longTitle + longBody,
          contrast: (luminance(paper) + 0.05) / (luminance(ink) + 0.05),
          withinBounds: longPaints.every(
            (p) => p.y + p.size <= longRect.y + longRect.height,
          ),
          allMinimumFont: Math.min(
            ...allPages().flatMap((p) =>
              paints.get(p.material.map.image)!.map((record) => record.size),
            ),
          ),
        },
        saved = encode(game),
        representative = [
          "wall-poster",
          "wall-whiteboard",
          "desk-photo",
          "graffiti",
          "prop-face",
          "storefront-sign",
        ]
          .map(
            (role) =>
              surfaces.find(
                (s: any) =>
                  s.floor === 0 &&
                  s.role === role &&
                  (entries.get(s.id) as any)?.drawing,
              ) ?? surfaces.find((s: any) => s.floor === 0 && s.role === role),
          )
          .filter(Boolean);
      for (const slot of representative) {
        const pose = look(game, slot);
        await view.renderer.compileAsync((view as any).scene, view.camera);
        view.render(game, pose.yaw, pose.pitch, 0);
        show(
          `${slot.role} · ${(entries.get(slot.id) as any).description || slot.context}`,
          canvas.toDataURL("image/png"),
        );
      }
      // Show actual atlas crops too: this distinguishes a real illustration from
      // distant geometry that happens to have the expected label metadata.
      for (const slot of representative.filter(
        (s: any) => (entries.get(s.id) as any)?.drawing,
      )) {
        const mesh = allPages().find((p) =>
            p.userData.surfaceIds.includes(slot.id),
          ),
          index = mesh.userData.surfaceIds.indexOf(slot.id),
          uv = mesh.geometry.getAttribute("environmentUv"),
          image = mesh.material.map.image as HTMLCanvasElement,
          crop = document.createElement("canvas");
        const x = uv.getX(index) * image.width,
          h = uv.getW(index) * image.height,
          y = image.height - uv.getY(index) * image.height - h,
          w = uv.getZ(index) * image.width;
        crop.width = Math.max(1, Math.round(w));
        crop.height = Math.max(1, Math.round(h));
        crop
          .getContext("2d")!
          .drawImage(image, x, y, w, h, 0, 0, crop.width, crop.height);
        show(`Printed art · ${slot.role}`, crop.toDataURL("image/png"));
      }
      const bound = surfaces.find(
          (s: any) => s.floor === 0 && s.binding.kind === "prop",
        ),
        host = game.floors[0].furniture.find(
          (o: any) => o.id === bound.binding.furnitureId,
        ),
        camera = look(game, bound),
        mesh = allPages().find((p) => p.userData.surfaceIds.includes(bound.id)),
        index = mesh.userData.surfaceIds.indexOf(bound.id),
        matrix = new Matrix4();
      mesh.getMatrixAt(index, matrix);
      const first = new Vector3().setFromMatrixPosition(matrix),
        x = host.x,
        y = host.y;
      host.x += 0.5;
      host.y -= 0.25;
      host.angle = (host.angle ?? 0) + Math.PI / 2;
      view.render(game, camera.yaw, camera.pitch, 0);
      mesh.getMatrixAt(index, matrix);
      const moved = new Vector3().setFromMatrixPosition(matrix).toArray(),
        expected = [host.x - (first.z - y), first.y, host.y + (first.x - x)];
      host.destroyed = true;
      view.render(game, camera.yaw, camera.pitch, 0);
      mesh.getMatrixAt(index, matrix);
      const hidden = matrix.determinant();
      let disposed = 0;
      const oldPages = allPages();
      oldPages.forEach((p) =>
        p.material.map.addEventListener("dispose", () => disposed++),
      );
      const restored = decode(saved);
      loadFloors(restored);
      const after = await snapshot();
      return {
        before,
        after,
        longText,
        moved,
        expected,
        hidden,
        disposed,
        oldPageCount: oldPages.length,
        ids: surfaces.map((s: any) => s.id),
        expectedText: design.environment.entries.map((e: any) => ({
          id: e.surfaceId,
          text:
            expandContentText(e.title, design.environment.fragments) +
            expandContentText(e.body, design.environment.fragments),
        })),
        pictures,
        fixedRouteVisible: !!(view as any).exterior.group.getObjectByName(
          "rooftop-assembly-sign",
        ),
        legacyCardCount: (view as any).atmosphere.group.getObjectsByProperty(
          "name",
          "office-story-surface-0",
        ).length,
        legacyShopVisible: !!(view as any).exterior.group.getObjectByName(
          "city-shopfront-signs",
        ),
      };
    } finally {
      CanvasRenderingContext2D.prototype.fillText = fillText;
      view.dispose();
    }
  });
  expect(errors).toEqual([]);
  expect(proof.longText.titleChars).toBe(proof.longText.maxTitle);
  expect(proof.longText.bodyChars).toBe(proof.longText.maxBody);
  expect(proof.longText.lines).toBeGreaterThanOrEqual(6);
  expect(proof.longText.minimumFont).toBeGreaterThanOrEqual(8);
  expect(proof.longText.contrast).toBeGreaterThanOrEqual(7);
  expect(proof.longText.withinBounds).toBe(true);
  expect(proof.longText.printed.replace(/\s/g, "")).toBe(
    proof.longText.expected.replace(/\s/g, ""),
  );
  expect(proof.before.flatMap((p) => p.ids).sort()).toEqual(
    [...proof.ids].sort(),
  );
  expect(proof.before.length).toBeLessThan(30);
  expect(proof.before.reduce((n, p) => n + p.width * p.height, 0)).toBeLessThan(
    40_000_000,
  );
  for (const page of proof.before) {
    expect(page.width).toBeLessThanOrEqual(2048);
    expect(page.height).toBeLessThanOrEqual(2048);
    const printed = page.text.join("").replace(/\s/g, "");
    for (const id of page.ids)
      expect(printed).toContain(
        proof.expectedText
          .find((e: { id: string; text: string }) => e.id === id)!
          .text.replace(/\s/g, ""),
      );
    expect(
      new Set(
        page.ids.map((_id: string, i: number) =>
          page.uv.slice(i * 4, i * 4 + 4).join(","),
        ),
      ).size,
    ).toBe(page.ids.length);
  }
  expect(proof.after).toEqual(proof.before);
  proof.moved.forEach((n: number, i: number) =>
    expect(n).toBeCloseTo(proof.expected[i], 4),
  );
  expect(proof.hidden).toBe(0);
  expect(proof.disposed).toBe(proof.oldPageCount);
  expect(proof.fixedRouteVisible).toBe(false);
  expect(proof.legacyCardCount).toBe(0);
  expect(proof.legacyShopVisible).toBe(false);
  await mkdir(".artifacts/handoff/environment", { recursive: true });
  await writeFile(
    ".artifacts/handoff/environment/readability.json",
    JSON.stringify(proof.longText, null, 2),
  );
  for (const [index, picture] of proof.pictures.entries())
    await writeFile(
      `.artifacts/handoff/environment/surface-${index}.png`,
      Buffer.from(picture.image.split(",")[1], "base64"),
    );
  await page.locator("#environment-gallery").evaluate((element) => {
    element.style.position = "relative";
    element.style.height = "auto";
    element.style.overflow = "visible";
  });
  await page.locator("#environment-gallery").screenshot({
    path: ".artifacts/handoff/environment/illustrated-surfaces.png",
  });
});
