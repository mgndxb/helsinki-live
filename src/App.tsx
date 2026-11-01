import { LngLatBounds, type Map as MapLibreMap } from "maplibre-gl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  About,
  Brand,
  ColorToggle,
  Counter,
  LineSearch,
  ModeChips,
  PausedOverlay,
  StatsPanel,
  TopLinks,
  VehicleCard,
} from "./components";
import { MODES, parseVehicle, topicsFor, type Mode } from "./lib/hfp";
import { createMap, renderVehicles, selectOnMap, type ColorBy } from "./lib/map";
import { MqttClient, type ConnectionStatus } from "./lib/mqtt";
import { positionAt, RateMeter, VehicleStore, type Stats, type Vehicle } from "./lib/vehicles";
import { sound } from "./lib/sound";
import { SoundEffects } from "./sound";

const BROKER = "wss://mqtt.hsl.fi:443/";
const COMPACT = window.matchMedia("(max-width: 767px)").matches;
const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
/** Phones start without buses: they are over half the traffic. */
const DEFAULT_MODES: Mode[] = COMPACT ? ["tram", "metro", "train", "ferry"] : [...MODES];
const FRAME_MS = 50;
const IDLE_PAUSE_MS = 5 * 60_000;
const DRIFT_AFTER_MS = 15_000;

function linesFrom(query: string): Set<string> {
  return new Set(
    query
      .split(/[\s,]+/)
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function App() {
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const store = useMemo(() => new VehicleStore(), []);
  const meter = useMemo(() => new RateMeter(), []);
  const clientRef = useRef<MqttClient | null>(null);

  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [stats, setStats] = useState<Stats>(() => store.stats());
  const [rates, setRates] = useState<number[]>([]);
  const [modes, setModes] = useState<Set<Mode>>(() => new Set(DEFAULT_MODES));
  const [colorBy, setColorBy] = useState<ColorBy>("mode");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Vehicle | null>(null);
  const [following, setFollowing] = useState(false);
  const [idlePaused, setIdlePaused] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);

  const lines = useMemo(() => linesFrom(query), [query]);

  // The render loop reads the latest settings through refs, so it never restarts.
  const live = useRef({ colorBy, lines, modes, selectedId, following, lastInteraction: performance.now(), easingUntil: 0 });
  live.current.colorBy = colorBy;
  live.current.lines = lines;
  live.current.modes = modes;
  live.current.selectedId = selectedId;
  live.current.following = following;

  const touch = useCallback(() => {
    live.current.lastInteraction = performance.now();
  }, []);

  // Map
  useEffect(() => {
    const map = createMap(mapEl.current!, COMPACT);
    mapRef.current = map;
    // Dev only: lets automated browser checks find vehicles on the map.
    if (import.meta.env.DEV) (window as unknown as { map: MapLibreMap }).map = map;

    const select = (id: string | null) => {
      if (id) sound.select();
      setSelectedId(id);
      setFollowing(id !== null);
    };
    map.on("click", "vehicle-hit", (event) => {
      const id = event.features?.[0]?.properties?.id as string | undefined;
      if (!id) return;
      event.preventDefault();
      select(id);
      const vehicle = store.vehicles.get(id);
      if (vehicle && map.getZoom() < 14.5) {
        live.current.easingUntil = performance.now() + 1_400;
        map.easeTo({ center: positionAt(vehicle, performance.now()), zoom: 15.2, pitch: 58, duration: 1_400 });
      }
    });
    map.on("click", (event) => {
      if (!event.defaultPrevented) select(null);
    });
    map.on("mouseenter", "vehicle-hit", () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", "vehicle-hit", () => (map.getCanvas().style.cursor = ""));
    // Dragging the map means the visitor wants control back.
    map.on("dragstart", () => setFollowing(false));

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [store]);

  // Live feed
  useEffect(() => {
    const client = new MqttClient(BROKER, {
      onMessage: (topic, payload) => {
        meter.count();
        const update = parseVehicle(topic, payload);
        if (update && live.current.modes.has(update.mode)) store.upsert(update, performance.now());
      },
      onStatus: setStatus,
    });
    clientRef.current = client;
    client.setFilters(topicsFor(live.current.modes));
    client.start();

    const onVisibility = () => {
      if (document.hidden) client.stop();
      else if (!document.hidden) client.start();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      client.stop();
      clientRef.current = null;
    };
  }, [meter, store]);

  useEffect(() => {
    clientRef.current?.setFilters(topicsFor(modes));
    store.keepModes(modes);
  }, [modes, store]);

  // Draw at ~20 fps; the glide makes it look continuous.
  useEffect(() => {
    let frame = 0;
    let lastDraw = 0;
    let lastTick = performance.now();
    const loop = (now: number) => {
      frame = requestAnimationFrame(loop);
      const map = mapRef.current;
      if (!map) return;
      const state = live.current;
      if (now - lastDraw >= FRAME_MS) {
        lastDraw = now;
        renderVehicles(map, store.vehicles.values(), now, { colorBy: state.colorBy, lines: state.lines });
        const followed = state.following && state.selectedId ? store.vehicles.get(state.selectedId) : undefined;
        if (followed && now > state.easingUntil) map.jumpTo({ center: positionAt(followed, now) });
      }
      // A slow drift around the city while nobody is touching it.
      const idle = now - state.lastInteraction > DRIFT_AFTER_MS;
      if (idle && !state.selectedId && !REDUCED_MOTION && !map.isMoving()) {
        map.setBearing(map.getBearing() + (now - lastTick) * 0.0012);
      }
      lastTick = now;
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [store]);

  // Panels refresh twice a second; the map itself is drawn far more often.
  useEffect(() => {
    let tick = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      tick += 1;
      if (tick % 2 === 0) {
        store.prune(now);
        setRates(meter.tick());
      }
      setStats(store.stats());
      const id = live.current.selectedId;
      const vehicle = id ? store.vehicles.get(id) : undefined;
      setSelected(vehicle ? { ...vehicle } : null);
      if (id && !vehicle) setSelectedId(null);
    }, 500);
    return () => clearInterval(timer);
  }, [meter, store]);

  useEffect(() => {
    if (mapRef.current) selectOnMap(mapRef.current, selectedId);
  }, [selectedId]);

  // Pause after five quiet minutes to spare mobile data.
  useEffect(() => {
    const events = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
    events.forEach((name) => window.addEventListener(name, touch, { passive: true }));
    const timer = setInterval(() => {
      if (performance.now() - live.current.lastInteraction > IDLE_PAUSE_MS && !document.hidden) {
        clientRef.current?.stop();
        setIdlePaused(true);
      }
    }, 10_000);
    return () => {
      events.forEach((name) => window.removeEventListener(name, touch));
      clearInterval(timer);
    };
  }, [touch]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !aboutOpen) setSelectedId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [aboutOpen]);

  const toggleMode = (mode: Mode) => {
    setModes((current) => {
      const next = new Set(current);
      if (next.has(mode)) next.delete(mode);
      else next.add(mode);
      return next;
    });
  };

  const matches = useMemo(() => {
    if (!lines.size) return 0;
    let count = 0;
    for (const vehicle of store.vehicles.values()) if (lines.has(vehicle.line.toLowerCase())) count += 1;
    return count;
    // stats changes twice a second, which keeps the count fresh
  }, [lines, store, stats]); // eslint-disable-line react-hooks/exhaustive-deps

  const zoomToMatches = () => {
    const map = mapRef.current;
    if (!map || !lines.size) return;
    const bounds = new LngLatBounds();
    let any = false;
    for (const vehicle of store.vehicles.values()) {
      if (!lines.has(vehicle.line.toLowerCase())) continue;
      bounds.extend(positionAt(vehicle, performance.now()));
      any = true;
    }
    if (any) map.fitBounds(bounds, { padding: COMPACT ? 60 : 160, maxZoom: 15, duration: 1_200 });
  };

  const resume = () => {
    touch();
    setIdlePaused(false);
    clientRef.current?.start();
  };

  return (
    <div className="relative h-dvh w-full">
      <SoundEffects />
      {/* MapLibre's stylesheet sets position: relative on its container, so the sizing lives on a wrapper. */}
      <div className="absolute inset-0">
        <div ref={mapEl} className="h-full w-full" aria-label="Live map of HSL vehicles" />
      </div>
      {/* Fades that keep the panels readable over the map */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-48 bg-gradient-to-b from-void/90 to-transparent" />
      <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-56 bg-gradient-to-t from-void/90 to-transparent" />

      <header className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-4 p-4 md:p-7">
        <div className="pointer-events-auto">
          <Brand status={status} compact={COMPACT} />
        </div>
        <div className="pointer-events-auto">
          <TopLinks onAbout={() => setAboutOpen(true)} />
        </div>
      </header>

      {/* Desktop: controls on the left, stats bottom-left, vehicle bottom-right */}
      <aside className="panel absolute top-[168px] left-7 hidden w-[340px] space-y-5 p-5 md:block">
        <Counter total={stats.total} />
        <ModeChips modes={modes} counts={stats.byMode} onToggle={toggleMode} />
        <LineSearch query={query} matches={matches} onChange={setQuery} onSubmit={zoomToMatches} />
        <ColorToggle colorBy={colorBy} onChange={setColorBy} />
      </aside>

      <div className="absolute bottom-7 left-7 hidden md:block">
        <StatsPanel stats={stats} rates={rates} />
      </div>

      {selected && (
        <div className="absolute right-7 bottom-12 hidden md:block">
          <VehicleCard
            vehicle={selected}
            following={following}
            onFollow={() => setFollowing((value) => !value)}
            onClose={() => setSelectedId(null)}
          />
        </div>
      )}

      {/* Phone: one bottom sheet */}
      <div className="absolute inset-x-3 bottom-3 md:hidden">
        {selected ? (
          <VehicleCard
            vehicle={selected}
            following={following}
            onFollow={() => setFollowing((value) => !value)}
            onClose={() => setSelectedId(null)}
          />
        ) : (
          <div className="panel space-y-4 p-4">
            <div className="flex items-end justify-between">
              <Counter total={stats.total} />
              <p className="pb-1 text-right font-mono text-[11px] text-ash">
                {rates.at(-1) ?? 0} updates/s
                <br />
                {stats.onTimeShare === null ? "" : `${Math.round(stats.onTimeShare * 100)}% on time`}
              </p>
            </div>
            <ModeChips modes={modes} counts={stats.byMode} onToggle={toggleMode} />
            <div className="flex items-center gap-2">
              <div className="flex-1">
                <LineSearch query={query} matches={matches} onChange={setQuery} onSubmit={zoomToMatches} />
              </div>
            </div>
            <ColorToggle colorBy={colorBy} onChange={setColorBy} />
          </div>
        )}
      </div>

      {aboutOpen && <About onClose={() => setAboutOpen(false)} />}
      {idlePaused && <PausedOverlay onResume={resume} />}
    </div>
  );
}
