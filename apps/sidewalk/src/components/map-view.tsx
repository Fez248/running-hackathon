'use client';

import { useEffect } from 'react';
import {
  CircleMarker,
  MapContainer,
  Polyline,
  Popup,
  TileLayer,
  useMap,
  useMapEvents,
} from 'react-leaflet';
import {
  OBSTACLE_LABELS,
  type Coordinate,
  type FogBounds,
  type ObstacleKind,
  type Passability,
} from '@sidewalk/core';
import { FogLayer, type FogCell } from './fog-layer';
import type { Selection, Viewport } from './map-workspace';

const COLORS: Record<Passability, string> = {
  PASSABLE: '#4ade80',
  DIFFICULT: '#fbbf24',
  IMPASSABLE: '#f87171',
  UNKNOWN: '#99a3b3',
};

export interface MapReport {
  id: string;
  lat: number;
  lng: number;
  kind: string;
  note: string | null;
  confidence: number;
  source?: string;
  effectivePassability: Passability;
}

interface MapViewProps {
  center: { lat: number; lng: number };
  reports: MapReport[];
  selection: Selection | null;
  onPick: (coord: { lat: number; lng: number }) => void;
  onViewportChange: (viewport: Viewport) => void;
  fog: {
    enabled: boolean;
    cells: FogCell[];
    pendingBounds: FogBounds[];
    liveHole: { lat: number; lng: number; radiusM: number } | null;
  };
  runPath: Coordinate[];
  livePosition: (Coordinate & { accuracyM: number | null }) | null;
  follow: boolean;
}

function MapEvents({
  onPick,
  onViewportChange,
}: Pick<MapViewProps, 'onPick' | 'onViewportChange'>) {
  const map = useMapEvents({
    click(event) {
      onPick({ lat: event.latlng.lat, lng: event.latlng.lng });
    },
    moveend() {
      const bounds = map.getBounds();
      onViewportChange({
        minLat: bounds.getSouth(),
        maxLat: bounds.getNorth(),
        minLng: bounds.getWest(),
        maxLng: bounds.getEast(),
      });
    },
  });
  return null;
}

/** Keeps the runner in view while a run is active. */
function FollowPosition({
  position,
  follow,
}: {
  position: Coordinate | null;
  follow: boolean;
}) {
  const map = useMap();
  useEffect(() => {
    if (!follow || !position) return;
    map.panTo([position.lat, position.lng], { animate: true });
  }, [follow, position, map]);
  return null;
}

export function MapView({
  center,
  reports,
  selection,
  onPick,
  onViewportChange,
  fog,
  runPath,
  livePosition,
  follow,
}: MapViewProps) {
  return (
    <div className="map-wrap">
      <MapContainer center={[center.lat, center.lng]} zoom={16} scrollWheelZoom>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <MapEvents onPick={onPick} onViewportChange={onViewportChange} />
        <FollowPosition position={livePosition} follow={follow} />

        <FogLayer
          cells={fog.cells}
          pendingBounds={fog.pendingBounds}
          liveHole={fog.liveHole}
          opacity={0.82}
          visible={fog.enabled}
        />

        {runPath.length > 1 ? (
          <Polyline
            positions={runPath.map((point) => [point.lat, point.lng])}
            pathOptions={{ color: '#38bdf8', weight: 4, opacity: 0.9 }}
          />
        ) : null}

        {reports.map((report) => (
          <CircleMarker
            key={report.id}
            center={[report.lat, report.lng]}
            radius={report.source === 'VOICE' ? 9 : 7}
            pathOptions={{
              color: COLORS[report.effectivePassability],
              fillColor: COLORS[report.effectivePassability],
              fillOpacity: 0.6,
              dashArray: report.source === 'VOICE' ? '3' : undefined,
            }}
          >
            <Popup>
              <strong>{OBSTACLE_LABELS[report.kind as ObstacleKind] ?? report.kind}</strong>
              <br />
              {report.effectivePassability.toLowerCase()} · {(report.confidence * 100).toFixed(0)}%
              confidence
              {report.source === 'VOICE' ? ' · dictated' : ''}
              {report.note ? (
                <>
                  <br />
                  {report.note}
                </>
              ) : null}
            </Popup>
          </CircleMarker>
        ))}

        {livePosition ? (
          <CircleMarker
            center={[livePosition.lat, livePosition.lng]}
            radius={8}
            pathOptions={{ color: '#38bdf8', fillColor: '#38bdf8', fillOpacity: 0.9 }}
          />
        ) : null}

        {selection ? (
          <CircleMarker
            center={[selection.lat, selection.lng]}
            radius={10}
            pathOptions={{ color: '#60a5fa', dashArray: '4' }}
          />
        ) : null}
      </MapContainer>
    </div>
  );
}
