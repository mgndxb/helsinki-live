import type { Feature, Point } from "geojson";
import { AttributionControl, Map as MapLibreMap, setWorkerUrl, type GeoJSONSource } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";

import { punctuality, type Punctuality } from "./delay";
import type { Mode } from "./hfp";
import { positionAt, type Vehicle } from "./vehicles";

export type ColorBy = "mode" | "delay";

/** HSL's own colour per mode, lifted for a dark map. */
export const MODE_COLORS: Record<Mode, string> = {
  bus: "#4aa3ff",
  tram: "#46e39b",
  metro: "#ff7a33",
  train: "#b48cff",
  ferry: "#3fd6e8",
};

export const DELAY_COLORS: Record<Punctuality, string> = {
  early: "#4aa3ff",
  onTime: "#46e39b",
  late: "#ffbe55",
  veryLate: "#ff5a4a",
  unknown: "#8a8984",
};

// MapLibre finds its worker relative to its own file, which breaks once bundled; point it at the bundled copy.
setWorkerUrl(workerUrl);

export const HELSINKI: [number, number] = [24.9384, 60.1699];

const FONT = ["Noto Sans Regular"];

export function createMap(container: HTMLElement, compact: boolean): MapLibreMap {
  const map = new MapLibreMap({
    container,
    style: "https://tiles.openfreemap.org/styles/dark",
    center: HELSINKI,
    zoom: compact ? 12 : 13.1,
    pitch: compact ? 45 : 58,
    bearing: -17,
    maxPitch: 70,
    attributionControl: false,
    fadeDuration: 0,
  });
  map.addControl(new AttributionControl({ compact: true }), "bottom-right");

  map.on("load", () => {
    // MapLibre opens compact credits at first; on a phone that line would cover the header, so start folded.
    if (compact) map.getContainer().querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");
    // Swap the flat footprints for extruded buildings, lit just enough to read the city.
    if (map.getLayer("building")) map.setLayoutProperty("building", "visibility", "none");
    const firstLabel = map.getStyle().layers.find((layer) => layer.type === "symbol")?.id;
    map.addLayer(
      {
        id: "buildings-3d",
        type: "fill-extrusion",
        source: "openmaptiles",
        "source-layer": "building",
        minzoom: 12,
        paint: {
          "fill-extrusion-color": [
            "interpolate",
            ["linear"],
            ["coalesce", ["get", "render_height"], 0],
            0,
            "#111114",
            40,
            "#1b1b21",
            120,
            "#26262e",
          ],
          "fill-extrusion-height": ["coalesce", ["get", "render_height"], 0],
          "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
          "fill-extrusion-opacity": ["interpolate", ["linear"], ["zoom"], 11.5, 0, 12.8, 0.92],
        },
      },
      firstLabel,
    );

    map.setSky({ "sky-color": "#060607", "horizon-color": "#101016", "fog-color": "#060607", "sky-horizon-blend": 0.6, "horizon-fog-blend": 0.4, "fog-ground-blend": 0.2 });

    map.addSource("vehicles", { type: "geojson", data: { type: "FeatureCollection", features: [] }, promoteId: "id" });

    map.addLayer({
      id: "vehicle-glow",
      type: "circle",
      source: "vehicles",
      paint: {
        "circle-color": ["get", "color"],
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 6, 13, 14, 17, 30],
        "circle-blur": 1,
        "circle-opacity": ["case", ["get", "dim"], 0.04, 0.5],
        "circle-pitch-alignment": "map",
      },
    });
    map.addLayer({
      id: "vehicle-dot",
      type: "circle",
      source: "vehicles",
      paint: {
        "circle-color": ["get", "color"],
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 2.2, 13, 4.6, 17, 9],
        "circle-opacity": ["case", ["get", "dim"], 0.18, 1],
        "circle-pitch-alignment": "map",
      },
    });
    map.addLayer({
      id: "vehicle-selected",
      type: "circle",
      source: "vehicles",
      filter: ["==", ["get", "id"], ""],
      paint: {
        "circle-color": "rgba(0,0,0,0)",
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 8, 13, 13, 17, 22],
        "circle-stroke-color": "#efede8",
        "circle-stroke-width": 2,
        "circle-pitch-alignment": "map",
      },
    });
    map.addLayer({
      id: "vehicle-label",
      type: "symbol",
      source: "vehicles",
      minzoom: 14.5,
      filter: ["!", ["get", "dim"]],
      layout: {
        "text-field": ["get", "line"],
        "text-font": FONT,
        "text-size": 11,
        "text-offset": [0, -1.4],
        "text-allow-overlap": false,
      },
      paint: { "text-color": "#efede8", "text-halo-color": "#060607", "text-halo-width": 1.4 },
    });
    // A bigger invisible target, so vehicles are easy to tap on a phone.
    map.addLayer({
      id: "vehicle-hit",
      type: "circle",
      source: "vehicles",
      paint: { "circle-radius": 14, "circle-opacity": 0 },
    });
  });

  return map;
}

export function selectOnMap(map: MapLibreMap, id: string | null) {
  if (map.getLayer("vehicle-selected")) map.setFilter("vehicle-selected", ["==", ["get", "id"], id ?? ""]);
}

export interface RenderOptions {
  colorBy: ColorBy;
  /** Lines to highlight; everything else is dimmed. Empty means no filter. */
  lines: Set<string>;
}

export function renderVehicles(map: MapLibreMap, vehicles: Iterable<Vehicle>, now: number, options: RenderOptions) {
  const source = map.getSource("vehicles") as GeoJSONSource | undefined;
  if (!source) return;
  const features: Feature<Point>[] = [];
  for (const vehicle of vehicles) {
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: positionAt(vehicle, now) },
      properties: {
        id: vehicle.id,
        line: vehicle.line,
        color:
          options.colorBy === "mode" ? MODE_COLORS[vehicle.mode] : DELAY_COLORS[punctuality(vehicle.secondsLate)],
        dim: options.lines.size > 0 && !options.lines.has(vehicle.line.toLowerCase()),
      },
    });
  }
  source.setData({ type: "FeatureCollection", features });
}
