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

/* ---------- Separate AC circuit (ESP32 + ACS712 20 A + ZMPT101B) ---------- */
export const AC_RATED_POWER_W = 15; // bulb nameplate rating, never a measurement
export const AC_NOMINAL_VOLTAGE_V = 220;

/** Fields exactly as reported by the ESP32 firmware (never modified by the dashboard). */
export type AcSample = {
  timestamp: string;
  ac_voltage_v: number | null;
  ac_current_a: number | null;
  ac_power_w: number | null;
  apparent_power_va: number | null;
  power_factor: number | null;
  grid_status: string | null;
  voltage_offset_v: number | null;
  current_offset_v: number | null;
  raw_voltage_rms: number | null;
  raw_current_rms: number | null;
  /** As received: true / false / null (missing). Never forced by the dashboard. */
  ac_calibrated: boolean | null;
};

const AC_KEYS = ["ac_voltage_v", "ac_current_a", "ac_power_w", "apparent_power_va", "power_factor", "raw_voltage_rms", "raw_current_rms"] as const;

/**
 * JSON.parse that tolerates common Arduino printf output: bare nan / -nan / inf / infinity
 * values (e.g. power factor = P / S with S = 0) become null, and trailing commas are dropped.
 * Used for the ESP32 AC link so one invalid value does not discard the whole packet.
 */
export function parseLenientJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const fixed = text
      .replace(/:\s*[-+]?(nan|inf(inity)?|ovf)\b/gi, ":null")
      .replace(/,\s*([}\]])/g, "$1");
    return JSON.parse(fixed);
  }
}

/** Parse one ESP32 AC packet. Accepts source:"ac_esp32" or any packet carrying AC fields. */
export function parseAcPacket(x: unknown, timestamp = new Date().toISOString()): AcSample | null {
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  const tagged = o.source === "ac_esp32";
  if (!tagged && !AC_KEYS.some((k) => k in o)) return null;
  if (!tagged && "battery_voltage_v" in o) return null; // DC packet on the wrong link
  const gs = o.grid_status;
  return {
    timestamp,
    ac_voltage_v: num(o.ac_voltage_v),
    ac_current_a: num(o.ac_current_a),
    ac_power_w: num(o.ac_power_w),
    apparent_power_va: num(o.apparent_power_va),
    power_factor: num(o.power_factor),
    grid_status: gs === true ? "Available" : gs === false ? "Unavailable" : str(gs),
    voltage_offset_v: num(o.voltage_offset_v),
    current_offset_v: num(o.current_offset_v),
    raw_voltage_rms: num(o.raw_voltage_rms),
    raw_current_rms: num(o.raw_current_rms),
    ac_calibrated: bool(o.ac_calibrated),
  };
}

/* ---------- Optional dashboard calibration (reference-meter based) ---------- */
export type AcCalibration = {
  vMult: number; iMult: number; vFloor: number; iFloor: number;
  vBase: "ac_voltage_v" | "raw_voltage_rms"; iBase: "ac_current_a" | "raw_current_rms";
  /** true only after validateCalibration succeeded against entered reference readings */
  complete: boolean; validatedAt: string | null; refV: number | null; refI: number | null;
};
export const DEFAULT_CALIBRATION: AcCalibration = {
  vMult: 1, iMult: 1, vFloor: 0, iFloor: 0, vBase: "ac_voltage_v", iBase: "ac_current_a",
  complete: false, validatedAt: null, refV: null, refI: null,
};
const CAL_KEY = "sems-ac-calibration-v1";
export function loadCalibration(): AcCalibration {
  try {
    const raw = localStorage.getItem(CAL_KEY);
    if (!raw) return DEFAULT_CALIBRATION;
    const c = { ...DEFAULT_CALIBRATION, ...JSON.parse(raw) } as AcCalibration;
    const okNum = (n: unknown, min: number) => typeof n === "number" && Number.isFinite(n) && n >= min;
    if (!okNum(c.vMult, 1e-9) || !okNum(c.iMult, 1e-9) || !okNum(c.vFloor, 0) || !okNum(c.iFloor, 0)) return DEFAULT_CALIBRATION;
    return c;
  } catch { return DEFAULT_CALIBRATION; }
}
export function saveCalibration(c: AcCalibration) {
  try { localStorage.setItem(CAL_KEY, JSON.stringify(c)); } catch {}
}

const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
const cv = (v: number[]) => { const m = mean(v); return m === 0 ? Infinity : Math.sqrt(mean(v.map((x) => (x - m) ** 2))) / Math.abs(m); };

/**
 * Validate genuine reference readings (multimeter / clamp meter) against recent ESP32 readings
 * taken with the bulb ON. Requires >= 5 stable packets from the last 10 s. Calibration is only
 * marked complete when every check passes.
 */
export function validateCalibration(refV: number, refI: number, recent: AcSample[]):
  { ok: true; cal: Pick<AcCalibration, "vMult" | "iMult" | "vBase" | "iBase">; avgV: number; avgI: number } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!Number.isFinite(refV) || refV < 180 || refV > 260) errors.push("Reference voltage must be a measured mains value between 180 V and 260 V.");
  if (!Number.isFinite(refI) || refI < 0.005 || refI > 20) errors.push("Reference current must be a measured value between 0.005 A and 20 A (bulb ON).");
  if (recent.length < 5) errors.push(`Need at least 5 live ESP32 packets from the last 10 s (have ${recent.length}). Keep the ESP32 connected with the bulb ON.`);
  const pick = (a: keyof AcSample, b: keyof AcSample) => {
    const primary = recent.map((r) => r[a]).filter((x): x is number => typeof x === "number" && x > 0);
    if (primary.length >= 5) return { base: a, values: primary };
    return { base: b, values: recent.map((r) => r[b]).filter((x): x is number => typeof x === "number" && x > 0) };
  };
  const v = pick("ac_voltage_v", "raw_voltage_rms"), i = pick("ac_current_a", "raw_current_rms");
  if (recent.length >= 5) {
    if (v.values.length < 5) errors.push("ESP32 voltage readings are zero or missing — check the ZMPT101B wiring.");
    else if (cv(v.values) > 0.1) errors.push("ESP32 voltage readings are unstable (>10% variation). Wait for steady readings and retry.");
    if (i.values.length < 5) errors.push("ESP32 current readings are zero or missing — switch the bulb ON and check the ACS712.");
    else if (cv(i.values) > 0.15) errors.push("ESP32 current readings are unstable (>15% variation). Wait for steady readings and retry.");
  }
  if (errors.length) return { ok: false, errors };
  const avgV = mean(v.values), avgI = mean(i.values);
  return {
    ok: true, avgV, avgI,
    cal: { vMult: refV / avgV, iMult: refI / avgI, vBase: v.base as AcCalibration["vBase"], iBase: i.base as AcCalibration["iBase"] },
  };
}

/* ---------- AC rows as stored and exported ---------- */
export type AcLinkStatus = "connected_diagnostic" | "connected_live" | "simulated";
export type AcCalibrationStatus = "firmware_calibrated" | "dashboard_calibrated" | "uncalibrated" | "not_applicable";
export type AcQuality = "calibrated_measurement" | "diagnostic_estimate" | "simulated";

export type AcRow = AcSample & {
  source: "sensor" | "simulated";
  link_status: AcLinkStatus;
  calibration_status: AcCalibrationStatus;
  measurement_quality: AcQuality;
  /** Values shown on the dashboard (firmware, dashboard-calibrated, or simulated) */
  display_voltage_v: number | null;
  display_current_a: number | null;
  display_power_w: number | null;
  display_apparent_va: number | null;
  display_power_factor: number | null;
  ac_energy_wh: number | null;
  cal_voltage_multiplier: number | null;
  cal_current_multiplier: number | null;
};

/** Build the stored row for a real ESP32 packet. Dashboard calibration is applied only when validated
 *  and only if the firmware itself does not report ac_calibrated = true. */
export function acRowFromSensor(a: AcSample, cal: AcCalibration, energyWh: (powerW: number | null, ts: string) => number | null): AcRow {
  const fw = a.ac_calibrated === true;
  const dash = !fw && cal.complete;
  let v = a.ac_voltage_v, i = a.ac_current_a, p = a.ac_power_w, s = a.apparent_power_va, pf = a.power_factor;
  if (dash) {
    const vb = cal.vBase === "raw_voltage_rms" ? a.raw_voltage_rms : a.ac_voltage_v;
    const ib = cal.iBase === "raw_current_rms" ? a.raw_current_rms : a.ac_current_a;
    v = vb === null ? null : vb * cal.vMult;
    i = ib === null ? null : ib * cal.iMult;
    if (v !== null && v < cal.vFloor) v = 0;
    if (i !== null && i < cal.iFloor) i = 0;
    s = v !== null && i !== null ? v * i : null;
    if (cal.vBase === "ac_voltage_v" && cal.iBase === "ac_current_a" && a.ac_power_w !== null) p = a.ac_power_w * cal.vMult * cal.iMult;
    else p = s !== null && a.power_factor !== null ? s * a.power_factor : null;
    if (v === 0 || i === 0) p = 0;
    pf = s && s > 0 && p !== null ? clamp(p / s, 0, 1) : null;
  }
  const calibrated = fw || dash;
  return {
    ...a,
    source: "sensor",
    link_status: calibrated ? "connected_live" : "connected_diagnostic",
    calibration_status: fw ? "firmware_calibrated" : dash ? "dashboard_calibrated" : "uncalibrated",
    measurement_quality: calibrated ? "calibrated_measurement" : "diagnostic_estimate",
    display_voltage_v: v, display_current_a: i, display_power_w: p, display_apparent_va: s, display_power_factor: pf,
    ac_energy_wh: energyWh(p, a.timestamp),
    cal_voltage_multiplier: dash ? cal.vMult : null,
    cal_current_multiplier: dash ? cal.iMult : null,
  };
}

/** Simulated 220 V supply and 15 W resistive bulb (R = V² / P). Firmware fields stay null. */
export type AcSimState = { energy: number; last: number };
export function acSimRow(bulbOn: boolean, st: AcSimState): AcRow {
  const now = Date.now();
  const dt = st.last ? Math.min(5, (now - st.last) / 1000) : 1;
  st.last = now;
  const t = now / 1000;
  const v = AC_NOMINAL_VOLTAGE_V + 2 * Math.sin(t / 9) + 0.6 * Math.sin(t / 2.3);
  const r = (AC_NOMINAL_VOLTAGE_V * AC_NOMINAL_VOLTAGE_V) / AC_RATED_POWER_W;
  const i = bulbOn ? v / r : 0;
  const p = v * i;
  st.energy += (p * dt) / 3600;
  return {
    timestamp: new Date(now).toISOString(),
    ac_voltage_v: null, ac_current_a: null, ac_power_w: null, apparent_power_va: null, power_factor: null,
    grid_status: "Available (simulated)", voltage_offset_v: null, current_offset_v: null,
    raw_voltage_rms: null, raw_current_rms: null, ac_calibrated: null,
    source: "simulated", link_status: "simulated", calibration_status: "not_applicable", measurement_quality: "simulated",
    display_voltage_v: v, display_current_a: i, display_power_w: p, display_apparent_va: p,
    display_power_factor: bulbOn ? 1 : null, ac_energy_wh: st.energy,
    cal_voltage_multiplier: null, cal_current_multiplier: null,
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

/** Firmware-reported AC fields (exported exactly as received, including ac_calibrated). */
export const AC_CSV_COLUMNS = [
  "ac_voltage_v", "ac_current_a", "ac_power_w", "apparent_power_va", "power_factor", "grid_status",
  "voltage_offset_v", "current_offset_v", "raw_voltage_rms", "raw_current_rms", "ac_calibrated",
] as const;
/** Dashboard-side AC fields: shown values, energy, connection/calibration status and multipliers. */
export const AC_EXTRA_COLUMNS = [
  "ac_display_voltage_v", "ac_display_current_a", "ac_display_power_w", "ac_display_apparent_va", "ac_display_power_factor",
  "ac_energy_wh", "ac_link_status", "ac_calibration_status", "cal_voltage_multiplier", "cal_current_multiplier",
] as const;
const AC_EXTRA_FIELDS: Record<(typeof AC_EXTRA_COLUMNS)[number], keyof AcRow> = {
  ac_display_voltage_v: "display_voltage_v", ac_display_current_a: "display_current_a", ac_display_power_w: "display_power_w",
  ac_display_apparent_va: "display_apparent_va", ac_display_power_factor: "display_power_factor", ac_energy_wh: "ac_energy_wh",
  ac_link_status: "link_status", ac_calibration_status: "calibration_status",
  cal_voltage_multiplier: "cal_voltage_multiplier", cal_current_multiplier: "cal_current_multiplier",
};

/**
 * One CSV, two independent circuits: every row is either a DC row (ESP8266 or demo)
 * or an AC row (ESP32 or AC simulation), identified by the `circuit` column; the other
 * circuit's columns are left blank so readings are never paired across circuits.
 * Callers pass either live sensor rows or simulated rows, never both in one file.
 * Blank cells = unavailable. PV readings are blank when solar_available is false.
 * Quality flags: measurement_quality, battery_soc_estimated, temperature_simulated,
 * load_estimated, ac_calibrated (as received), ac_calibration_status, data_source.
 */
export function toCsv(rows: Sample[], acRows: AcRow[] = []): string {
  const header = [...CSV_COLUMNS, ...AC_CSV_COLUMNS, ...AC_EXTRA_COLUMNS, "battery_soc_estimated", "measurement_quality", "data_source", "circuit"].join(",");
  const blankAc = [...AC_CSV_COLUMNS, ...AC_EXTRA_COLUMNS].map(() => "");
  const dc = rows.map((r) => {
    const solarOk = r.solar_available !== false;
    const values = CSV_COLUMNS.map((k) => {
      if (!solarOk && (k === "pv_voltage_v" || k === "pv_current_a" || k === "pv_power_w")) return "";
      return cell(r[k]);
    });
    values.push(...blankAc);
    values.push(r.battery_soc === null ? "" : "true");
    values.push(r.source === "sensor" ? "sensor_measurement" : "simulated");
    values.push(r.source === "sensor" ? "esp8266_sensor" : "browser_simulation");
    values.push("dc");
    return { t: r.timestamp, line: values.join(",") };
  });
  const ac = acRows.map((r) => {
    const values = CSV_COLUMNS.map((k) => (k === "timestamp" ? cell(r.timestamp) : ""));
    values.push(...AC_CSV_COLUMNS.map((k) => cell(r[k])));
    values.push(...AC_EXTRA_COLUMNS.map((k) => cell(r[AC_EXTRA_FIELDS[k]])));
    values.push("", r.measurement_quality, r.source === "sensor" ? "esp32_sensor" : "browser_simulation", "ac");
    return { t: r.timestamp, line: values.join(",") };
  });
  const lines = [...dc, ...ac].sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0)).map((x) => x.line);
  return [header, ...lines].join("\n");
}
