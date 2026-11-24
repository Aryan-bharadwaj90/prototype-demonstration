// Explicit dataset recording, separate from live display and simulation.
//  - Nothing is recorded until Start is pressed (status starts "idle").
//  - Four independent datasets; a row is accepted only into the dataset matching its
//    circuit (DC/AC) and source (sensor/simulated), so live and simulated data never mix.
//  - Rows are recorded only when a real new reading arrives (no interpolation, no padding)
//    and at most once per recording interval, keyed on the reading timestamp, so repeated
//    calls (React Strict Mode, duplicate timers, re-renders) can never duplicate a row.
import { Sample, AcRow, toCsv } from "./telemetry";

export type DatasetKey = "dc_live" | "ac_live" | "dc_sim" | "ac_sim";
export type RecStatus = "idle" | "recording" | "paused" | "stopped";
type Row = Sample | AcRow;

export const DATASETS: { key: DatasetKey; label: string; circuit: "dc" | "ac"; source: "sensor" | "simulated"; file: string; note: string }[] = [
  { key: "dc_live", label: "ESP8266 live DC", circuit: "dc", source: "sensor", file: "esp8266-live-dc", note: "INA219 sensor readings · SOC estimated · load/temperature flags as sent" },
  { key: "ac_live", label: "ESP32 live AC", circuit: "ac", source: "sensor", file: "esp32-live-ac", note: "Diagnostic estimates unless calibrated · ac_calibrated exported as received" },
  { key: "dc_sim", label: "Simulated DC", circuit: "dc", source: "simulated", file: "simulated-dc", note: "Browser simulation · not measured" },
  { key: "ac_sim", label: "Simulated AC", circuit: "ac", source: "simulated", file: "simulated-ac", note: "220 V / 15 W bulb model · not measured" },
];
export const INTERVAL_OPTIONS = [1, 5, 10, 30, 60] as const;
export const MAX_SAMPLE_OPTIONS = [500, 1000, 3600, 7000, 10000, 20000] as const;
const JITTER_MS = 250; // a reading arriving slightly early still counts for its interval slot

const isAcRow = (r: Row): r is AcRow => "display_voltage_v" in r;
/** True only when the row's circuit and source match the dataset. */
export function belongsTo(key: DatasetKey, r: Row): boolean {
  const d = DATASETS.find((x) => x.key === key)!;
  return (d.circuit === "ac") === isAcRow(r) && r.source === d.source;
}

const emptySets = <T>(v: () => T): Record<DatasetKey, T> => ({ dc_live: v(), ac_live: v(), dc_sim: v(), ac_sim: v() });

export class Recorder {
  status: RecStatus = "idle";
  intervalS = 1;
  maxSamples = 7000;
  selected: Record<DatasetKey, boolean> = emptySets(() => true);
  message: string | null = null;
  private data: Record<DatasetKey, Row[]> = emptySets<Row[]>(() => []);
  private lastTs: Record<DatasetKey, number> = emptySets(() => 0);
  private accumulatedMs = 0;
  private segmentStart = 0;

  count(key: DatasetKey) { return this.data[key].length; }
  total() { return DATASETS.reduce((n, d) => n + this.data[d.key].length, 0); }
  rows(key: DatasetKey): readonly Row[] { return this.data[key]; }
  durationMs(now: number) { return this.accumulatedMs + (this.status === "recording" ? Math.max(0, now - this.segmentStart) : 0); }
  get editable() { return this.status === "idle" || this.status === "stopped"; }

  setInterval(s: number) { if (this.editable && (INTERVAL_OPTIONS as readonly number[]).includes(s)) this.intervalS = s; }
  setMax(n: number) { if (this.editable && Number.isInteger(n) && n > 0) this.maxSamples = n; }
  toggle(key: DatasetKey) { if (this.editable) this.selected = { ...this.selected, [key]: !this.selected[key] }; }

  /** Begin (or begin again after Stop). Existing rows are kept and appended to. */
  start(now: number): boolean {
    if (this.status === "recording" || this.status === "paused") return false;
    const chosen = DATASETS.filter((d) => this.selected[d.key]);
    if (!chosen.length) { this.message = "Select at least one dataset to record."; return false; }
    const full = chosen.find((d) => this.data[d.key].length >= this.maxSamples);
    if (full) { this.message = `${full.label} already holds ${this.maxSamples.toLocaleString()} samples. Download and clear it, or raise the limit.`; return false; }
    this.status = "recording";
    this.segmentStart = now;
    this.message = null;
    return true;
  }
  pause(now: number) {
    if (this.status !== "recording") return;
    this.accumulatedMs += Math.max(0, now - this.segmentStart);
    this.status = "paused";
  }
  resume(now: number) {
    if (this.status !== "paused") return;
    this.status = "recording";
    this.segmentStart = now;
  }
  stop(now: number, reason: string | null = null) {
    if (this.status === "recording") this.accumulatedMs += Math.max(0, now - this.segmentStart);
    if (this.status === "recording" || this.status === "paused") this.status = "stopped";
    this.message = reason;
  }
  /** Remove all recorded rows. Only allowed while not recording. */
  clear() {
    if (this.status === "recording" || this.status === "paused") return false;
    this.data = emptySets<Row[]>(() => []);
    this.lastTs = emptySets(() => 0);
    this.accumulatedMs = 0;
    this.status = "idle";
    this.message = null;
    return true;
  }

  /**
   * Offer a freshly received reading. Returns "recorded", "limit" (recorded and the limit was
   * reached, recording stopped) or "ignored".
   */
  offer(key: DatasetKey, row: Row, now = Date.now()): "recorded" | "limit" | "ignored" {
    if (this.status !== "recording" || !this.selected[key] || !belongsTo(key, row)) return "ignored";
    const set = this.data[key];
    if (set.length >= this.maxSamples) return "ignored";
    const ts = Date.parse(row.timestamp);
    if (!Number.isFinite(ts) || ts <= this.lastTs[key]) return "ignored"; // same reading offered twice
    if (this.lastTs[key] && ts - this.lastTs[key] < this.intervalS * 1000 - JITTER_MS) return "ignored";
    set.push(row);
    this.lastTs[key] = ts;
    if (set.length >= this.maxSamples) {
      const label = DATASETS.find((d) => d.key === key)!.label;
      this.stop(now, `Limit of ${this.maxSamples.toLocaleString()} samples reached for ${label} — recording stopped automatically.`);
      return "limit";
    }
    return "recorded";
  }

  /** CSV for exactly one dataset. Rows are re-checked so another source can never leak in. */
  csv(key: DatasetKey): string {
    const rows = this.data[key].filter((r) => belongsTo(key, r));
    return DATASETS.find((d) => d.key === key)!.circuit === "dc"
      ? toCsv(rows as Sample[], [])
      : toCsv([], rows as AcRow[]);
  }
}

/* ---------- Synthetic test CSV import (kept separate from all recorded data) ---------- */
export const SYNTHETIC_LABELS = ["synthetic", "synthetic_test", "browser_simulation", "simulated"];
const SENSOR_LABELS = ["esp8266_sensor", "esp32_sensor", "sensor", "sensor_measurement", "measured"];

/** Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((x) => x !== "")) out.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x !== "")) out.push(row);
  return out;
}

export type ImportedPoint = { t: string; voltage: number | null; current: number | null; soc: number | null; solar: number | null; load: number | null };
export type ImportedDataset = {
  name: string; rows: number; dcRows: number; acRows: number; columns: string[];
  first: string | null; last: string | null; labels: string[]; series: ImportedPoint[];
};

/**
 * Accept a CSV only when it is clearly labelled synthetic: it needs a data_source column and
 * every row must carry a synthetic/simulated label. Any sensor-labelled row rejects the file.
 */
export function importSyntheticCsv(text: string, name: string, maxRows = 50000): { ok: true; dataset: ImportedDataset } | { ok: false; error: string } {
  const table = parseCsv(text.replace(/^﻿/, ""));
  if (table.length < 2) return { ok: false, error: "The file has no data rows." };
  const header = table[0].map((h) => h.trim().toLowerCase());
  const col = (k: string) => header.indexOf(k);
  const ds = col("data_source");
  if (ds < 0) return { ok: false, error: "Not imported: the file has no data_source column, so it is not clearly labelled as synthetic test data." };
  const body = table.slice(1);
  if (body.length > maxRows) return { ok: false, error: `Not imported: ${body.length.toLocaleString()} rows exceeds the ${maxRows.toLocaleString()}-row import limit.` };
  const labels = new Set<string>();
  for (let i = 0; i < body.length; i++) {
    const v = (body[i][ds] ?? "").trim().toLowerCase();
    if (SENSOR_LABELS.includes(v)) return { ok: false, error: `Not imported: row ${i + 2} is labelled "${v}" (a measurement). Only synthetic test files can be imported; live data stays in the recorded datasets.` };
    if (!SYNTHETIC_LABELS.includes(v)) return { ok: false, error: `Not imported: row ${i + 2} has data_source "${v || "(blank)"}". Every row must be labelled one of: ${SYNTHETIC_LABELS.join(", ")}.` };
    labels.add(v);
  }
  const num = (r: string[], k: string) => {
    const i = col(k);
    if (i < 0) return null;
    const s = (r[i] ?? "").trim();
    if (s === "") return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };
  const ti = col("timestamp"), ci = col("circuit");
  const isAc = (r: string[]) => (ci >= 0 ? (r[ci] ?? "").trim().toLowerCase() === "ac" : false);
  const dc = body.filter((r) => !isAc(r) && num(r, "battery_voltage_v") !== null);
  const step = Math.max(1, Math.ceil(dc.length / 600)); // keep charts responsive
  const series: ImportedPoint[] = [];
  for (let i = 0; i < dc.length; i += step) {
    const r = dc[i];
    const raw = ti >= 0 ? (r[ti] ?? "").trim() : "";
    const d = Date.parse(raw);
    series.push({
      t: Number.isFinite(d) ? new Date(d).toLocaleTimeString([], { hour12: false }) : raw || `#${i + 1}`,
      voltage: num(r, "battery_voltage_v"), current: num(r, "battery_current_a"), soc: num(r, "battery_soc"),
      solar: num(r, "pv_power_w"), load: num(r, "load_power_w"),
    });
  }
  const stamps = ti >= 0 ? body.map((r) => (r[ti] ?? "").trim()).filter(Boolean) : [];
  return {
    ok: true,
    dataset: {
      name, rows: body.length, dcRows: dc.length, acRows: body.filter(isAc).length, columns: header,
      first: stamps[0] ?? null, last: stamps[stamps.length - 1] ?? null, labels: [...labels], series,
    },
  };
}
