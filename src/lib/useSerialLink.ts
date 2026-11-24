"use client";
// Minimal Web Serial connection hook. Each instance owns one port, so the ESP8266 (DC)
// and ESP32 (AC) links run independently.
import { useCallback, useEffect, useRef, useState } from "react";

type SerialPortLike = {
  open: (o: { baudRate: number }) => Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  close: () => Promise<void>;
};
type SerialApi = { requestPort: () => Promise<SerialPortLike> };

export type LinkState = "idle" | "connecting" | "open" | "closing";

const RECOVERABLE = new Set(["BreakError", "FramingError", "ParityError", "BufferOverrunError"]);

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
  const h = useRef(handlers);
  useEffect(() => { h.current = handlers; });
  const busy = useRef(false);
  const stop = useRef(false);
  const reader = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);

  const connect = useCallback(async () => {
    if (busy.current) return;
    const serial = (navigator as unknown as { serial?: SerialApi }).serial;
    if (!serial) { setMessage("Web Serial unavailable. Use desktop Chrome or Edge over HTTPS or localhost."); return; }
    busy.current = true;
    stop.current = false;
    setState("connecting");
    let port: SerialPortLike;
    try {
      port = await serial.requestPort();
      await port.open({ baudRate: 115200 });
    } catch (e) {
      busy.current = false;
      setState("idle");
      setMessage(openErrorMessage(e, device));
      return;
    }
    setState("open");
    setMessage(`Connected — waiting for ${device} data`);
    h.current.onOpen?.();
    let ended = `${device} disconnected`;
    const decoder = new TextDecoder();
    outer: while (!stop.current && port.readable) {
      const r = port.readable.getReader();
      reader.current = r;
      try {
        while (!stop.current) {
          const { value, done } = await r.read();
          if (done) break outer;
          if (value) h.current.onText(decoder.decode(value, { stream: true }));
        }
      } catch (e) {
        const name = e instanceof DOMException ? e.name : "";
        if (RECOVERABLE.has(name)) continue; // transient line error: readable is recreated
        ended = `${device} connection lost (USB unplugged or board reset). Click Connect to resume.`;
        break;
      } finally {
        reader.current = null;
        try { r.releaseLock(); } catch {}
      }
    }
    try { await port.close(); } catch {}
    busy.current = false;
    setState("idle");
    setMessage(stop.current ? `${device} disconnected` : ended);
  }, [device]);

  const disconnect = useCallback(() => {
    if (!busy.current) return;
    stop.current = true;
    setState("closing");
    void reader.current?.cancel().catch(() => {});
  }, []);

  useEffect(() => () => { stop.current = true; void reader.current?.cancel().catch(() => {}); }, []);

  return { state, message, connect, disconnect, active: state === "open" || state === "closing" || state === "connecting" };
}
