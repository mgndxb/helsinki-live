import { punctuality } from "./delay";
import { MODES, type Mode, type VehicleUpdate } from "./hfp";

/**
 * Positions arrive about once a second. Drawing them as they come makes
 * vehicles jump, so each one glides from where it is on screen to the new fix.
 */
export interface Vehicle extends VehicleUpdate {
  from: [number, number];
  to: [number, number];
  movedAt: number;
  seenAt: number;
}

const GLIDE_MS = 1_000;
/** A jump longer than this is a GPS glitch or a new journey: snap instead of gliding across town. */
const SNAP_METRES = 800;
/** Vehicles that stop reporting (end of shift, tunnel) disappear after this. */
const STALE_MS = 45_000;

export function metresBetween([lon1, lat1]: [number, number], [lon2, lat2]: [number, number]): number {
  const toRad = Math.PI / 180;
  const x = (lon2 - lon1) * toRad * Math.cos(((lat1 + lat2) / 2) * toRad);
  const y = (lat2 - lat1) * toRad;
  return Math.hypot(x, y) * 6_371_000;
}

export function positionAt(vehicle: Vehicle, now: number): [number, number] {
  const t = Math.min(1, Math.max(0, (now - vehicle.movedAt) / GLIDE_MS));
  const eased = 1 - (1 - t) * (1 - t);
  return [
    vehicle.from[0] + (vehicle.to[0] - vehicle.from[0]) * eased,
    vehicle.from[1] + (vehicle.to[1] - vehicle.from[1]) * eased,
  ];
}

export interface Stats {
  total: number;
  byMode: Record<Mode, number>;
  /** Share of vehicles with timetable data that are within a minute of schedule. */
  onTimeShare: number | null;
  averageSecondsLate: number | null;
}

export class VehicleStore {
  readonly vehicles = new Map<string, Vehicle>();

  upsert(update: VehicleUpdate, now: number) {
    const target: [number, number] = [update.lon, update.lat];
    const existing = this.vehicles.get(update.id);
    if (!existing) {
      this.vehicles.set(update.id, { ...update, from: target, to: target, movedAt: now, seenAt: now });
      return;
    }
    const current = positionAt(existing, now);
    const snap = metresBetween(current, target) > SNAP_METRES;
    Object.assign(existing, update, { from: snap ? target : current, to: target, movedAt: now, seenAt: now });
  }

  prune(now: number) {
    for (const [id, vehicle] of this.vehicles) {
      if (now - vehicle.seenAt > STALE_MS) this.vehicles.delete(id);
    }
  }

  /** Drops vehicles of modes the visitor switched off, so they vanish at once. */
  keepModes(modes: Set<Mode>) {
    for (const [id, vehicle] of this.vehicles) {
      if (!modes.has(vehicle.mode)) this.vehicles.delete(id);
    }
  }

  stats(): Stats {
    const byMode = Object.fromEntries(MODES.map((mode) => [mode, 0])) as Record<Mode, number>;
    let timed = 0;
    let onTime = 0;
    let lateSum = 0;
    for (const vehicle of this.vehicles.values()) {
      byMode[vehicle.mode] += 1;
      if (vehicle.secondsLate === null) continue;
      timed += 1;
      lateSum += vehicle.secondsLate;
      if (punctuality(vehicle.secondsLate) === "onTime") onTime += 1;
    }
    return {
      total: this.vehicles.size,
      byMode,
      onTimeShare: timed ? onTime / timed : null,
      averageSecondsLate: timed ? lateSum / timed : null,
    };
  }
}

/** Messages per second over the last minute, for the live sparkline. */
export class RateMeter {
  private buckets: number[] = [];
  private current = 0;

  count() {
    this.current += 1;
  }

  /** Call once a second. */
  tick(): number[] {
    this.buckets.push(this.current);
    this.current = 0;
    if (this.buckets.length > 60) this.buckets.shift();
    return [...this.buckets];
  }
}
