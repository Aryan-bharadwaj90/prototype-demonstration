// Prototype telemetry: types, ESP8266 JSON parsing, derived values and CSV export.
// Supports the current firmware schema and the earlier (v1) schema:
//   v1: battery_voltage_v, battery_current_a, pv_voltage_v, pv_current_a, temperature_c, load_power_w?
//   v2: adds battery_power_w, pv_power_w, battery_soc, battery_capacity_wh, solar_available,
//       load_estimated, temperature_simulated, battery_status, ems_recommendation,
//       energy_consumed_wh, solar_energy_wh
// Every field except battery_voltage_v is optional and may be null.

export const NOMINAL_CAPACITY_WH = 66; // 12 V x 5.5 Ah (two 6 V batteries in series)
export const MAX_CHARGE_CURRENT_A = 1.2;
export const LOW_BATTERY_VOLTAGE_V = 11.8;
export const LOW_BATTERY_SOC = 20;
const IDLE_POWER_W = 0.1;

export type DataSource = "sensor" | "simulated";
export type BatteryState = "Charging" | "Discharging" | "Idle";

export type Sample = {
  timestamp: string;
  battery_voltage_v: number | null;
  battery_current_a: number | null;
  battery_power_w: number | null;
  battery_soc: number | null;
  battery_capacity_wh: number;
  pv_voltage_v: number | null;
  pv_current_a: number | null;
  pv_power_w: number | null;
  solar_available: boolean | null;
  load_power_w: number | null;
  load_estimated: boolean | null;
  temperature_c: number | null;
  temperature_simulated: boolean | null;
  battery_status: string | null;
  ems_recommendation: string | null;
  energy_consumed_wh: number | null;
  solar_energy_wh: number | null;
  source: DataSource;
  /** How battery_soc was obtained (UI label only, not exported as a measurement). */
  soc_origin: "firmware" | "voltage" | "simulation" | null;
};

const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};
const bool = (v: unknown): boolean | null => {
  if (v === true || v === false) return v;
  if (v === 1 || v === "true" || v === "1") return true;
  if (v === 0 || v === "false" || v === "0") return false;
  return null;
};
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, 80) : null);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Rough resting-voltage SOC for 12 V lead-acid; only used when firmware sends no SOC (v1 packets). */
export const socFromVoltage = (v: number) => clamp(((v - 11.8) / (12.7 - 11.8)) * 100, 0, 100);

/** Turn one decoded JSON object into a Sample, or null if it is not a telemetry packet. */
export function parsePacket(x: unknown, timestamp = new Date().toISOString()): Sample | null {
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  const bv = num(o.battery_voltage_v);
  if (bv === null) return null;
  const bi = num(o.battery_current_a);
  const pvv = num(o.pv_voltage_v);
  const pvi = num(o.pv_current_a);
  const firmwareSoc = num(o.battery_soc);
  const soc = firmwareSoc !== null ? clamp(firmwareSoc, 0, 100) : socFromVoltage(bv);
  return {
    timestamp,
    battery_voltage_v: bv,
    battery_current_a: bi,
    battery_power_w: num(o.battery_power_w) ?? (bi !== null ? bv * bi : null),
    battery_soc: soc,
    battery_capacity_wh: num(o.battery_capacity_wh) ?? NOMINAL_CAPACITY_WH,
    pv_voltage_v: pvv,
    pv_current_a: pvi,
    pv_power_w: num(o.pv_power_w) ?? (pvv !== null && pvi !== null ? pvv * pvi : null),
    solar_available: bool(o.solar_available),
    load_power_w: num(o.load_power_w),
    load_estimated: bool(o.load_estimated),
    temperature_c: num(o.temperature_c),
    temperature_simulated: bool(o.temperature_simulated),
    battery_status: str(o.battery_status),
    ems_recommendation: str(o.ems_recommendation),
    energy_consumed_wh: num(o.energy_consumed_wh),
    solar_energy_wh: num(o.solar_energy_wh),
    source: "sensor",
    soc_origin: firmwareSoc !== null ? "firmware" : "voltage",
  };
}

/**
 * Streaming JSON object extractor for serial data. Handles objects split across
 * chunks, several objects per line, pretty-printed (multi-line) JSON, and boot
 * noise between objects. A "{" in column 0 restarts an object, so a corrupted
 * packet cannot block the ones after it.
 */
export class JsonStream {
  private buf = "";
  push(text: string): string[] {
    this.buf += text;
    const out: string[] = [];
    let depth = 0, start = -1, inStr = false, esc = false, keepFrom = this.buf.length;
    for (let i = 0; i < this.buf.length; i++) {
      const c = this.buf[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        else if (c === "\n") { inStr = false; depth = 0; start = -1; } // broken string: drop object
        continue;
      }
      if (c === '"') { if (depth > 0) inStr = true; continue; }
      if (c === "{") {
        const lineStart = i === 0 || this.buf[i - 1] === "\n" || this.buf[i - 1] === "\r";
        if (depth === 0 || lineStart) { depth = 1; start = i; } else depth++;
      } else if (c === "}" && depth > 0) {
        depth--;
        if (depth === 0) { out.push(this.buf.slice(start, i + 1)); start = -1; }
      }
    }
    if (depth > 0 && start >= 0) keepFrom = start;
    this.buf = this.buf.slice(keepFrom);
    if (this.buf.length > 4096) this.buf = ""; // runaway guard (no closing brace)
    return out;
  }
  reset() { this.buf = ""; }
}

export function batteryState(s: Sample | undefined): BatteryState | null {
  if (!s) return null;
  const t = (s.battery_status ?? "").toLowerCase();
  if (t.includes("discharg")) return "Discharging";
  if (t.includes("charg")) return "Charging";
  if (t.includes("idle") || t.includes("standby")) return "Idle";
  const p = s.battery_power_w;
  if (p === null) return null;
  return p > IDLE_POWER_W ? "Charging" : p < -IDLE_POWER_W ? "Discharging" : "Idle";
}

export const isLowBattery = (s: Sample | undefined) =>
  !!s && ((s.battery_voltage_v !== null && s.battery_voltage_v <= LOW_BATTERY_VOLTAGE_V) || (s.battery_soc !== null && s.battery_soc <= LOW_BATTERY_SOC));
export const isOverCurrent = (s: Sample | undefined) =>
  !!s && s.battery_current_a !== null && s.battery_current_a > MAX_CHARGE_CURRENT_A;
export const solarReadingsValid = (s: Sample | undefined) => !!s && s.solar_available !== false;

/** Advisory recommendation using the same rules as the firmware (for demo mode and v1 packets). */
export function deriveRecommendation(s: Sample): string {
  if (isLowBattery(s)) return "Reduce load";
  if (isOverCurrent(s)) return "Warning";
  const st = batteryState(s);
  if (st === "Charging") return "Battery receiving energy";
  if (s.solar_available !== false && (s.pv_power_w ?? 0) > 0.5) return "Prioritize solar energy";
  if (st === "Discharging") return "Battery supplying load";
  return "Standby";
}

export type EmsKey = "standby" | "charging" | "discharging" | "low" | "overcurrent" | "solar";
export const EMS_STATES: { key: EmsKey; state: string; action: string; color: string }[] = [
  { key: "standby", state: "Idle", action: "Standby", color: "#a9b6c8" },
  { key: "charging", state: "Charging", action: "Battery receiving energy", color: "#16a672" },
  { key: "discharging", state: "Discharging", action: "Battery supplying load", color: "#2f7be0" },
  { key: "low", state: "Low battery", action: "Reduce load", color: "#e04848" },
  { key: "overcurrent", state: "Charging current too high", action: "Warning", color: "#eb6834" },
  { key: "solar", state: "Solar energy available", action: "Prioritize solar energy", color: "#e89f00" },
];

export function classifyRecommendation(rec: string | null): EmsKey | null {
  if (!rec) return null;
  const t = rec.toLowerCase();
  if (/low|reduce/.test(t)) return "low";
  if (/too high|over.?current|warn|exceed/.test(t)) return "overcurrent";
  if (/solar|priorit/.test(t)) return "solar";
  if (/discharg|supplying/.test(t)) return "discharging";
  if (/charg|receiving/.test(t)) return "charging";
  if (/standby|idle/.test(t)) return "standby";
  return null;
}

/** Session energy totals: firmware counters when present, otherwise integrated from retained samples. */
export function energyTotals(rows: Sample[]) {
  const last = rows[rows.length - 1];
  const integrate = (pick: (r: Sample) => number | null) => {
    let sum = 0, known = rows.length > 1;
    for (let i = 1; i < rows.length; i++) {
      const dt = (Date.parse(rows[i].timestamp) - Date.parse(rows[i - 1].timestamp)) / 3600000;
      const v = pick(rows[i - 1]);
      if (v === null) { known = false; continue; }
      if (dt > 0 && dt < 5 / 3600) sum += v * dt;
    }
    return known ? sum : null;
  };
  const consumedFw = last?.energy_consumed_wh ?? null;
  const solarFw = last?.solar_energy_wh ?? null;
  return {
    consumed: consumedFw ?? integrate((r) => r.load_power_w),
    consumedFromFirmware: consumedFw !== null,
    solar: solarFw ?? integrate((r) => (r.solar_available === false ? 0 : r.pv_power_w)),
    solarFromFirmware: solarFw !== null,
  };
}

export const CSV_COLUMNS = [
  "timestamp", "battery_voltage_v", "battery_current_a", "battery_power_w", "battery_soc", "battery_capacity_wh",
  "pv_voltage_v", "pv_current_a", "pv_power_w", "solar_available", "load_power_w", "load_estimated",
  "temperature_c", "temperature_simulated", "battery_status", "ems_recommendation", "energy_consumed_wh", "solar_energy_wh",
] as const;

const cell = (v: unknown) => {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * CSV with blank cells for unavailable values. When solar_available is false the PV
 * readings are exported blank (not verified). Extra columns flag provenance:
 * data_source (esp8266_sensor | browser_simulation) and battery_soc_estimated.
 */
export function toCsv(rows: Sample[]): string {
  const header = [...CSV_COLUMNS, "battery_soc_estimated", "data_source"].join(",");
  const lines = rows.map((r) => {
    const solarOk = r.solar_available !== false;
    const values = CSV_COLUMNS.map((k) => {
      if (!solarOk && (k === "pv_voltage_v" || k === "pv_current_a" || k === "pv_power_w")) return "";
      return cell(r[k]);
    });
    values.push(r.battery_soc === null ? "" : "true");
    values.push(r.source === "sensor" ? "esp8266_sensor" : "browser_simulation");
    return values.join(",");
  });
  return [header, ...lines].join("\n");
}
