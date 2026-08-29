'use client';

import { useCallback, useEffect } from 'react';
import { DomEvent, divIcon, type Map as LeafletMap } from 'leaflet';
import {
  CircleMarker,
  MapContainer,
  Marker,
  Polyline,
  Popup,
  TileLayer,
  useMap,
  useMapEvents,
} from 'react-leaflet';
import {
  OBSTACLE_LABELS,
  captureVerdictLabel,
  clampBounds,
  isSensorReport,
  reportProvenanceLine,
  reportSourceMark,
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

/**
 * A measured report is drawn as a diamond, a human's as a circle: shape, not
 * colour, carries the distinction, and the popup repeats it in words. Colour
 * stays reserved for passability, which is what it means everywhere else.
 */
function sensorIcon(color: string) {
  const mark = reportSourceMark('SENSOR');
  return divIcon({
    className: 'sensor-marker',
    html: `<span class="sensor-marker__glyph" style="color:${color}" aria-hidden="true">${mark.glyph}</span>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

export interface MapReport {
  id: string;
  lat: number;
  lng: number;
  kind: string;
  note: string | null;
  confidence: number;
  source?: string;
  /** ok | degraded | unusable of the capture behind a SENSOR report. */
  captureVerdict?: string | null;
  effectivePassability: Passability;
}

/** Popup body, identical for both marker shapes. */
function ReportPopup({ report }: { report: MapReport }) {
  const mark = reportSourceMark(report.source);
  return (
    <Popup>
      <strong>{OBSTACLE_LABELS[report.kind as ObstacleKind] ?? report.kind}</strong>
      <br />
      {report.effectivePassability.toLowerCase()} · {(report.confidence * 100).toFixed(0)}%
      confidence
      <br />
      <span className="source-tag" data-source={mark.source}>
        <span aria-hidden="true">{mark.glyph}</span> {reportProvenanceLine(report)}
      </span>
      {isSensorReport(report.source) && report.captureVerdict ? (
        <>
          <br />
          <span className="muted">
            capture verdict: {captureVerdictLabel(report.captureVerdict)}
          </span>
        </>
      ) : null}
      {report.note ? (
        <>
          <br />
          {report.note}
        </>
      ) : null}
    </Popup>
  );
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
  const emit = useCallback(
    (instance: LeafletMap) => {
      const bounds = instance.getBounds();
      onViewportChange(
        clampBounds({
          minLat: bounds.getSouth(),
          maxLat: bounds.getNorth(),
          minLng: bounds.getWest(),
          maxLng: bounds.getEast(),
        }),
      );
    },
    [onViewportChange],
  );

  const map = useMapEvents({
    click(event) {
      // A tap after panning past the antimeridian must still be a longitude
      // inside ±180.
      const point = event.latlng.wrap();
      onPick({ lat: Math.min(90, Math.max(-90, point.lat)), lng: point.lng });
    },
    moveend() {
      emit(map);
    },
    zoomend() {
      emit(map);
    },
    resize() {
      emit(map);
    },
  });

  // The initial bounds depend on the rendered container size, so the first
  // query has to use them instead of the placeholder viewport.
  useEffect(() => {
    emit(map);
  }, [emit, map]);

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

        {reports.map((report) =>
          isSensorReport(report.source) ? (
            <Marker
              key={report.id}
              position={[report.lat, report.lng]}
              icon={sensorIcon(COLORS[report.effectivePassability])}
              alt={`${OBSTACLE_LABELS[report.kind as ObstacleKind] ?? report.kind}, ${reportSourceMark(report.source).ariaLabel}`}
              eventHandlers={{
                click: (event) => DomEvent.stopPropagation(event.originalEvent),
              }}
            >
              <ReportPopup report={report} />
            </Marker>
          ) : (
            <CircleMarker
              key={report.id}
              center={[report.lat, report.lng]}
              radius={report.source && report.source !== 'MANUAL' ? 9 : 7}
              pathOptions={{
                color: COLORS[report.effectivePassability],
                fillColor: COLORS[report.effectivePassability],
                fillOpacity: 0.6,
                dashArray: reportSourceMark(report.source).dashArray,
              }}
              eventHandlers={{
                // Opening a popup must not also move the report pin.
                click: (event) => DomEvent.stopPropagation(event.originalEvent),
              }}
            >
              <ReportPopup report={report} />
            </CircleMarker>
          ),
        )}

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
