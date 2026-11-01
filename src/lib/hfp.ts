/**
 * HSL's high-frequency positioning (HFP) feed: every vehicle reports its
 * position about once a second. Docs: https://digitransit.fi/en/developers/apis/5-realtime-api/vehicle-positions/
 *
 * Topic: /hfp/v2/journey/ongoing/vp/<mode>/<operator>/<vehicle>/<route>/<direction>/<headsign>/<start>/<next stop>/...
 */

export const MODES = ["bus", "tram", "metro", "train", "ferry"] as const;
export type Mode = (typeof MODES)[number];

export interface VehicleUpdate {
  id: string;
  mode: Mode;
  line: string;
  headsign: string;
  nextStop: string | null;
  lat: number;
  lon: number;
  heading: number;
  /** Metres per second. */
  speed: number;
  /** Seconds behind schedule; negative means early. Null when HSL doesn't report it (e.g. metro). */
  secondsLate: number | null;
  occupancy: number | null;
}

const decoder = new TextDecoder();

function toMode(raw: string | undefined): Mode | null {
  if (raw === "ubus") return "bus"; // U-lines are regional buses
  return (MODES as readonly string[]).includes(raw ?? "") ? (raw as Mode) : null;
}

/** One topic filter per mode, so switching a mode off stops its traffic at the broker. */
export function topicsFor(modes: Iterable<Mode>): string[] {
  const filters: string[] = [];
  for (const mode of modes) {
    filters.push(`/hfp/v2/journey/ongoing/vp/${mode}/#`);
    if (mode === "bus") filters.push("/hfp/v2/journey/ongoing/vp/ubus/#");
  }
  return filters;
}

interface RawVP {
  desi?: string | null;
  spd?: number | null;
  hdg?: number | null;
  lat?: number | null;
  long?: number | null;
  dl?: number | null;
  occu?: number | null;
}

export function parseVehicle(topic: string, payload: Uint8Array): VehicleUpdate | null {
  const parts = topic.split("/");
  const mode = toMode(parts[6]);
  if (!mode) return null;

  let vp: RawVP | undefined;
  try {
    vp = (JSON.parse(decoder.decode(payload)) as { VP?: RawVP }).VP;
  } catch {
    return null;
  }
  if (!vp || typeof vp.lat !== "number" || typeof vp.long !== "number") return null;

  const nextStop = parts[13];
  return {
    id: `${parts[7]}/${parts[8]}`,
    mode,
    line: vp.desi ?? parts[9] ?? "?",
    headsign: parts[11] ?? "",
    nextStop: nextStop && nextStop !== "EOL" ? nextStop : null,
    lat: vp.lat,
    lon: vp.long,
    heading: vp.hdg ?? 0,
    speed: vp.spd ?? 0,
    // HFP's dl is the offset from the timetable: negative means behind schedule.
    secondsLate: typeof vp.dl === "number" ? -vp.dl : null,
    occupancy: typeof vp.occu === "number" ? vp.occu : null,
  };
}
