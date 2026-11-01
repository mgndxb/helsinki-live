import { useEffect, useSyncExternalStore } from "react";

import { sound } from "./lib/sound";

const INTERACTIVE = "a, button, select, summary, input, [role='tab']";

export function useSoundEnabled() {
  return useSyncExternalStore(
    (onChange) => sound.subscribe(onChange),
    () => sound.enabled,
    () => false,
  );
}

/** The portfolio's sound button: equaliser bars that dance while sound is on and lie flat while it's off. */
export function SoundToggle({ className = "", bar = "bg-current" }: { className?: string; bar?: string }) {
  const enabled = useSoundEnabled();
  return (
    <button type="button" data-sound-toggle aria-pressed={enabled} onClick={() => sound.toggle()} className={`flex items-center gap-2 ${className}`}>
      <span aria-hidden className="flex h-3 items-end gap-[2px]">
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className={`w-[2px] origin-bottom rounded-full transition-transform duration-500 ${bar}`}
            style={{
              height: "100%",
              transform: enabled ? undefined : "scaleY(0.22)",
              animation: enabled ? `eq ${0.9 + i * 0.23}s ease-in-out ${i * -0.31}s infinite alternate` : "none",
            }}
          />
        ))}
      </span>
      <span>
        <span className="sr-only">Sound </span>
        {enabled ? "On" : "Off"}
      </span>
    </button>
  );
}

/**
 * Hover ticks and press sounds on anything interactive, quiet while the tab is hidden, and the
 * music back on from the first click for anyone who left it on in the portfolio.
 */
export function SoundEffects() {
  useEffect(() => {
    let hovered: Element | null = null;
    const fine = window.matchMedia("(pointer: fine)").matches;
    function onOver(event: PointerEvent) {
      if (event.pointerType !== "mouse") return;
      const target = (event.target as Element | null)?.closest(INTERACTIVE) ?? null;
      if (target && target !== hovered) sound.tick();
      hovered = target;
    }
    function onDown(event: PointerEvent) {
      if ((event.target as Element | null)?.closest(INTERACTIVE)) sound.press();
    }
    function onVisibility() {
      sound.setVisible(document.visibilityState === "visible");
    }
    function resume(event: Event) {
      if ((event.target as Element | null)?.closest("[data-sound-toggle]")) return;
      window.removeEventListener("pointerdown", resume, true);
      window.removeEventListener("keydown", resume, true);
      if (sound.wanted) void sound.enable();
    }
    if (fine) window.addEventListener("pointerover", onOver, { passive: true });
    window.addEventListener("pointerdown", onDown, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    if (sound.wanted) {
      window.addEventListener("pointerdown", resume, true);
      window.addEventListener("keydown", resume, true);
    }
    return () => {
      window.removeEventListener("pointerover", onOver);
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerdown", resume, true);
      window.removeEventListener("keydown", resume, true);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
  return null;
}
