import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { toLatLon } from '../osm/overpass';
import type { LatLon } from '../osm/overpass';
import type { Basemap as BasemapKind } from '../store';

// Basemap under the Konva canvas: a non-interactive MapLibre map whose camera
// is slaved to the editor view (Plan v2 spike 1 — Konva-over-MapLibre sync).
// Konva keeps all input; MapLibre only renders tiles.

const STYLES: Record<Exclude<BasemapKind, 'none'>, maplibregl.StyleSpecification> = {
  osm: {
    version: 8,
    sources: {
      osm: {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        attribution: '© OpenStreetMap contributors',
      },
    },
    layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
  },
  sat: {
    version: 8,
    sources: {
      sat: {
        type: 'raster',
        tiles: ['https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}'],
        tileSize: 256,
        attribution: 'Imagery © Google',
      },
    },
    layers: [{ id: 'sat', type: 'raster', source: 'sat' }],
  },
};

interface Props {
  kind: Exclude<BasemapKind, 'none'>;
  origin: LatLon;
  view: { x: number; y: number; scale: number };
  width: number;
  height: number;
}

export function Basemap({ kind, origin, view, width, height }: Props) {
  const divRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const kindRef = useRef<BasemapKind>(kind);

  useEffect(() => {
    const map = new maplibregl.Map({
      container: divRef.current!,
      style: STYLES[kind],
      interactive: false,
      attributionControl: { compact: true },
      renderWorldCopies: false,
      fadeDuration: 0,
    });
    mapRef.current = map;
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__cstMap = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (mapRef.current && kindRef.current !== kind) {
      kindRef.current = kind;
      mapRef.current.setStyle(STYLES[kind]);
    }
  }, [kind]);

  // Camera sync: canvas-center world point → lat/lon; px-per-metre → GL zoom.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || width === 0) return;
    const cx = (width / 2 - view.x) / view.scale;
    const cy = (height / 2 - view.y) / view.scale;
    const center = toLatLon(origin, cx, cy);
    // MapLibre (512px tiles): metres/px = 78271.517 · cos(lat) / 2^zoom
    const zoom = Math.log2(78271.51696 * Math.cos((center.lat * Math.PI) / 180) * view.scale);
    map.jumpTo({ center: [center.lon, center.lat], zoom });
  }, [view, width, height, origin]);

  useEffect(() => {
    mapRef.current?.resize();
  }, [width, height]);

  return <div ref={divRef} className="basemap" />;
}
