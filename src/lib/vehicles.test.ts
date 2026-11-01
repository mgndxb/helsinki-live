import { describe, expect, it } from "vitest";

import { describeDelay, punctuality } from "./delay";
import { parseVehicle, topicsFor, type VehicleUpdate } from "./hfp";
import { metresBetween, positionAt, VehicleStore } from "./vehicles";

const encoder = new TextEncoder();
const TOPIC = "/hfp/v2/journey/ongoing/vp/metro/0050/00307/31M2/1/Mellunmäki/11:36/1020601/3/60;24/19/63/94";

function update(overrides: Partial<VehicleUpdate> = {}): VehicleUpdate {
  return {
    id: "22/1",
    mode: "tram",
    line: "4",
    headsign: "Munkkiniemi",
    nextStop: "1",
    lat: 60.17,
    lon: 24.94,
    heading: 90,
    speed: 8,
    secondsLate: 0,
    occupancy: 0,
    ...overrides,
  };
}

describe("parseVehicle", () => {
  it("reads the real payload shape HSL sends", () => {
    const payload = encoder.encode(
      '{"VP":{"desi":"M2","dir":"1","oper":50,"veh":307,"spd":15.41,"hdg":74,"lat":60.16971055,"long":24.93432554,"dl":-95,"occu":0}}',
    );
    expect(parseVehicle(TOPIC, payload)).toEqual({
      id: "0050/00307",
      mode: "metro",
      line: "M2",
      headsign: "Mellunmäki",
      nextStop: "1020601",
      lat: 60.16971055,
      lon: 24.93432554,
      heading: 74,
      speed: 15.41,
      secondsLate: 95,
      occupancy: 0,
    });
  });

  it("keeps missing timetable data as unknown rather than on time", () => {
    const payload = encoder.encode('{"VP":{"desi":"M2","lat":60.1,"long":24.9,"dl":null}}');
    expect(parseVehicle(TOPIC, payload)?.secondsLate).toBeNull();
  });

  it("ignores vehicles without a GPS fix, broken JSON and unknown modes", () => {
    expect(parseVehicle(TOPIC, encoder.encode('{"VP":{"lat":null,"long":null}}'))).toBeNull();
    expect(parseVehicle(TOPIC, encoder.encode("{nope"))).toBeNull();
    expect(parseVehicle(TOPIC.replace("metro", "robot"), encoder.encode('{"VP":{"lat":1,"long":2}}'))).toBeNull();
  });

  it("treats U-line buses as buses and subscribes to both", () => {
    const payload = encoder.encode('{"VP":{"desi":"731","lat":60.3,"long":25.0}}');
    expect(parseVehicle(TOPIC.replace("metro", "ubus"), payload)?.mode).toBe("bus");
    expect(topicsFor(["bus"])).toEqual(["/hfp/v2/journey/ongoing/vp/bus/#", "/hfp/v2/journey/ongoing/vp/ubus/#"]);
  });
});

describe("punctuality", () => {
  it("allows a minute either way as on time", () => {
    expect(punctuality(null)).toBe("unknown");
    expect(punctuality(-61)).toBe("early");
    expect(punctuality(60)).toBe("onTime");
    expect(punctuality(61)).toBe("late");
    expect(punctuality(181)).toBe("veryLate");
    expect(describeDelay(150)).toBe("3 min late");
    expect(describeDelay(-120)).toBe("2 min early");
    expect(describeDelay(30)).toBe("On time");
  });
});

describe("VehicleStore", () => {
  it("glides from the current on-screen position to each new fix", () => {
    const store = new VehicleStore();
    store.upsert(update({ lon: 24.94 }), 0);
    store.upsert(update({ lon: 24.941 }), 1_000);
    const vehicle = store.vehicles.get("22/1")!;
    expect(positionAt(vehicle, 1_000)[0]).toBeCloseTo(24.94);
    expect(positionAt(vehicle, 2_000)[0]).toBeCloseTo(24.941);
    const halfway = positionAt(vehicle, 1_500)[0];
    expect(halfway).toBeGreaterThan(24.94);
    expect(halfway).toBeLessThan(24.941);
  });

  it("snaps instead of gliding across town after a GPS jump", () => {
    const store = new VehicleStore();
    store.upsert(update({ lon: 24.94 }), 0);
    store.upsert(update({ lon: 25.04 }), 1_000); // about 5.5 km east
    expect(positionAt(store.vehicles.get("22/1")!, 1_000)[0]).toBeCloseTo(25.04);
  });

  it("forgets vehicles that stop reporting and counts the rest", () => {
    const store = new VehicleStore();
    store.upsert(update({ id: "a", secondsLate: 30 }), 0);
    store.upsert(update({ id: "b", mode: "bus", secondsLate: 300 }), 40_000);
    store.upsert(update({ id: "c", mode: "metro", secondsLate: null }), 40_000);
    store.prune(50_000);
    const stats = store.stats();
    expect(stats.total).toBe(2);
    expect(stats.byMode).toMatchObject({ bus: 1, metro: 1, tram: 0 });
    expect(stats.onTimeShare).toBe(0);
    expect(stats.averageSecondsLate).toBe(300);
  });

  it("measures distance in metres", () => {
    // One degree of latitude is about 111 km anywhere.
    expect(metresBetween([24.9, 60], [24.9, 61])).toBeGreaterThan(110_000);
    expect(metresBetween([24.9, 60], [24.9, 61])).toBeLessThan(112_000);
  });
});
