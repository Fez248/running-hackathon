'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useMap } from 'react-leaflet';
import L, { type Map as LeafletMap } from 'leaflet';
import {
  createTileRevealQueue,
  fogCellBounds,
  fogCellIndexFromKey,
  fogCellKey,
  type FogBounds,
} from '@sidewalk/core';

export interface FogCell {
  cellKey: string;
  bounds: FogBounds | null;
}

interface FogLayerProps {
  /** Cells already revealed server-side for the current viewport. */
  cells: FogCell[];
  /** Cells revealed locally in this run, drawn before the server confirms. */
  pendingBounds: FogBounds[];
  /** Whether a run is recording: tiles only unlock while the runner is moving. */
  recording: boolean;
  opacity: number;
  visible: boolean;
}

/** Hex circumradius in world pixels at the reference zoom, before zoom scaling. */
const HEX_WORLD_SIZE = 26;
/** How long a tile's unlock animation plays, in ms. */
const UNLOCK_ANIMATION_MS = 900;
/** How often the layer checks whether the next tile is due, in ms. */
const UNLOCK_POLL_MS = 120;

const SQRT3 = Math.sqrt(3);

/** Smooth deceleration, for fades and the spin settling. */
function easeOutCubic(progress: number): number {
  return 1 - Math.pow(1 - progress, 3);
}

/** Overshoots and settles, so a tile springs open instead of sliding open. */
function easeOutBack(progress: number): number {
  const overshoot = 1.6;
  const shifted = progress - 1;
  return 1 + (overshoot + 1) * shifted * shifted * shifted + overshoot * shifted * shifted;
}

/**
 * Every fog cell revealed in this session, in reveal order.
 *
 * Reveals are monotonic: cells are only ever added. The store lives outside the
 * component because both of its inputs are transient — server coverage queries
 * are viewport-scoped, a run's pending reveals are dropped when it stops, and
 * the layer itself is remounted whenever the map is — so any state derived from
 * them would re-fog ground the runner has already taken.
 *
 * Cells do not land here when they arrive but when the paced queue lets them
 * through, one per second, which is what keeps a whole cluster of coverage from
 * opening in a single frame.
 */
const revealQueue = createTileRevealQueue();
const revealedCells = revealQueue.revealed;
const revealedOrder: string[] = [];

/**
 * Coverage the server already knows about only starts unlocking once this run
 * has revealed something of its own, so the first tile of a run is always the
 * tile the runner is standing on rather than a corner of an old trace.
 */
let catchUpArmed = false;

function releaseDueCells(now: number): void {
  for (const cellKey of revealQueue.release(now)) revealedOrder.push(cellKey);
}

/**
 * Revealed cells projected onto the hex grid of one integer zoom, cached and
 * extended as the revealed set grows.
 *
 * A tile can be larger or smaller than a fog cell depending on the zoom, so
 * matching only in one direction loses reveals: mapping cells onto tiles covers
 * the zoomed-out case (many cells inside one tile), while looking a tile's own
 * centre up in the revealed set covers the zoomed-in case (many tiles inside
 * one cell).
 */
const tilesByZoom = new Map<number, { tiles: Set<string>; consumed: number }>();

function revealedTilesAtZoom(map: LeafletMap, baseZoom: number): Set<string> {
  let entry = tilesByZoom.get(baseZoom);
  if (!entry) {
    entry = { tiles: new Set<string>(), consumed: 0 };
    tilesByZoom.set(baseZoom, entry);
  }
  for (let i = entry.consumed; i < revealedOrder.length; i += 1) {
    const index = fogCellIndexFromKey(revealedOrder[i]!);
    if (!index) continue;
    const b = fogCellBounds(index);
    const corners: Array<[number, number]> = [
      [(b.minLat + b.maxLat) / 2, (b.minLng + b.maxLng) / 2],
      [b.minLat, b.minLng],
      [b.minLat, b.maxLng],
      [b.maxLat, b.minLng],
      [b.maxLat, b.maxLng],
    ];
    for (const [lat, lng] of corners) {
      const point = map.project(L.latLng(lat, lng), baseZoom);
      const axial = axialFromPixel(point.x, point.y, HEX_WORLD_SIZE);
      entry.tiles.add(`${axial.q}:${axial.r}`);
    }
  }
  entry.consumed = revealedOrder.length;
  return entry.tiles;
}

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

function hexPath(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  rotation = 0,
): void {
  ctx.beginPath();
  for (let corner = 0; corner < 6; corner += 1) {
    const angle = (Math.PI / 180) * (60 * corner - 90) + rotation;
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
 * reflowing.
 *
 * Reveals are paced rather than immediate: coverage is queued and released one
 * tile per second, and each released tile springs open with its own unlock
 * animation, so the fog retreats step by step behind the runner. Until a run is
 * recording there is nothing to reveal and the overlay draws nothing at all.
 */
export function FogLayer({ cells, pendingBounds, recording, opacity, visible }: FogLayerProps) {
  const map = useMap();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawRef = useRef<() => void>(() => {});
  /** Tile id -> timestamp it was first seen cleared, for the flash. */
  const clearedAtRef = useRef<Map<string, number>>(new Map());
  const mistRef = useRef<CanvasPattern | null>(null);
  const seededRef = useRef(false);
  const frameRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPendingDraw = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    frameRef.current = null;
    timerRef.current = null;
  }, []);

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
      clearPendingDraw();
      canvas.remove();
      canvasRef.current = null;
    };
  }, [map, clearPendingDraw]);

  useEffect(() => {
    const scheduleFrame = () => {
      clearPendingDraw();
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        drawRef.current();
      });
    };
    const scheduleTick = () => {
      clearPendingDraw();
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        drawRef.current();
      }, UNLOCK_POLL_MS);
    };

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

      // Queued before the visibility check: hiding the fog must not drop
      // reveals that arrive while it is off. Cells the run just walked lead,
      // and the server's view of older coverage follows them.
      const walked = pendingBounds.map((bounds) =>
        fogCellKey({
          lat: (bounds.minLat + bounds.maxLat) / 2,
          lng: (bounds.minLng + bounds.maxLng) / 2,
        }),
      );
      revealQueue.enqueue(walked);
      if (walked.length > 0 || revealedOrder.length > 0) catchUpArmed = true;
      if (catchUpArmed) revealQueue.enqueue(cells.map((cell) => cell.cellKey));

      const now = performance.now();
      // Tiles only unlock while recording: a map nobody is running on neither
      // opens up on its own nor re-fogs what earlier runs took.
      if (recording) releaseDueCells(now);

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, size.x, size.y);
      // Nothing recorded yet: no fog, no tiles, just the map.
      if (!visible || (!recording && revealedOrder.length === 0)) return;

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
      const revealedTiles = revealedTilesAtZoom(map, baseZoom);
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
          const cellKey = fogCellKey({ lat: latLng.lat, lng: latLng.lng });
          const cleared = revealedTiles.has(`${q}:${r}`) || revealedCells.has(cellKey);
          tiles.push({ id, q, r, cx: screen.x, cy: screen.y, cleared });
        }
      }

      // First paint of a viewport should not flash the whole explored area.
      const clearedAt = clearedAtRef.current;
      for (const tile of tiles) {
        if (tile.cleared && !clearedAt.has(tile.id)) {
          clearedAt.set(tile.id, seededRef.current ? now : 0);
        }
      }
      seededRef.current = true;
      if (clearedAt.size > 4000) {
        for (const [id, at] of clearedAt) {
          if (now - at > UNLOCK_ANIMATION_MS) clearedAt.delete(id);
          if (clearedAt.size <= 3000) break;
        }
      }

      // Fog body: unlit ink, then mist, then per-tile shading, so undiscovered
      // ground looks like weather over a tabletop map.
      ctx.fillStyle = `rgba(12, 14, 13, ${opacity})`;
      ctx.fillRect(0, 0, size.x, size.y);
      if (mistRef.current) {
        ctx.save();
        ctx.globalAlpha = 0.5 * opacity;
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
        ctx.globalAlpha = (pale ? 0.07 + noise * 0.06 : 0.1 + noise * 0.2) * opacity;
        ctx.fillStyle = pale ? 'rgba(226, 232, 240, 1)' : 'rgba(6, 7, 9, 1)';
        hexPath(ctx, tile.cx, tile.cy, hexScreen * (0.86 + noise * 0.14));
        ctx.fill();
      }
      ctx.restore();

      /** How far into its unlock a tile is: 0 just taken, 1 fully settled. */
      const unlockProgress = (tile: Tile): number => {
        const at = clearedAt.get(tile.id) ?? 0;
        if (at === 0) return 1;
        return Math.min(1, (now - at) / UNLOCK_ANIMATION_MS);
      };

      // Punch the explored tiles out of the fog. A tile just taken unfolds from
      // its centre with a twist that settles as it lands.
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      for (const tile of tiles) {
        if (!tile.cleared) continue;
        const progress = unlockProgress(tile);
        const grow = progress === 1 ? 1 : Math.min(1.06, Math.max(0, easeOutBack(progress)));
        const spin = (1 - easeOutCubic(progress)) * (Math.PI / 6);
        ctx.fillStyle = 'rgba(0,0,0,1)';
        hexPath(ctx, tile.cx, tile.cy, hexScreen * 1.02 * grow, spin);
        ctx.fill();
      }
      ctx.restore();

      // Grid on top: inked hex borders, brighter over discovered ground. A
      // tile's own border fades in over its unlock rather than snapping on.
      ctx.lineWidth = Math.max(1, hexScreen / 22);
      for (const tile of tiles) {
        ctx.strokeStyle = tile.cleared
          ? `rgba(214, 179, 102, ${0.34 * easeOutCubic(unlockProgress(tile))})`
          : 'rgba(120, 113, 84, 0.35)';
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

      // Unlock animation: a freshly taken tile blooms warm, its rim lights up
      // and a ring travels outwards before it all settles into the grid.
      let animating = false;
      ctx.save();
      for (const tile of tiles) {
        if (!tile.cleared) continue;
        const at = clearedAt.get(tile.id) ?? 0;
        if (at === 0) continue;
        const progress = (now - at) / UNLOCK_ANIMATION_MS;
        if (progress >= 1) continue;
        animating = true;
        const eased = easeOutCubic(progress);
        const fade = 1 - eased;
        const spin = fade * (Math.PI / 6);

        ctx.globalAlpha = 0.45 * fade;
        ctx.fillStyle = 'rgba(255, 214, 138, 1)';
        hexPath(
          ctx,
          tile.cx,
          tile.cy,
          hexScreen * 0.98 * Math.max(0, easeOutBack(progress)),
          spin,
        );
        ctx.fill();

        ctx.globalAlpha = Math.min(1, fade * 1.3);
        ctx.lineWidth = Math.max(1.5, (hexScreen / 9) * fade + 1);
        ctx.strokeStyle = 'rgba(255, 236, 190, 1)';
        hexPath(ctx, tile.cx, tile.cy, hexScreen * (0.55 + 0.45 * eased), spin);
        ctx.stroke();

        ctx.globalAlpha = 0.5 * fade * fade;
        ctx.lineWidth = Math.max(1, hexScreen / 14);
        ctx.strokeStyle = 'rgba(255, 198, 96, 1)';
        hexPath(ctx, tile.cx, tile.cy, hexScreen * (1 + 0.6 * eased), spin * 0.5);
        ctx.stroke();
      }
      ctx.restore();

      if (animating) scheduleFrame();
      // Waiting on the next release: a slow poll rather than an animation loop,
      // so a run between unlocks does not repaint on every frame.
      else if (recording && revealQueue.pending > 0) scheduleTick();
    };
    drawRef.current();
  }, [cells, pendingBounds, recording, opacity, visible, map, clearPendingDraw]);

  return null;
}
