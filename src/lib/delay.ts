export type Punctuality = "early" | "onTime" | "late" | "veryLate" | "unknown";

/** On time means within a minute either way, the window HSL itself uses for its stop displays. */
export function punctuality(secondsLate: number | null): Punctuality {
  if (secondsLate === null) return "unknown";
  if (secondsLate < -60) return "early";
  if (secondsLate <= 60) return "onTime";
  if (secondsLate <= 180) return "late";
  return "veryLate";
}

export function describeDelay(secondsLate: number | null): string {
  if (secondsLate === null) return "No timetable data";
  const minutes = Math.round(Math.abs(secondsLate) / 60);
  if (punctuality(secondsLate) === "onTime") return "On time";
  return secondsLate > 0 ? `${minutes} min late` : `${minutes} min early`;
}
