'use client';

import { CircleMarker, MapContainer, Popup, TileLayer, useMapEvents } from 'react-leaflet';
import { OBSTACLE_LABELS, type ObstacleKind, type Passability } from '@sidewalk/core';
import type { Viewport } from './map-workspace';

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
  effectivePassability: Passability;
}

interface MapViewProps {
  center: { lat: number; lng: number };
  reports: MapReport[];
  pin: { lat: number; lng: number } | null;
  onPick: (coord: { lat: number; lng: number }) => void;
  onViewportChange: (viewport: Viewport) => void;
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

export function MapView({ center, reports, pin, onPick, onViewportChange }: MapViewProps) {
  return (
    <div className="map-wrap">
      <MapContainer center={[center.lat, center.lng]} zoom={16} scrollWheelZoom>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <MapEvents onPick={onPick} onViewportChange={onViewportChange} />

        {reports.map((report) => (
          <CircleMarker
            key={report.id}
            center={[report.lat, report.lng]}
            radius={7}
            pathOptions={{
              color: COLORS[report.effectivePassability],
              fillColor: COLORS[report.effectivePassability],
              fillOpacity: 0.6,
            }}
          >
            <Popup>
              <strong>{OBSTACLE_LABELS[report.kind as ObstacleKind] ?? report.kind}</strong>
              <br />
              {report.effectivePassability.toLowerCase()} · {(report.confidence * 100).toFixed(0)}%
              confidence
              {report.note ? (
                <>
                  <br />
                  {report.note}
                </>
              ) : null}
            </Popup>
          </CircleMarker>
        ))}

        {pin ? (
          <CircleMarker
            center={[pin.lat, pin.lng]}
            radius={10}
            pathOptions={{ color: '#60a5fa', dashArray: '4' }}
          />
        ) : null}
      </MapContainer>
    </div>
  );
}
