"use client";
// Minimal Web Serial connection hook. Each instance owns one port, so the ESP8266 (DC)
// and ESP32 (AC) links run independently.
//  - open() is retried briefly (a board that is resetting, or a port still being released
//    after a page refresh, often fails the first attempt)
//  - reconnect() reopens the previously used port without the picker when it can be
//    identified unambiguously, otherwise falls back to the picker
//  - after an unexpected loss (board reset re-enumerating USB, cable unplugged) the link
//    reconnects automatically when the same board reappears
import { useCallback, useEffect, useRef, useState } from "react";

type PortInfo = { usbVendorId?: number; usbProductId?: number };
type SerialPortLike = {
  open: (o: { baudRate: number }) => Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  close: () => Promise<void>;
  getInfo?: () => PortInfo;
};
type SerialApi = {
  requestPort: () => Promise<SerialPortLike>;
  getPorts?: () => Promise<SerialPortLike[]>;
  addEventListener?: (type: string, cb: (e: Event) => void) => void;
  removeEventListener?: (type: string, cb: (e: Event) => void) => void;
};

export type LinkState = "idle" | "connecting" | "open" | "closing";

const RECOVERABLE = new Set(["BreakError", "FramingError", "ParityError", "BufferOverrunError"]);
const serialApi = () => (typeof navigator === "undefined" ? undefined : (navigator as unknown as { serial?: SerialApi }).serial);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const infoKey = (device: string) => `sems-serial-port:${device}`;
const loadInfo = (device: string): PortInfo | null => {
  try { const s = localStorage.getItem(infoKey(device)); return s ? (JSON.parse(s) as PortInfo) : null; } catch { return null; }
};
const saveInfo = (device: string, info: PortInfo) => { try { localStorage.setItem(infoKey(device), JSON.stringify(info)); } catch {} };
const sameInfo = (a: PortInfo | null | undefined, b: PortInfo | null | undefined) =>
  !!a && !!b && a.usbVendorId !== undefined && a.usbVendorId === b.usbVendorId && a.usbProductId === b.usbProductId;

export function openErrorMessage(e: unknown, device: string): string {
  const name = e instanceof DOMException ? e.name : "";
  if (name === "NotFoundError") return `No port selected. Click Connect ${device} and pick its USB-SERIAL port.`;
  if (name === "NetworkError")
    return `Couldn't open the serial port: another program is using it. Close the Arduino IDE Serial Monitor/Plotter (or any other serial app), then click Connect again. If it persists, unplug and replug the ${device}.`;
  if (name === "InvalidStateError") return "That port is already open (in this page or another tab). Pick a different port or close it there.";
  if (name === "SecurityError") return "Serial access was blocked. Use desktop Chrome or Edge over HTTPS or localhost.";
  return String(e);
}

export function useSerialLink(device: string, handlers: { onOpen?: () => void; onText: (text: string) => void }) {
  const [state, setState] = useState<LinkState>("idle");
  const [message, setMessage] = useState("Not connected");
  const [canReconnect, setCanReconnect] = useState(false);
  const h = useRef(handlers);
  useEffect(() => { h.current = handlers; });
  const busy = useRef(false);
  const stop = useRef(false);
  const auto = useRef(false); // waiting for a lost board to reappear
  const reader = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const portRef = useRef<SerialPortLike | null>(null);
  const infoRef = useRef<PortInfo | null>(null);

  /** Open the given port (with retries) and read until stopped or lost. busy must already be set. */
  const run = useCallback(async (port: SerialPortLike) => {
    let lastErr: unknown = null, opened = false;
    for (let attempt = 0; attempt < 3 && !stop.current; attempt++) {
      try { await port.open({ baudRate: 115200 }); opened = true; break; }
      catch (e) {
        lastErr = e;
        if (e instanceof DOMException && e.name === "InvalidStateError") break; // already open elsewhere
        await sleep(800);
      }
    }
    if (!opened) {
      busy.current = false;
      setState("idle");
      setMessage(stop.current ? `${device} disconnected` : openErrorMessage(lastErr, device));
      return;
    }
    portRef.current = port;
    const info = port.getInfo?.() ?? {};
    infoRef.current = info;
    saveInfo(device, info);
    auto.current = false;
    setCanReconnect(true);
    setState("open");
    setMessage(`Connected — waiting for ${device} data`);
    h.current.onOpen?.();

    let lost = false;
    const decoder = new TextDecoder();
    outer: while (!stop.current && port.readable) {
      const r = port.readable.getReader();
      reader.current = r;
      try {
        while (!stop.current) {
          const { value, done } = await r.read();
          if (done) { if (!stop.current) lost = true; break outer; }
          if (value) h.current.onText(decoder.decode(value, { stream: true }));
        }
      } catch (e) {
        const name = e instanceof DOMException ? e.name : "";
        if (RECOVERABLE.has(name)) continue; // transient line error: readable is recreated
        lost = true;
        break;
      } finally {
        reader.current = null;
        try { r.releaseLock(); } catch {}
      }
    }
    if (!stop.current && !port.readable) lost = true;
    try { await port.close(); } catch {}
    busy.current = false;
    setState("idle");
    if (stop.current || !lost) setMessage(`${device} disconnected`);
    else {
      auto.current = true;
      setMessage(`${device} connection lost (board reset or USB unplugged). Reconnecting automatically when it reappears — or click Reconnect.`);
    }
  }, [device]);

  const connect = useCallback(async () => {
    if (busy.current) return;
    const serial = serialApi();
    if (!serial) { setMessage("Web Serial unavailable. Use desktop Chrome or Edge over HTTPS or localhost."); return; }
    busy.current = true;
    stop.current = false;
    auto.current = false;
    setState("connecting");
    let port: SerialPortLike;
    try { port = await serial.requestPort(); }
    catch (e) { busy.current = false; setState("idle"); setMessage(openErrorMessage(e, device)); return; }
    await run(port);
  }, [device, run]);

  /** Reopen the last port without the picker when it is unambiguous, otherwise show the picker. */
  const reconnect = useCallback(async () => {
    if (busy.current) return;
    const serial = serialApi();
    if (!serial) { setMessage("Web Serial unavailable. Use desktop Chrome or Edge over HTTPS or localhost."); return; }
    busy.current = true;
    stop.current = false;
    auto.current = false;
    setState("connecting");
    let port: SerialPortLike | null = null;
    try {
      const info = infoRef.current ?? loadInfo(device);
      const ports = ((await serial.getPorts?.()) ?? []).filter((p) => p.readable === null); // closed ports only
      const last = ports.find((p) => p === portRef.current);
      const matches = ports.filter((p) => sameInfo(info, p.getInfo?.()));
      port = last ?? (matches.length === 1 ? matches[0] : null);
      if (!port) port = await serial.requestPort();
    } catch (e) { busy.current = false; setState("idle"); setMessage(openErrorMessage(e, device)); return; }
    await run(port);
  }, [device, run]);

  const disconnect = useCallback(() => {
    auto.current = false;
    if (!busy.current) return;
    stop.current = true;
    setState("closing");
    void reader.current?.cancel().catch(() => {});
  }, []);

  // Quick-reconnect availability (e.g. after a page refresh) and auto-reconnect on re-plug / reset.
  useEffect(() => {
    const serial = serialApi();
    if (!serial) return;
    const info = loadInfo(device);
    void serial.getPorts?.().then((ports) => { if (ports.some((p) => sameInfo(info, p.getInfo?.()))) setCanReconnect(true); }).catch(() => {});
    const onConnect = (e: Event) => {
      const port = e.target as unknown as SerialPortLike | null;
      if (!auto.current || busy.current || !port || typeof port.open !== "function") return;
      if (!sameInfo(infoRef.current, port.getInfo?.())) return;
      busy.current = true;
      stop.current = false;
      auto.current = false;
      setState("connecting");
      setMessage(`${device} reappeared — reconnecting…`);
      void sleep(600).then(() => run(port));
    };
    serial.addEventListener?.("connect", onConnect);
    return () => serial.removeEventListener?.("connect", onConnect);
  }, [device, run]);

  useEffect(() => () => { stop.current = true; auto.current = false; void reader.current?.cancel().catch(() => {}); }, []);

  return {
    state, message, connect, reconnect, disconnect, canReconnect,
    active: state === "open" || state === "closing" || state === "connecting",
  };
}
