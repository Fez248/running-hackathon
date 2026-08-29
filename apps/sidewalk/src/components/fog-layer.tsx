'use client';

import { useEffect, useRef } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';
import type { FogBounds } from '@sidewalk/core';

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

/**
 * Fog of War overlay.
 *
 * One canvas in Leaflet's overlay pane is filled with fog, then the revealed
 * cells are punched out with `destination-out`. A canvas (rather than N Leaflet
 * rectangles) keeps redraws cheap when a run has revealed thousands of cells.
 */
export function FogLayer({ cells, pendingBounds, liveHole, opacity, visible }: FogLayerProps) {
  const map = useMap();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawRef = useRef<() => void>(() => {});

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

      ctx.fillStyle = `rgba(9, 11, 16, ${opacity})`;
      ctx.fillRect(0, 0, size.x, size.y);

      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';

      const punchCell = (bounds: FogBounds) => {
        const topLeft = map.latLngToContainerPoint([bounds.maxLat, bounds.minLng]);
        const bottomRight = map.latLngToContainerPoint([bounds.minLat, bounds.maxLng]);
        // Grow by a pixel so neighbouring cells do not leave fog seams.
        ctx.fillRect(
          topLeft.x - 1,
          topLeft.y - 1,
          bottomRight.x - topLeft.x + 2,
          bottomRight.y - topLeft.y + 2,
        );
      };

      for (const cell of cells) if (cell.bounds) punchCell(cell.bounds);
      for (const bounds of pendingBounds) punchCell(bounds);

      if (liveHole) {
        const center = map.latLngToContainerPoint([liveHole.lat, liveHole.lng]);
        const edge = map.latLngToContainerPoint(
          L.latLng(liveHole.lat, liveHole.lng).toBounds(liveHole.radiusM * 2).getNorthEast(),
        );
        const radiusPx = Math.max(Math.abs(edge.x - center.x), 6);
        const gradient = ctx.createRadialGradient(center.x, center.y, 0, center.x, center.y, radiusPx);
        gradient.addColorStop(0, 'rgba(0,0,0,1)');
        gradient.addColorStop(0.7, 'rgba(0,0,0,1)');
        gradient.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(center.x, center.y, radiusPx, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore();
    };
    drawRef.current();
  }, [cells, pendingBounds, liveHole, opacity, visible, map]);

  return null;
}
