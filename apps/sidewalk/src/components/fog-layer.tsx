'use client';

import { useEffect, useRef } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';
import { fogCellKey, type FogBounds } from '@sidewalk/core';

export interface FogCell {
  cellKey: string;
  bounds: FogBounds | null;
}

interface FogLayerProps {
  /** Cells already revealed server-side for the current viewport. */
  cells: FogCell[];
  /** Cells revealed locally in this run, drawn before the server confirms. */
  pendingBounds: FogBounds[];
  /** Live position: keeps a hole around the runner even before a reveal lands. */
  liveHole: { lat: number; lng: number; radiusM: number } | null;
  opacity: number;
  visible: boolean;
}

/** Hex circumradius in world pixels at the reference zoom, before zoom scaling. */
const HEX_WORLD_SIZE = 26;
/** How long a tile's clearing flash plays, in ms. */
const CLEAR_ANIMATION_MS = 900;

const SQRT3 = Math.sqrt(3);

/**
 * Drifting mist, baked once into a tiling canvas: soft blots of pale grey over
 * transparency, so fogged hexes read as cloud rather than as a flat scrim.
 */
function createMistPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  const tile = document.createElement('canvas');
  tile.width = 128;
  tile.height = 128;
  const tileCtx = tile.getContext('2d');
  if (!tileCtx) return null;

  // A fixed pseudo-random sequence: the mist must be identical on every redraw.
  let seed = 1337;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  for (let blot = 0; blot < 90; blot += 1) {
    const x = random() * 128;
    const y = random() * 128;
    const radius = 8 + random() * 26;
    const alpha = 0.03 + random() * 0.09;
    const gradient = tileCtx.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, `rgba(203, 213, 225, ${alpha})`);
    gradient.addColorStop(1, 'rgba(203, 213, 225, 0)');
    tileCtx.fillStyle = gradient;
    tileCtx.beginPath();
    tileCtx.arc(x, y, radius, 0, Math.PI * 2);
    tileCtx.fill();
  }

  return ctx.createPattern(tile, 'repeat');
}

/** Stable per-tile jitter, so neighbouring fogged hexes are not identical. */
function tileNoise(q: number, r: number): number {
  const hash = Math.sin(q * 127.1 + r * 311.7) * 43758.5453;
  return hash - Math.floor(hash);
}

interface Axial {
  q: number;
  r: number;
}

function axialFromPixel(x: number, y: number, size: number): Axial {
  const q = ((SQRT3 / 3) * x - y / 3) / size;
  const r = ((2 / 3) * y) / size;
  // Cube rounding keeps neighbouring pixels from landing on the same tile.
  const cx = q;
  const cz = r;
  const cy = -cx - cz;
  let rx = Math.round(cx);
  let ry = Math.round(cy);
  let rz = Math.round(cz);
  const dx = Math.abs(rx - cx);
  const dy = Math.abs(ry - cy);
  const dz = Math.abs(rz - cz);
  if (dx > dy && dx > dz) rx = -ry - rz;
  else if (dy > dz) ry = -rx - rz;
  else rz = -rx - ry;
  return { q: rx, r: rz };
}

function pixelFromAxial(q: number, r: number, size: number): { x: number; y: number } {
  return { x: size * SQRT3 * (q + r / 2), y: size * 1.5 * r };
}

function hexPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number): void {
  ctx.beginPath();
  for (let corner = 0; corner < 6; corner += 1) {
    const angle = (Math.PI / 180) * (60 * corner - 90);
    const x = cx + radius * Math.cos(angle);
    const y = cy + radius * Math.sin(angle);
    if (corner === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

/**
 * Fog of War overlay, drawn as a hexagonal tile grid in the spirit of a
 * classic RTS minimap.
 *
 * One canvas in Leaflet's overlay pane is filled with fog, the hexes covering
 * explored ground are punched out with `destination-out`, and the grid is
 * stroked back over the result. The tile grid is anchored in world pixels at
 * the nearest integer zoom and then scaled by the fractional part, so tiles sit
 * on fixed ground and grow and shrink smoothly while zooming instead of
 * reflowing. A tile that has just been cleared plays a short flash, which is
 * what makes progress legible while running.
 */
export function FogLayer({ cells, pendingBounds, liveHole, opacity, visible }: FogLayerProps) {
  const map = useMap();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawRef = useRef<() => void>(() => {});
  /** Tile id -> timestamp it was first seen cleared, for the flash. */
  const clearedAtRef = useRef<Map<string, number>>(new Map());
  /**
   * Every fog cell this session has ever seen revealed. Server queries are
   * viewport-scoped and a run's pending reveals are dropped when it stops, so
   * derived state would re-fog ground the runner already took. Reveals are
   * monotonic: this set only grows.
   */
  const revealedRef = useRef<Set<string>>(new Set());
  /** Tiles cleared by passing the runner over them, kept for the same reason. */
  const clearedTilesRef = useRef<Set<string>>(new Set());
  const mistRef = useRef<CanvasPattern | null>(null);
  const seededRef = useRef(false);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    const canvas = L.DomUtil.create('canvas', 'fog-canvas') as HTMLCanvasElement;
    canvas.style.position = 'absolute';
    canvas.style.pointerEvents = 'none';
    canvas.style.zIndex = '400';
    map.getPanes().overlayPane.appendChild(canvas);
    canvasRef.current = canvas;

    const draw = () => drawRef.current();
    map.on('move zoom viewreset resize zoomend moveend', draw);
    draw();

    return () => {
      map.off('move zoom viewreset resize zoomend moveend', draw);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      canvas.remove();
      canvasRef.current = null;
    };
  }, [map]);

  useEffect(() => {
    drawRef.current = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const size = map.getSize();
      const ratio = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
      if (canvas.width !== size.x * ratio || canvas.height !== size.y * ratio) {
        canvas.width = size.x * ratio;
        canvas.height = size.y * ratio;
        canvas.style.width = `${size.x}px`;
        canvas.style.height = `${size.y}px`;
      }
      L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]));

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, size.x, size.y);
      if (!visible) return;

      const revealed = revealedRef.current;
      for (const cell of cells) revealed.add(cell.cellKey);
      for (const bounds of pendingBounds) {
        revealed.add(
          fogCellKey({
            lat: (bounds.minLat + bounds.maxLat) / 2,
            lng: (bounds.minLng + bounds.maxLng) / 2,
          }),
        );
      }
      if (!mistRef.current) mistRef.current = createMistPattern(ctx);

      // Tile grid: anchored at the nearest integer zoom, scaled by the rest.
      const zoom = map.getZoom();
      const baseZoom = Math.round(zoom);
      const scale = Math.pow(2, zoom - baseZoom);
      const hexScreen = HEX_WORLD_SIZE * scale;
      const origin = map.project(map.getCenter(), baseZoom);
      const toScreen = (wx: number, wy: number) => ({
        x: (wx - origin.x) * scale + size.x / 2,
        y: (wy - origin.y) * scale + size.y / 2,
      });

      const halfW = size.x / 2 / scale;
      const halfH = size.y / 2 / scale;
      const corners: Array<{ x: number; y: number }> = [
        { x: origin.x - halfW, y: origin.y - halfH },
        { x: origin.x + halfW, y: origin.y - halfH },
        { x: origin.x - halfW, y: origin.y + halfH },
        { x: origin.x + halfW, y: origin.y + halfH },
      ];
      let minQ = Infinity;
      let maxQ = -Infinity;
      let minR = Infinity;
      let maxR = -Infinity;
      for (const corner of corners) {
        const axial = axialFromPixel(corner.x, corner.y, HEX_WORLD_SIZE);
        minQ = Math.min(minQ, axial.q);
        maxQ = Math.max(maxQ, axial.q);
        minR = Math.min(minR, axial.r);
        maxR = Math.max(maxR, axial.r);
      }
      // Skew means a rectangle of axial coordinates has to be padded generously.
      const pad = 2 + Math.ceil((maxR - minR) / 2);
      minQ -= pad;
      maxQ += pad;
      minR -= 2;
      maxR += 2;

      const liveCenter = liveHole
        ? map.latLngToContainerPoint([liveHole.lat, liveHole.lng])
        : null;
      let liveRadiusPx = 0;
      if (liveHole && liveCenter) {
        const edge = map.latLngToContainerPoint(
          L.latLng(liveHole.lat, liveHole.lng).toBounds(liveHole.radiusM * 2).getNorthEast(),
        );
        liveRadiusPx = Math.max(Math.abs(edge.x - liveCenter.x), 8);
      }

      interface Tile {
        id: string;
        q: number;
        r: number;
        cx: number;
        cy: number;
        cleared: boolean;
      }
      const tiles: Tile[] = [];
      const margin = hexScreen * 1.2;
      for (let r = minR; r <= maxR; r += 1) {
        for (let q = minQ; q <= maxQ; q += 1) {
          const world = pixelFromAxial(q, r, HEX_WORLD_SIZE);
          const screen = toScreen(world.x, world.y);
          if (
            screen.x < -margin ||
            screen.y < -margin ||
            screen.x > size.x + margin ||
            screen.y > size.y + margin
          ) {
            continue;
          }
          const id = `${baseZoom}:${q}:${r}`;
          const latLng = map.unproject(L.point(world.x, world.y), baseZoom).wrap();
          let cleared =
            clearedTilesRef.current.has(id) ||
            revealed.has(fogCellKey({ lat: latLng.lat, lng: latLng.lng }));
          if (!cleared && liveCenter) {
            const dx = screen.x - liveCenter.x;
            const dy = screen.y - liveCenter.y;
            cleared = dx * dx + dy * dy <= liveRadiusPx * liveRadiusPx;
          }
          // Taken ground stays taken, whatever the next server query returns.
          if (cleared) clearedTilesRef.current.add(id);
          tiles.push({ id, q, r, cx: screen.x, cy: screen.y, cleared });
        }
      }

      // First paint of a viewport should not flash the whole explored area.
      const now = performance.now();
      const clearedAt = clearedAtRef.current;
      for (const tile of tiles) {
        if (tile.cleared && !clearedAt.has(tile.id)) {
          clearedAt.set(tile.id, seededRef.current ? now : 0);
        }
      }
      seededRef.current = true;
      if (clearedAt.size > 4000) {
        for (const [id, at] of clearedAt) {
          if (now - at > CLEAR_ANIMATION_MS) clearedAt.delete(id);
          if (clearedAt.size <= 3000) break;
        }
      }

      // Fog body: unlit ink, then mist, then per-tile shading, so undiscovered
      // ground looks like weather over a tabletop map.
      ctx.fillStyle = `rgba(12, 14, 13, ${opacity})`;
      ctx.fillRect(0, 0, size.x, size.y);
      if (mistRef.current) {
        ctx.save();
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = mistRef.current;
        ctx.fillRect(0, 0, size.x, size.y);
        ctx.restore();
      }
      ctx.save();
      for (const tile of tiles) {
        if (tile.cleared) continue;
        const noise = tileNoise(tile.q, tile.r);
        // Mostly deepening shadow, with the occasional paler bank of cloud.
        const pale = noise > 0.82;
        ctx.globalAlpha = pale ? 0.07 + noise * 0.06 : 0.1 + noise * 0.2;
        ctx.fillStyle = pale ? 'rgba(226, 232, 240, 1)' : 'rgba(6, 7, 9, 1)';
        hexPath(ctx, tile.cx, tile.cy, hexScreen * (0.86 + noise * 0.14));
        ctx.fill();
      }
      ctx.restore();

      // Punch the explored tiles out of the fog.
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      for (const tile of tiles) {
        if (!tile.cleared) continue;
        const at = clearedAt.get(tile.id) ?? 0;
        const age = at === 0 ? 1 : Math.min(1, (now - at) / CLEAR_ANIMATION_MS);
        // A tile opens up from its centre outwards, then stays open.
        const grow = 0.55 + 0.45 * age;
        ctx.fillStyle = 'rgba(0,0,0,1)';
        hexPath(ctx, tile.cx, tile.cy, hexScreen * 1.02 * grow);
        ctx.fill();
      }
      if (liveCenter) {
        const gradient = ctx.createRadialGradient(
          liveCenter.x,
          liveCenter.y,
          0,
          liveCenter.x,
          liveCenter.y,
          liveRadiusPx,
        );
        gradient.addColorStop(0, 'rgba(0,0,0,1)');
        gradient.addColorStop(0.75, 'rgba(0,0,0,1)');
        gradient.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(liveCenter.x, liveCenter.y, liveRadiusPx, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();

      // Grid on top: inked hex borders, brighter over discovered ground.
      ctx.lineWidth = Math.max(1, hexScreen / 22);
      for (const tile of tiles) {
        ctx.strokeStyle = tile.cleared ? 'rgba(214, 179, 102, 0.34)' : 'rgba(120, 113, 84, 0.35)';
        hexPath(ctx, tile.cx, tile.cy, hexScreen);
        ctx.stroke();
      }

      // Frontier: an explored tile touching fog gets a lit edge, so the cleared
      // territory reads as a shape rather than a hole.
      const clearedIds = new Set(tiles.filter((tile) => tile.cleared).map((tile) => tile.id));
      ctx.save();
      ctx.lineWidth = Math.max(1.5, hexScreen / 12);
      ctx.strokeStyle = 'rgba(245, 197, 92, 0.55)';
      ctx.shadowColor = 'rgba(255, 176, 59, 0.9)';
      ctx.shadowBlur = hexScreen / 2;
      for (const tile of tiles) {
        if (!tile.cleared) continue;
        const neighbours: Array<[number, number]> = [
          [tile.q + 1, tile.r],
          [tile.q - 1, tile.r],
          [tile.q, tile.r + 1],
          [tile.q, tile.r - 1],
          [tile.q + 1, tile.r - 1],
          [tile.q - 1, tile.r + 1],
        ];
        const onFrontier = neighbours.some(
          ([nq, nr]) => !clearedIds.has(`${baseZoom}:${nq}:${nr}`),
        );
        if (!onFrontier) continue;
        hexPath(ctx, tile.cx, tile.cy, hexScreen * 0.94);
        ctx.stroke();
      }
      ctx.restore();

      // Clearing flash: a tile lights up and fades as it is taken.
      let animating = false;
      ctx.save();
      for (const tile of tiles) {
        if (!tile.cleared) continue;
        const at = clearedAt.get(tile.id) ?? 0;
        if (at === 0) continue;
        const age = (now - at) / CLEAR_ANIMATION_MS;
        if (age >= 1) continue;
        animating = true;
        const fade = 1 - age;
        ctx.globalAlpha = 0.5 * fade;
        ctx.fillStyle = 'rgba(255, 214, 138, 1)';
        hexPath(ctx, tile.cx, tile.cy, hexScreen * (0.4 + 0.6 * age));
        ctx.fill();
        ctx.globalAlpha = Math.min(1, fade * 1.4);
        ctx.lineWidth = Math.max(1.5, hexScreen / 9);
        ctx.strokeStyle = 'rgba(255, 236, 190, 1)';
        hexPath(ctx, tile.cx, tile.cy, hexScreen * (0.7 + 0.5 * age));
        ctx.stroke();
      }
      ctx.restore();

      if (animating) {
        if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
        frameRef.current = requestAnimationFrame(() => {
          frameRef.current = null;
          drawRef.current();
        });
      }
    };
    drawRef.current();
  }, [cells, pendingBounds, liveHole, opacity, visible, map]);

  return null;
}
