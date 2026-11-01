import { useEffect, useState } from "react";

import { describeDelay, punctuality } from "./lib/delay";
import { MODES, type Mode } from "./lib/hfp";
import { DELAY_COLORS, MODE_COLORS, type ColorBy } from "./lib/map";
import type { ConnectionStatus } from "./lib/mqtt";
import type { Stats, Vehicle } from "./lib/vehicles";

export const MODE_LABELS: Record<Mode, string> = {
  bus: "Bus",
  tram: "Tram",
  metro: "Metro",
  train: "Train",
  ferry: "Ferry",
};

const STATUS_TEXT: Record<ConnectionStatus, string> = {
  connecting: "Connecting",
  live: "Live",
  reconnecting: "Reconnecting",
  paused: "Paused",
};

const number = new Intl.NumberFormat("en-GB");

function HelsinkiClock() {
  const [time, setTime] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <span className="tabular-nums">
      {time.toLocaleTimeString("en-GB", { timeZone: "Europe/Helsinki", hour12: false })}
    </span>
  );
}

export function Brand({ status, compact }: { status: ConnectionStatus; compact: boolean }) {
  const live = status === "live";
  return (
    <div>
      <h1 className={`font-display font-extrabold leading-[0.9] tracking-[-0.04em] ${compact ? "text-[26px]" : "text-[40px]"}`}>
        Helsinki
        <br />
        Live
      </h1>
      <div className="mt-3 flex items-center gap-3 font-mono text-[11.5px] text-ash">
        <span className={`flex items-center gap-2 ${live ? "text-mint" : "text-amber"}`}>
          <span className="live-dot" data-live={live} aria-hidden />
          {STATUS_TEXT[status]}
        </span>
        <span className="text-dim">/</span>
        <HelsinkiClock />
      </div>
    </div>
  );
}

export function TopLinks({ onAbout }: { onAbout: () => void }) {
  return (
    <nav className="flex items-center gap-2">
      <button type="button" onClick={onAbout} className="chip bg-void/60 backdrop-blur-md" aria-pressed="true">
        How it works
      </button>
      <a href="https://magnus.is-a.dev/" className="chip hidden bg-void/60 backdrop-blur-md sm:inline-flex" aria-pressed="true">
        Magnus Kaur <span aria-hidden>↗</span>
      </a>
    </nav>
  );
}

export function Counter({ total }: { total: number }) {
  return (
    <div>
      <p className="font-display text-[44px] font-semibold leading-none tracking-[-0.04em] tabular-nums">
        {number.format(total)}
      </p>
      <p className="mt-2 text-[13px] text-ash">vehicles reporting right now</p>
    </div>
  );
}

export function ModeChips({
  modes,
  counts,
  onToggle,
}: {
  modes: Set<Mode>;
  counts: Record<Mode, number>;
  onToggle: (mode: Mode) => void;
}) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] md:flex-wrap md:overflow-visible">
      {MODES.map((mode) => (
        <button key={mode} type="button" className="chip" aria-pressed={modes.has(mode)} onClick={() => onToggle(mode)}>
          <span className="size-2 rounded-full" style={{ background: MODE_COLORS[mode] }} aria-hidden />
          {MODE_LABELS[mode]}
          <span className="font-mono text-[11px] text-ash tabular-nums">{modes.has(mode) ? counts[mode] : "off"}</span>
        </button>
      ))}
    </div>
  );
}

const LEGEND: { key: keyof typeof DELAY_COLORS; label: string }[] = [
  { key: "onTime", label: "On time" },
  { key: "late", label: "1–3 min late" },
  { key: "veryLate", label: "3+ min late" },
  { key: "early", label: "Early" },
  { key: "unknown", label: "No timetable" },
];

export function ColorToggle({ colorBy, onChange }: { colorBy: ColorBy; onChange: (value: ColorBy) => void }) {
  return (
    <div>
      <div className="inline-flex rounded-full border border-line p-1 text-[13px]" role="radiogroup" aria-label="Colour vehicles by">
        {(["mode", "delay"] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={colorBy === value}
            onClick={() => onChange(value)}
            className={`rounded-full px-3.5 py-1.5 transition-colors duration-200 ${colorBy === value ? "bg-bone text-void" : "text-ash hover:text-bone"}`}
          >
            {value === "mode" ? "By mode" : "By delay"}
          </button>
        ))}
      </div>
      {colorBy === "delay" && (
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[12px] text-ash">
          {LEGEND.map((item) => (
            <li key={item.key} className="flex items-center gap-1.5">
              <span className="size-2 rounded-full" style={{ background: DELAY_COLORS[item.key] }} aria-hidden />
              {item.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function LineSearch({
  query,
  matches,
  onChange,
  onSubmit,
}: {
  query: string;
  matches: number;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <label className="flex h-10 items-center gap-2 rounded-full border border-line bg-void/40 px-4 focus-within:border-bone/40">
        <span className="font-mono text-[11px] text-dim">Line</span>
        <input
          value={query}
          onChange={(event) => onChange(event.target.value)}
          placeholder="e.g. 4, 550, M1"
          inputMode="search"
          className="w-full bg-transparent text-[14px] text-bone outline-none placeholder:text-dim"
          aria-label="Find a line"
        />
        {query && (
          <span className="shrink-0 font-mono text-[11px] text-ash tabular-nums">
            {matches} {matches === 1 ? "vehicle" : "vehicles"}
          </span>
        )}
      </label>
    </form>
  );
}

function Sparkline({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  const width = 160;
  const height = 34;
  const step = width / 60;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden className="block">
      {values.map((value, index) => {
        const h = Math.max(1, (value / max) * height);
        return (
          <rect
            key={index}
            x={width - (values.length - index) * step}
            y={height - h}
            width={step - 1}
            height={h}
            rx={0.5}
            fill={index === values.length - 1 ? "#46e39b" : "rgb(239 237 232 / 0.22)"}
          />
        );
      })}
    </svg>
  );
}

export function StatsPanel({ stats, rates }: { stats: Stats; rates: number[] }) {
  const latest = rates.at(-1) ?? 0;
  const late = stats.averageSecondsLate;
  return (
    <div className="panel flex items-end gap-6 px-5 py-4">
      <div>
        <p className="font-mono text-[11px] text-dim">Updates / second</p>
        <p className="mt-1 font-display text-[22px] font-semibold tabular-nums">{number.format(latest)}</p>
        <div className="mt-2">
          <Sparkline values={rates} />
        </div>
      </div>
      <dl className="grid gap-3 text-[13px]">
        <div>
          <dt className="font-mono text-[11px] text-dim">On time</dt>
          <dd className="mt-0.5 text-[18px] font-medium tabular-nums">
            {stats.onTimeShare === null ? "–" : `${Math.round(stats.onTimeShare * 100)}%`}
          </dd>
        </div>
        <div>
          <dt className="font-mono text-[11px] text-dim">On average</dt>
          <dd className="mt-0.5 text-[18px] font-medium tabular-nums">
            {late === null ? "–" : `${Math.round(Math.abs(late))} s ${late >= 0 ? "late" : "early"}`}
          </dd>
        </div>
      </dl>
    </div>
  );
}

export function VehicleCard({
  vehicle,
  following,
  onFollow,
  onClose,
}: {
  vehicle: Vehicle;
  following: boolean;
  onFollow: () => void;
  onClose: () => void;
}) {
  const state = punctuality(vehicle.secondsLate);
  return (
    <div className="panel w-full p-5 md:w-[340px]" role="dialog" aria-label={`${MODE_LABELS[vehicle.mode]} ${vehicle.line}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span
            className="grid h-11 min-w-11 place-items-center rounded-[14px] px-2 font-display text-[17px] font-semibold text-void"
            style={{ background: MODE_COLORS[vehicle.mode] }}
          >
            {vehicle.line}
          </span>
          <div>
            <p className="font-mono text-[11px] text-ash">{MODE_LABELS[vehicle.mode]}</p>
            <p className="text-[16px] font-medium leading-tight">{vehicle.headsign || "Not in service"}</p>
          </div>
        </div>
        <button type="button" onClick={onClose} className="grid size-8 place-items-center rounded-full text-ash hover:bg-white/5 hover:text-bone" aria-label="Close">
          ✕
        </button>
      </div>

      <dl className="mt-5 grid grid-cols-3 gap-3">
        <div>
          <dt className="font-mono text-[11px] text-dim">Speed</dt>
          <dd className="mt-1 text-[17px] font-medium tabular-nums">{Math.round(vehicle.speed * 3.6)} km/h</dd>
        </div>
        <div>
          <dt className="font-mono text-[11px] text-dim">Heading</dt>
          <dd className="mt-1 flex items-center gap-1.5 text-[17px] font-medium tabular-nums">
            <span className="inline-block transition-transform duration-500" style={{ transform: `rotate(${vehicle.heading}deg)` }} aria-hidden>
              ↑
            </span>
            {Math.round(vehicle.heading)}°
          </dd>
        </div>
        <div>
          <dt className="font-mono text-[11px] text-dim">Schedule</dt>
          <dd className="mt-1 text-[15px] font-medium leading-tight" style={{ color: DELAY_COLORS[state] }}>
            {describeDelay(vehicle.secondsLate)}
          </dd>
        </div>
      </dl>

      <button
        type="button"
        onClick={onFollow}
        aria-pressed={following}
        className={`mt-5 h-10 w-full rounded-full text-[14px] font-medium transition-colors duration-200 ${following ? "bg-bone text-void" : "border border-line text-bone hover:border-bone/40"}`}
      >
        {following ? "Following" : "Follow this vehicle"}
      </button>
    </div>
  );
}

export function About({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-void/70 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-title"
        className="panel max-h-[85dvh] w-full max-w-[560px] overflow-y-auto p-7"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <h2 id="about-title" className="font-display text-[24px] font-semibold tracking-[-0.03em]">
            How it works
          </h2>
          <button type="button" onClick={onClose} className="grid size-8 place-items-center rounded-full text-ash hover:bg-white/5 hover:text-bone" aria-label="Close">
            ✕
          </button>
        </div>
        <div className="mt-5 space-y-4 text-[15px] leading-relaxed text-bone/85">
          <p>
            Every HSL bus, tram, metro, train and ferry reports its position about once a second. This page listens to
            all of them at once: often more than 800 messages a second.
          </p>
          <p>
            <strong className="text-bone">Straight from the source.</strong> HSL publishes the positions over MQTT. Your
            browser connects to their broker over a WebSocket using a small MQTT client written for this page (about
            200 lines, no library), with a stream parser that handles messages split across network frames.
          </p>
          <p>
            <strong className="text-bone">Smooth, not jumpy.</strong> Each vehicle glides from where it is on screen to
            its new fix. GPS jumps snap instead of sliding across town, and vehicles that stop reporting disappear after
            45 seconds.
          </p>
          <p>
            <strong className="text-bone">Easy on your data.</strong> Switching a mode off unsubscribes from it at the
            broker. The feed pauses when the tab is hidden or after five idle minutes, and phones start without buses,
            the busiest mode.
          </p>
          <p>
            <strong className="text-bone">Drawn on the GPU.</strong> The map and the vehicles render with WebGL through
            MapLibre, on an OpenStreetMap base with real building heights.
          </p>
          <p className="text-[13px] text-ash">
            Vehicle data: Helsinki Region Transport (HSL), CC BY 4.0. Map: © OpenStreetMap contributors, OpenFreeMap.
            Built by Magnus Kaur with TypeScript, React, Vite and MapLibre; the parser and data logic are covered by
            unit tests.
          </p>
        </div>
        <div className="mt-6 flex flex-wrap gap-2">
          <a href="https://github.com/mgndxb/helsinki-live" className="chip" aria-pressed="true">
            Source on GitHub <span aria-hidden>↗</span>
          </a>
          <a href="https://magnus.is-a.dev/" className="chip" aria-pressed="true">
            Portfolio <span aria-hidden>↗</span>
          </a>
        </div>
      </div>
    </div>
  );
}

export function PausedOverlay({ onResume }: { onResume: () => void }) {
  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-void/60 p-4 backdrop-blur-sm">
      <div className="panel max-w-[360px] p-7 text-center">
        <p className="font-display text-[20px] font-semibold">Paused to save data</p>
        <p className="mt-2 text-[14px] text-ash">The live feed stops after five quiet minutes.</p>
        <button type="button" onClick={onResume} className="mt-5 h-11 w-full rounded-full bg-bone text-[14px] font-medium text-void">
          Resume live
        </button>
      </div>
    </div>
  );
}
