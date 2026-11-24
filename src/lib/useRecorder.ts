"use client";
// React wrapper around Recorder. One Recorder instance lives for the page lifetime
// (lazy useState initialiser, so Strict Mode's double render cannot create two stores).
// All mutations happen in event handlers / timer callbacks, never inside state updaters,
// so Strict Mode's double-invoked updaters cannot record a row twice.
import { useCallback, useEffect, useState } from "react";
import { Recorder, DatasetKey } from "./recorder";

export function useRecorder() {
  const [rec] = useState(() => new Recorder());
  const [, setVersion] = useState(0);
  const [now, setNow] = useState(0);
  const bump = useCallback(() => { setVersion((v) => v + 1); setNow(Date.now()); }, []);

  // Duration clock: one interval, only while recording, always cleaned up.
  useEffect(() => {
    if (rec.status !== "recording") return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [rec, rec.status]);

  /** Stable: safe to call from serial callbacks and simulation timers. */
  const offer = useCallback((key: DatasetKey, row: Parameters<Recorder["offer"]>[1]) => {
    if (rec.offer(key, row) !== "ignored") bump();
  }, [rec, bump]);

  const act = useCallback(<A extends unknown[]>(fn: (...a: A) => unknown) => (...a: A) => { fn(...a); bump(); }, [bump]);

  return {
    rec, now, offer,
    start: act(() => rec.start(Date.now())),
    pause: act(() => rec.pause(Date.now())),
    resume: act(() => rec.resume(Date.now())),
    stop: act(() => rec.stop(Date.now())),
    clear: act(() => rec.clear()),
    setIntervalS: act((s: number) => rec.setInterval(s)),
    setMax: act((n: number) => rec.setMax(n)),
    toggle: act((k: DatasetKey) => rec.toggle(k)),
  };
}
