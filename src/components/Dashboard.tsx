"use client";
import { useEffect, useRef, useState } from "react";
import { MotionConfig, motion } from "motion/react";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine } from "recharts";
import Nav from "./Nav";
import History, { Flow } from "./History";
import { Section, Panel, PanelTitle, axisProps } from "./ui";
import { useSerialLink } from "@/lib/useSerialLink";
import { useRecorder } from "@/lib/useRecorder";
import { DATASETS, DatasetKey, INTERVAL_OPTIONS, MAX_SAMPLE_OPTIONS, ImportedDataset, importSyntheticCsv } from "@/lib/recorder";
import {
  Sample, JsonStream, parsePacket, batteryState, isLowBattery, isOverCurrent, deriveRecommendation,
  classifyRecommendation, energyTotals, EMS_STATES, EmsKey, NOMINAL_CAPACITY_WH, MAX_CHARGE_CURRENT_A,
  LOW_BATTERY_VOLTAGE_V, LOW_BATTERY_SOC, AcRow, AcSimState, AcCalibration, parseAcPacket, parseLenientJson,
  acRowFromSensor, acSimRow, validateCalibration, loadCalibration, saveCalibration, DEFAULT_CALIBRATION, AC_RATED_POWER_W,
} from "@/lib/telemetry";

const C = { solar: "#e89f00", battery: "#16a672", grid: "#2f7be0", pred: "#6a55e0", alert: "#e04848", warn: "#eb6834", sim: "#b3a6ff", off: "#7d8ba0" };
const MAX_ROWS = 3600; // live display buffer (energy integration, calibration) — CSV data comes only from the recorder
const CHART_ROWS = 120; // rolling window for live graphs
const STALE_MS = 5000;
const f = (v: number | null | undefined, d: number, u: string) => (v === null || v === undefined ? "—" : `${v.toFixed(d)}${u ? ` ${u}` : ""}`);
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour12: false });

/* ---------- Simulated DC demo (browser only, never mixed with sensor data) ---------- */
type DemoState = { soc: number; consumed: number; solar: number; last: number };
const newDemo = (): DemoState => ({ soc: 80, consumed: 0, solar: 0, last: 0 });
function demoSample(sun: number, bulb: boolean, d: DemoState): Sample {
  const now = Date.now();
  const dt = d.last ? Math.min(5, (now - d.last) / 1000) : 1;
  d.last = now;
  const t = now / 1000;
  const pvW = Math.max(0, Math.min(12, (sun / 100) * 12 * (0.95 + 0.05 * Math.sin(t / 7))));
  const load = bulb ? 5 : 0;
  const current = (pvW * 0.85 - load - 0.15) / 12.6;
  const voltage = 11.9 + 0.9 * (d.soc / 100) + current * 0.15;
  const power = voltage * current;
  d.soc = Math.min(100, Math.max(0, d.soc + ((power * dt) / 3600 / NOMINAL_CAPACITY_WH) * 100));
  d.consumed += (load * dt) / 3600;
  d.solar += (pvW * dt) / 3600;
  const s: Sample = {
    timestamp: new Date(now).toISOString(),
    battery_voltage_v: voltage, battery_current_a: current, battery_power_w: power,
    battery_soc: d.soc, battery_capacity_wh: NOMINAL_CAPACITY_WH,
    pv_voltage_v: sun > 0 ? 17 : 0, pv_current_a: sun > 0 ? pvW / 17 : 0, pv_power_w: pvW, solar_available: sun > 0,
    load_power_w: load, load_estimated: true, temperature_c: 25, temperature_simulated: true,
    battery_status: null, ems_recommendation: null, energy_consumed_wh: d.consumed, solar_energy_wh: d.solar,
    source: "simulated", soc_origin: "simulation",
  };
  s.battery_status = batteryState(s);
  s.ems_recommendation = deriveRecommendation(s);
  return s;
}

/* ---------- Small UI pieces ---------- */
type Tone = "measured" | "estimated" | "simulated" | "pending" | "demo" | "info";
const TAG: Record<Tone, string> = {
  measured: "bg-battery/15 text-battery",
  estimated: "bg-solar/15 text-solar",
  simulated: "bg-pred/25 text-[#b3a6ff]",
  pending: "bg-white/10 text-white/60",
  demo: "bg-white/10 text-white/70",
  info: "bg-grid/20 text-[#8dbaf5]",
};
function Tag({ tone, children }: { tone: Tone; children: string }) {
  return <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${TAG[tone]}`}>{children}</span>;
}
type CardProps = { label: string; value: string; sub?: string; tag?: [Tone, string]; accent?: string };
function Card({ label, value, sub, tag, accent }: CardProps) {
  return (
    <div className="rounded-xl bg-night3 p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm text-white/60">{label}</p>
        {tag && <Tag tone={tag[0]}>{tag[1]}</Tag>}
      </div>
      <p className="mt-2 font-mono text-xl text-white" style={accent ? { color: accent } : undefined}>{value}</p>
      {sub && <p className="mt-1 text-xs leading-snug text-white/50">{sub}</p>}
    </div>
  );
}

function SocGauge({ s }: { s: Sample | undefined }) {
  const soc = s?.battery_soc ?? null;
  const cap = s?.battery_capacity_wh ?? NOMINAL_CAPACITY_WH;
  const color = soc === null ? "#a9b6c8" : soc <= LOW_BATTERY_SOC ? C.alert : soc <= 50 ? C.solar : C.battery;
  const origin = s?.soc_origin === "firmware" ? "Estimated by ESP8266 firmware"
    : s?.soc_origin === "voltage" ? "Estimated from battery voltage (packet had no SOC)"
    : s?.soc_origin === "simulation" ? "Simulated demo value" : "Waiting for data";
  return (
    <div className="rounded-xl bg-night3 p-5">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm text-white/60">Battery state of charge</p>
        <Tag tone="estimated">Estimated</Tag>
      </div>
      <p className="mt-2 font-display text-5xl font-semibold tnum" style={{ color }}>{soc === null ? "—" : `${soc.toFixed(1)}%`}</p>
      <div className="mt-4 flex items-center" aria-label={`Estimated SOC ${soc?.toFixed(0) ?? "unknown"} percent`}>
        <div className="relative h-11 flex-1 rounded-lg border-2 border-white/25 p-1">
          <div className="h-full rounded-[5px] transition-[width,background-color] duration-700" style={{ width: `${soc ?? 0}%`, background: color }} />
          <div className="absolute inset-y-1 w-px bg-white/40" style={{ left: `${LOW_BATTERY_SOC}%` }} />
        </div>
        <div className="ml-1 h-4 w-1.5 rounded-r bg-white/25" />
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-white/40"><span>0%</span><span>{LOW_BATTERY_SOC}% low-battery mark</span><span>100%</span></div>
      <p className="mt-3 text-sm text-white/70">
        {soc === null ? "—" : `≈ ${((soc / 100) * cap).toFixed(1)} Wh`} of {cap.toFixed(0)} Wh nominal
      </p>
      <p className="mt-1 text-xs text-white/50">{origin}</p>
    </div>
  );
}

function EmsPanel({ s, live, staleAt }: { s: Sample | undefined; live: boolean; staleAt: string | null }) {
  const fromFirmware = live && !!s?.ems_recommendation;
  const rec = s ? s.ems_recommendation ?? deriveRecommendation(s) : null;
  const key: EmsKey | null = classifyRecommendation(rec);
  const active = EMS_STATES.find((x) => x.key === key);
  const low = isLowBattery(s), over = isOverCurrent(s);
  const source = !s ? "" : !live ? "Demo logic (same rules as firmware)" : fromFirmware ? "Live from ESP8266 firmware" : "Dashboard rules (packet had no recommendation)";
  return (
    <div className="rounded-xl bg-night3 p-5" style={{ borderLeft: `4px solid ${active?.color ?? "#33445e"}` }}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-sm text-white/60">Energy Management System</p>
        <Tag tone="info">Advisory</Tag>
      </div>
      <p className={`mt-2 font-display text-3xl font-semibold ${staleAt ? "opacity-50" : ""}`} style={{ color: active?.color ?? "white" }}>{rec ?? "Waiting for data"}</p>
      <p className="mt-1 text-sm text-white/60">{active ? `State: ${active.state}` : rec ? "Unrecognised recommendation — shown as received" : ""}{source && ` · ${source}`}</p>
      {staleAt && <p className="mt-1 text-xs text-solar">Stale — based on the last reading at {staleAt}; not a live recommendation.</p>}
      {low && (
        <div className="mt-3 rounded-lg bg-alert/15 px-3 py-2 text-sm text-[#ff9b9b]" role="alert">
          ⚠ Low battery — voltage ≤ {LOW_BATTERY_VOLTAGE_V} V or estimated SOC ≤ {LOW_BATTERY_SOC}% ({f(s?.battery_voltage_v, 2, "V")}, {f(s?.battery_soc, 0, "%")}). Reduce load.
        </div>
      )}
      {over && (
        <div className="mt-3 rounded-lg bg-case2/15 px-3 py-2 text-sm text-[#ffb08a]" role="alert">
          ⚠ Charging current {f(s?.battery_current_a, 2, "A")} exceeds the {MAX_CHARGE_CURRENT_A} A maximum.
        </div>
      )}
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {EMS_STATES.map((x) => (
          <div key={x.key} className={`rounded-lg px-3 py-2 text-xs ring-1 transition-colors ${x.key === key ? "bg-white/10 ring-white/30" : "ring-white/5 opacity-55"}`}>
            <span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: x.color }} />
            <b className="font-medium text-white">{x.state}</b>
            <span className="block text-white/60">{x.action}</span>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-white/50">Recommendations are advisory only. They do not physically switch, connect or disconnect any circuit.</p>
    </div>
  );
}

/* ---------- Separate AC circuit ---------- */
type LinkApi = ReturnType<typeof useSerialLink>;
type LinkStats = { packets: number; skipped: number; last: number };
export type AcMode = "disconnected" | "diagnostic" | "live" | "simulated";
const AC_MODE: Record<AcMode, { label: string; color: string }> = {
  disconnected: { label: "Disconnected", color: C.off },
  diagnostic: { label: "Connected — Diagnostic Mode", color: C.solar },
  live: { label: "Connected — Live Monitoring", color: C.battery },
  simulated: { label: "Simulated Mode", color: C.sim },
};
const inputCls = "mt-1 w-full rounded-lg bg-night px-3 py-2 font-mono text-sm text-white ring-1 ring-white/15 focus:ring-white/40";
const smallBtn = "rounded-full bg-white/10 px-4 py-2 text-sm hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-40";

function CalibrationSettings({ cal, onCal, link, liveRows }: { cal: AcCalibration; onCal: (c: AcCalibration) => void; link: LinkApi; liveRows: AcRow[] }) {
  const [draft, setDraft] = useState({ vMult: String(cal.vMult), iMult: String(cal.iMult), vFloor: String(cal.vFloor), iFloor: String(cal.iFloor) });
  const [ref, setRef] = useState({ v: "", i: "" });
  const [msg, setMsg] = useState<{ ok: boolean; lines: string[] } | null>(null);
  useEffect(() => { setDraft({ vMult: String(cal.vMult), iMult: String(cal.iMult), vFloor: String(cal.vFloor), iFloor: String(cal.iFloor) }); }, [cal]);

  function save() {
    const n = { vMult: Number(draft.vMult), iMult: Number(draft.iMult), vFloor: Number(draft.vFloor), iFloor: Number(draft.iFloor) };
    const errs: string[] = [];
    if (!(n.vMult > 0) || !Number.isFinite(n.vMult)) errs.push("Voltage multiplier must be a positive number.");
    if (!(n.iMult > 0) || !Number.isFinite(n.iMult)) errs.push("Current multiplier must be a positive number.");
    if (!(n.vFloor >= 0) || !Number.isFinite(n.vFloor)) errs.push("Voltage noise floor must be 0 or more.");
    if (!(n.iFloor >= 0) || !Number.isFinite(n.iFloor)) errs.push("Current noise floor must be 0 or more.");
    if (errs.length) { setMsg({ ok: false, lines: errs }); return; }
    const multipliersChanged = n.vMult !== cal.vMult || n.iMult !== cal.iMult;
    onCal({ ...cal, ...n, ...(multipliersChanged ? { complete: false, validatedAt: null, refV: null, refI: null } : {}) });
    setMsg({ ok: true, lines: [multipliersChanged ? "Saved locally. Manually entered multipliers are not validated, so calibration is marked incomplete." : "Saved locally."] });
  }

  function validate() {
    const cutoff = Date.now() - 10000;
    const recent = liveRows.filter((r) => Date.parse(r.timestamp) >= cutoff);
    const res = validateCalibration(Number(ref.v), Number(ref.i), recent);
    if (!res.ok) { setMsg({ ok: false, lines: res.errors }); return; }
    onCal({ ...cal, ...res.cal, complete: true, validatedAt: new Date().toISOString(), refV: Number(ref.v), refI: Number(ref.i) });
    setMsg({ ok: true, lines: [`Calibration complete: voltage ×${res.cal.vMult.toPrecision(4)} (${res.cal.vBase}), current ×${res.cal.iMult.toPrecision(4)} (${res.cal.iBase}), from ESP32 averages ${res.avgV.toPrecision(4)} / ${res.avgI.toPrecision(4)}.`] });
  }

  return (
    <details className="mt-3 rounded-xl bg-white/5 px-4 py-3">
      <summary className="cursor-pointer select-none text-sm text-white/80">
        Calibration settings <span className="text-white/40">· {cal.complete ? `complete (validated ${new Date(cal.validatedAt ?? "").toLocaleString()})` : "not complete"}</span>
      </summary>
      <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
        {([["vMult", "Voltage multiplier"], ["iMult", "Current multiplier"], ["vFloor", "Voltage noise floor (V)"], ["iFloor", "Current noise floor (A)"]] as const).map(([k, label]) => (
          <label key={k} className="text-xs text-white/60">{label}
            <input className={inputCls} inputMode="decimal" value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
          </label>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button className={smallBtn} onClick={save}>Save settings locally</button>
        <button className={smallBtn} onClick={() => { onCal(DEFAULT_CALIBRATION); setMsg({ ok: true, lines: ["Calibration reset to defaults."] }); }}>Reset</button>
      </div>
      <div className="mt-4 border-t border-white/10 pt-3">
        <p className="text-xs text-white/60">Mark calibration complete from genuine reference readings: switch the bulb ON, measure mains voltage with a multimeter and the bulb current with a meter, then validate against the last 10 s of ESP32 readings.</p>
        <div className="mt-2 grid grid-cols-2 gap-3 md:grid-cols-4">
          <label className="text-xs text-white/60">Reference voltage (V)<input className={inputCls} inputMode="decimal" placeholder="e.g. 228.4" value={ref.v} onChange={(e) => setRef({ ...ref, v: e.target.value })} /></label>
          <label className="text-xs text-white/60">Reference current (A)<input className={inputCls} inputMode="decimal" placeholder="e.g. 0.066" value={ref.i} onChange={(e) => setRef({ ...ref, i: e.target.value })} /></label>
          <div className="col-span-2 flex items-end">
            <button className={smallBtn} disabled={link.state !== "open" || !ref.v || !ref.i} onClick={validate}>Validate &amp; mark complete</button>
          </div>
        </div>
        {link.state !== "open" && <p className="mt-2 text-xs text-white/40">Requires a connected ESP32 (not available in simulation).</p>}
      </div>
      {msg && (
        <ul className={`mt-3 space-y-1 text-xs ${msg.ok ? "text-battery" : "text-[#ff9b9b]"}`}>{msg.lines.map((l) => <li key={l}>{l}</li>)}</ul>
      )}
      <p className="mt-3 text-[11px] text-white/40">Stored in this browser only. Dashboard calibration never changes the ac_calibrated flag sent by the ESP32, and is ignored when the firmware already reports ac_calibrated = true.</p>
    </details>
  );
}

function AcPanel(props: {
  link: LinkApi; mode: AcMode; row: AcRow | undefined; lastLive: AcRow | undefined; fresh: boolean; stats: LinkStats; now: number; raw: string | null;
  sim: boolean; setSim: (v: boolean) => void; simBulb: boolean; setSimBulb: (v: boolean) => void;
  cal: AcCalibration; onCal: (c: AcCalibration) => void; liveRows: AcRow[];
}) {
  const { link, mode, row, lastLive, fresh, stats, now, raw, sim, setSim, simBulb, setSimBulb, cal, onCal, liveRows } = props;
  const m = AC_MODE[mode];
  const stale = !!row && row.source === "sensor" && !fresh;
  const detail = link.state === "open"
    ? (stats.packets === 0 ? "Waiting for ESP32 AC JSON at 115200 baud"
      : fresh ? `Receiving ESP32 ${mode === "live" ? "live" : "diagnostic"} data · ${stats.packets} packets`
      : `No AC data for ${Math.max(0, Math.round((now - stats.last) / 1000))} s`)
      + (stats.skipped ? ` · ${stats.skipped} non-AC lines skipped${stats.packets === 0 ? " (is this the ESP32 port?)" : ""}` : "")
    : link.state === "connecting" ? "Connecting…"
    : link.message === "Not connected" ? (sim ? "ESP32 not connected — simulation running" : "ESP32 not connected") : link.message;

  const note = !row ? (link.active ? "Waiting for the first ESP32 packet." : "Connect the ESP32, or start the AC simulation for a demonstration.")
    : row.source === "simulated" ? `Simulated readings — ${220} V nominal supply and ${AC_RATED_POWER_W} W resistive bulb. Not measured; exported only in the simulated CSV.`
    : row.calibration_status === "firmware_calibrated" ? "Readings are calibrated by the ESP32 firmware (ac_calibrated = true)."
    : row.calibration_status === "dashboard_calibrated" ? `Readings are calibrated in this dashboard against reference meter readings (${cal.refV} V, ${cal.refI} A). ESP32 flag ac_calibrated = ${String(row.ac_calibrated)} is unchanged.`
    : `Readings are diagnostic estimates (ESP32 reports ac_calibrated = ${row.ac_calibrated === null ? "not sent" : String(row.ac_calibrated)}) — not accurate mains measurements.`;

  const group: [Tone, string] | null = !row ? null
    : stale ? ["pending", `Stale — last reading ${timeOf(row.timestamp)}`]
    : row.measurement_quality === "simulated" ? ["simulated", "Simulated"]
    : row.measurement_quality === "calibrated_measurement" ? ["measured", "Calibrated measurements"]
    : ["estimated", "Diagnostic estimates"];

  const cards: CardProps[] = [
    { label: "AC voltage", value: f(row?.display_voltage_v, 1, "V") },
    { label: "AC current", value: f(row?.display_current_a, 3, "A") },
    { label: "Active power", value: f(row?.display_power_w, 2, "W") },
    { label: "Apparent power", value: f(row?.display_apparent_va, 2, "VA") },
    { label: "Power factor", value: f(row?.display_power_factor, 2, ""), sub: row && row.display_power_factor === null ? "Not available (e.g. no load)" : undefined },
    { label: "Grid status", value: row ? row.grid_status ?? "Unknown" : "—", sub: row && row.grid_status === null ? "Not reported by ESP32" : undefined },
    { label: "Bulb rated power", value: `${AC_RATED_POWER_W} W`, sub: "Nameplate rating, not a measurement", tag: ["info", "Rated"] },
    { label: "AC energy", value: f(row?.ac_energy_wh, 4, "Wh"), sub: row?.source === "simulated" ? "Simulated consumption" : row ? "Integrated from displayed power" : undefined },
  ];

  return (
    <div className="rounded-xl border border-dashed border-white/15 bg-night3/60 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-display text-lg text-white">Separate AC circuit</p>
          <p className="mt-1 text-sm text-white/60">ESP32 · ACS712 20 A · ZMPT101B · 220 V nominal · electrically independent of the DC system</p>
        </div>
        <span className="inline-flex items-center gap-2 rounded-full bg-white/5 px-3 py-1.5 text-xs font-medium ring-1 ring-white/10" style={{ color: m.color }} role="status">
          <span className="h-2 w-2 rounded-full" style={{ background: m.color }} />{m.label}
        </span>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {link.active ? (
          <button className="rounded-full bg-white px-5 py-2 text-sm font-medium text-night disabled:opacity-60" disabled={link.state !== "open"} onClick={link.disconnect}>
            {link.state === "connecting" ? "Connecting…" : link.state === "closing" ? "Disconnecting…" : "Disconnect ESP32 (AC)"}
          </button>
        ) : (
          <>
            <button className="rounded-full bg-white px-5 py-2 text-sm font-medium text-night" onClick={() => void (link.canReconnect ? link.reconnect() : link.connect())}>
              {link.canReconnect || lastLive ? "Reconnect ESP32 (AC)" : "Connect ESP32 (AC)"}
            </button>
            {link.canReconnect && <button className={smallBtn} onClick={() => void link.connect()}>Choose port…</button>}
          </>
        )}
        <button className={smallBtn} disabled={link.active} onClick={() => setSim(!sim)}>{sim ? "Stop AC simulation" : "Start AC simulation"}</button>
        {sim && <button className={smallBtn} onClick={() => setSimBulb(!simBulb)}>Simulated bulb: {simBulb ? "ON" : "OFF"}</button>}
      </div>
      <p className="mt-2 text-xs text-white/60">
        {detail}{lastLive && <span className="text-white/40"> · Last ESP32 reading {timeOf(lastLive.timestamp)}</span>}
      </p>
      {link.state === "open" && stats.packets === 0 && raw && (
        <p className="mt-1 break-all text-xs text-white/40">Last raw line: <code className="font-mono text-white/60">{raw}</code></p>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-white/60">{note}</p>
        {group && <Tag tone={group[0]}>{group[1]}</Tag>}
      </div>
      <div className={`mt-2 grid grid-cols-2 gap-3 md:grid-cols-4 ${stale ? "opacity-50" : ""}`}>
        {cards.map((c) => <Card key={c.label} {...c} />)}
      </div>

      <details className="mt-3 rounded-xl bg-white/5 px-4 py-3">
        <summary className="cursor-pointer select-none text-sm text-white/80">Sensor Diagnostics <span className="text-white/40">· offsets and raw RMS from the ESP32</span></summary>
        {row?.source === "sensor" ? (
          <div className={`mt-3 grid grid-cols-2 gap-3 md:grid-cols-4 ${stale ? "opacity-50" : ""}`}>
            <Card label="Voltage offset" value={f(row.voltage_offset_v, 4, "V")} sub="ZMPT101B zero offset" />
            <Card label="Current offset" value={f(row.current_offset_v, 4, "V")} sub="ACS712 zero offset" />
            <Card label="Raw voltage RMS" value={f(row.raw_voltage_rms, 4, "")} sub="Before calibration" />
            <Card label="Raw current RMS" value={f(row.raw_current_rms, 4, "")} sub="Before calibration" />
          </div>
        ) : (
          <p className="mt-2 text-xs text-white/50">{row ? "Not applicable to simulated readings." : "No ESP32 data yet."}</p>
        )}
      </details>

      <CalibrationSettings cal={cal} onCal={onCal} link={link} liveRows={liveRows} />
    </div>
  );
}

/* ---------- Explicit data recording & CSV export ---------- */
type RecorderApi = ReturnType<typeof useRecorder>;
const REC_STATUS = {
  idle: { label: "Not recording", color: C.off },
  recording: { label: "Recording", color: C.alert },
  paused: { label: "Paused", color: C.solar },
  stopped: { label: "Stopped", color: C.off },
} as const;
const hms = (ms: number) => {
  const t = Math.floor(ms / 1000);
  return [Math.floor(t / 3600), Math.floor((t % 3600) / 60), t % 60].map((n) => String(n).padStart(2, "0")).join(":");
};
const selectCls = "mt-1 block rounded-lg bg-night px-3 py-2 text-sm text-white ring-1 ring-white/15 disabled:opacity-50";

function RecorderPanel({ r, active, imported, onImported }: {
  r: RecorderApi; active: Record<DatasetKey, boolean>; imported: ImportedDataset | null; onImported: (d: ImportedDataset | null) => void;
}) {
  const { rec, now } = r;
  const [importMsg, setImportMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const st = REC_STATUS[rec.status];
  const running = rec.status === "recording" || rec.status === "paused";
  const total = rec.total();
  const recordingFrom = DATASETS.filter((d) => rec.selected[d.key] && active[d.key]).map((d) => d.label);

  function download(key: DatasetKey) {
    const d = DATASETS.find((x) => x.key === key)!;
    if (!rec.count(key)) return;
    const url = URL.createObjectURL(new Blob([rec.csv(key)], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `prototype-${d.file}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }
  function clearAll() {
    const parts = DATASETS.filter((d) => rec.count(d.key)).map((d) => `${d.label}: ${rec.count(d.key).toLocaleString()}`);
    if (!parts.length) return;
    if (window.confirm(`Delete all recorded samples?\n\n${parts.join("\n")}\n\nDownload anything you need first. This cannot be undone.`)) r.clear();
  }
  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { setImportMsg({ ok: false, text: "Not imported: files over 10 MB are not supported." }); return; }
    const res = importSyntheticCsv(await file.text(), file.name);
    if (!res.ok) { setImportMsg({ ok: false, text: res.error }); return; }
    onImported(res.dataset);
    setImportMsg({ ok: true, text: `Imported ${res.dataset.rows.toLocaleString()} synthetic rows (${res.dataset.dcRows.toLocaleString()} DC, ${res.dataset.acRows.toLocaleString()} AC). Shown in the charts below; never added to the recorded datasets.` });
  }

  const rowStatus = (k: DatasetKey) =>
    !rec.selected[k] ? "Not selected"
    : rec.count(k) >= rec.maxSamples ? "Limit reached"
    : rec.status === "recording" ? (active[k] ? "Recording" : "Waiting for source")
    : rec.status === "paused" ? "Paused"
    : active[k] ? "Source running" : "Source off";

  return (
    <div id="recorder" className="scroll-mt-24 rounded-xl bg-night3/60 p-5 ring-1 ring-white/10">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-display text-lg text-white">Data recording &amp; CSV export</p>
          <p className="mt-1 text-sm text-white/60">Off by default. The dashboard keeps updating; samples are added to a dataset only while recording.</p>
        </div>
        <span className="inline-flex items-center gap-2 rounded-full bg-white/5 px-3 py-1.5 text-xs font-medium ring-1 ring-white/10" style={{ color: st.color }} role="status">
          <span className={`h-2 w-2 rounded-full ${rec.status === "recording" ? "animate-pulse" : ""}`} style={{ background: st.color }} />{st.label}
        </span>
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        {!running && <button className="rounded-full bg-white px-5 py-2 text-sm font-medium text-night" onClick={r.start}>Start recording</button>}
        {rec.status === "recording" && <button className="rounded-full bg-white px-5 py-2 text-sm font-medium text-night" onClick={r.pause}>Pause recording</button>}
        {rec.status === "paused" && <button className="rounded-full bg-white px-5 py-2 text-sm font-medium text-night" onClick={r.resume}>Resume recording</button>}
        {running && <button className={smallBtn} onClick={r.stop}>Stop recording</button>}
        <button className={smallBtn} disabled={running || !total} onClick={clearAll} title={running ? "Stop recording first" : undefined}>Clear recorded data…</button>
        <label className="text-xs text-white/60">Interval
          <select className={selectCls} disabled={!rec.editable} value={rec.intervalS} onChange={(e) => r.setIntervalS(Number(e.target.value))}>
            {INTERVAL_OPTIONS.map((s) => <option key={s} value={s}>{s === 60 ? "60 s (1 min)" : `${s} s`}</option>)}
          </select>
        </label>
        <label className="text-xs text-white/60">Max samples per dataset
          <select className={selectCls} disabled={!rec.editable} value={rec.maxSamples} onChange={(e) => r.setMax(Number(e.target.value))}>
            {MAX_SAMPLE_OPTIONS.map((n) => <option key={n} value={n}>{n.toLocaleString()}</option>)}
          </select>
        </label>
      </div>

      <div className="mt-3 grid gap-x-6 gap-y-1 text-sm text-white/70 sm:grid-cols-3">
        <p>Duration <b className="font-mono text-white">{hms(rec.durationMs(now))}</b></p>
        <p>Recorded samples <b className="font-mono text-white">{total.toLocaleString()}</b></p>
        <p>Source{recordingFrom.length === 1 ? "" : "s"} <b className="text-white">{rec.status === "recording" || rec.status === "paused" ? (recordingFrom.join(" + ") || "none active") : "—"}</b></p>
      </div>
      {rec.message && <p className="mt-2 rounded-lg bg-solar/10 px-3 py-2 text-sm text-solar" role="alert">{rec.message}</p>}
      {!rec.editable && <p className="mt-1 text-xs text-white/40">Interval, limit and dataset selection can be changed after stopping.</p>}

      <div className="mt-4 grid gap-2">
        {DATASETS.map((d) => {
          const n = rec.count(d.key), rs = rowStatus(d.key);
          return (
            <div key={d.key} className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg bg-white/5 px-3 py-2.5">
              <label className="flex min-w-[220px] flex-1 items-start gap-2.5">
                <input type="checkbox" className="mt-1 accent-solar" checked={rec.selected[d.key]} disabled={!rec.editable} onChange={() => r.toggle(d.key)} />
                <span>
                  <span className="mr-2 text-sm text-white">{d.label}</span>
                  <Tag tone={d.source === "sensor" ? (d.circuit === "ac" ? "estimated" : "measured") : "simulated"}>{d.source === "sensor" ? (d.circuit === "ac" ? "Live · diagnostic/calibrated" : "Live · measured") : "Simulated"}</Tag>
                  <span className="block text-xs text-white/45">{d.note}</span>
                </span>
              </label>
              <span className={`w-36 text-xs ${rs === "Recording" ? "text-[#ff9b9b]" : rs === "Limit reached" ? "text-solar" : "text-white/50"}`}>{rs}</span>
              <span className="w-32 font-mono text-sm text-white tnum">{n.toLocaleString()} <span className="text-white/40">/ {rec.maxSamples.toLocaleString()}</span></span>
              <button className={smallBtn} disabled={!n} onClick={() => download(d.key)}>Download CSV</button>
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-white/45">
        One reading per interval, taken only from real new readings — gaps stay gaps and nothing is generated to fill them. Recording stops automatically when any dataset reaches the limit.
        Each dataset exports to its own file, so live and simulated data never share a CSV. Recorded data is kept after a board disconnects or recording stops, until you clear it or reload the page.
      </p>

      <details className="mt-3 rounded-xl bg-white/5 px-4 py-3">
        <summary className="cursor-pointer select-none text-sm text-white/80">
          Import synthetic test CSV <span className="text-white/40">· optional{imported ? ` · loaded: ${imported.name}` : ""}</span>
        </summary>
        <p className="mt-2 text-xs text-white/60">
          For testing the charts with prepared data. The file needs a <code className="font-mono">data_source</code> column and every row must be labelled synthetic
          (synthetic, synthetic_test, browser_simulation or simulated). Files containing sensor-labelled rows are rejected. Imported data is kept apart from all recorded datasets and is never exported as measured.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label className={`${smallBtn} cursor-pointer`}>
            Choose CSV file…<input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => void onFile(e)} />
          </label>
          {imported && <button className={smallBtn} onClick={() => { onImported(null); setImportMsg(null); }}>Remove imported data</button>}
        </div>
        {imported && (
          <p className="mt-2 text-xs text-white/60">
            <Tag tone="simulated">Synthetic test data</Tag> {imported.name} · {imported.rows.toLocaleString()} rows · labels {imported.labels.join(", ")}
            {imported.first && ` · ${imported.first} → ${imported.last}`}
          </p>
        )}
        {importMsg && <p className={`mt-2 text-xs ${importMsg.ok ? "text-battery" : "text-[#ff9b9b]"}`}>{importMsg.text}</p>}
      </details>
    </div>
  );
}

function MiniChart({ title, data, dataKey, color, unit, limit: refLine, domain, note }: {
  title: string; data: object[]; dataKey: string; color: string; unit: string;
  limit?: { y: number; label: string }; domain?: [number | "auto", number | "auto"]; note?: string;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="text-sm font-semibold text-ink">{title} <span className="font-normal text-muted">({unit})</span></h4>
        {note && <span className="text-xs text-muted">{note}</span>}
      </div>
      <div className="mt-2 h-44">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="#e3e8ef" vertical={false} />
            <XAxis dataKey="t" {...axisProps} minTickGap={48} />
            <YAxis {...axisProps} width={52} domain={domain ?? ["auto", "auto"]} />
            <Tooltip formatter={(v) => (typeof v === "number" ? `${v.toFixed(3)} ${unit}` : "—")} />
            {refLine && <ReferenceLine y={refLine.y} stroke={C.alert} strokeDasharray="4 4" ifOverflow="extendDomain" label={{ value: refLine.label, fill: C.alert, fontSize: 11, position: "insideTopRight" }} />}
            <Line dataKey={dataKey} name={title} stroke={color} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/* ---------- Page ---------- */
export default function Dashboard() {
  const [sun, setSun] = useState(70), [bulb, setBulb] = useState(true);
  const [mode, setMode] = useState<"demo" | "live">("demo");
  const [liveRows, setLiveRows] = useState<Sample[]>([]); // ESP8266 sensor data (kept after disconnect)
  const [demoRows, setDemoRows] = useState<Sample[]>([]); // browser simulation only
  const [stats, setStats] = useState({ packets: 0, skipped: 0, last: 0 });
  const [now, setNow] = useState(0);
  const [tariff] = useState(7);
  const demo = useRef<DemoState>(newDemo());
  const stream = useRef(new JsonStream());
  const recorder = useRecorder();
  const { offer } = recorder;
  const [imported, setImported] = useState<ImportedDataset | null>(null);
  const [chartView, setChartView] = useState<"session" | "imported">("session");

  const esp = useSerialLink("ESP8266", {
    onOpen: () => {
      stream.current.reset();
      setStats({ packets: 0, skipped: 0, last: 0 });
      setMode("live");
    },
    onText: (text) => {
      const fresh: Sample[] = [];
      let skipped = 0;
      for (const obj of stream.current.push(text)) {
        try {
          const s = parsePacket(JSON.parse(obj));
          if (s) fresh.push(s); else skipped++;
        } catch { skipped++; }
      }
      for (const x of fresh) offer("dc_live", x);
      if (fresh.length) setLiveRows((r) => [...r, ...fresh].slice(-MAX_ROWS));
      if (fresh.length || skipped) setStats((st) => ({ packets: st.packets + fresh.length, skipped: st.skipped + skipped, last: fresh.length ? Date.now() : st.last }));
    },
  });

  /* Independent ESP32 AC link: own port, own reader, own rows. Never touches DC state. */
  const [cal, setCal] = useState<AcCalibration>(DEFAULT_CALIBRATION);
  const calRef = useRef(cal);
  useEffect(() => { const c = loadCalibration(); calRef.current = c; setCal(c); }, []);
  const updateCal = (c: AcCalibration) => { calRef.current = c; setCal(c); saveCalibration(c); };

  const [acLive, setAcLive] = useState<AcRow[]>([]);
  const [acStats, setAcStats] = useState({ packets: 0, skipped: 0, last: 0 });
  const [acRaw, setAcRaw] = useState<string | null>(null);
  const acStream = useRef(new JsonStream());
  const acLineBuf = useRef("");
  const acEnergy = useRef({ wh: 0, lastTs: 0 });
  const integrateAc = (p: number | null, ts: string) => {
    const t = Date.parse(ts), e = acEnergy.current;
    if (e.lastTs && p !== null) { const dt = (t - e.lastTs) / 1000; if (dt > 0 && dt < 5) e.wh += (p * dt) / 3600; }
    e.lastTs = t;
    return e.wh;
  };
  const [acSim, setAcSim] = useState(false);
  const [acSimBulb, setAcSimBulb] = useState(true);
  const [acSimRows, setAcSimRows] = useState<AcRow[]>([]);
  const acSimState = useRef<AcSimState>({ energy: 0, last: 0 });

  const ac = useSerialLink("ESP32 (AC)", {
    onOpen: () => {
      acStream.current.reset();
      acLineBuf.current = "";
      acEnergy.current.lastTs = 0; // do not integrate across a gap
      setAcStats({ packets: 0, skipped: 0, last: 0 });
      setAcRaw(null);
      setAcSim(false); // real hardware takes over from the simulation
    },
    onText: (text) => {
      acLineBuf.current += text;
      const lines = acLineBuf.current.split(/\r?\n/);
      acLineBuf.current = (lines.pop() ?? "").slice(-2048);
      const lastLine = lines.map((l) => l.trim()).filter(Boolean).pop();
      if (lastLine) setAcRaw(lastLine.slice(0, 240));
      const fresh: AcRow[] = [];
      let skipped = 0;
      for (const obj of acStream.current.push(text)) {
        try {
          const a = parseAcPacket(parseLenientJson(obj));
          if (a) fresh.push(acRowFromSensor(a, calRef.current, integrateAc)); else skipped++;
        } catch { skipped++; }
      }
      for (const x of fresh) offer("ac_live", x);
      if (fresh.length) setAcLive((r) => [...r, ...fresh].slice(-MAX_ROWS));
      if (fresh.length || skipped) setAcStats((st) => ({ packets: st.packets + fresh.length, skipped: st.skipped + skipped, last: fresh.length ? Date.now() : st.last }));
    },
  });

  // Simulated DC demo ticks (only in demo mode). The display buffer is a rolling chart window;
  // rows reach a dataset only through offer(), which ignores them unless recording is on.
  useEffect(() => {
    if (mode !== "demo") return;
    const add = () => { const s = demoSample(sun, bulb, demo.current); offer("dc_sim", s); setDemoRows((r) => [...r, s].slice(-CHART_ROWS)); };
    add();
    const id = setInterval(add, 1000);
    return () => clearInterval(id);
  }, [sun, bulb, mode, offer]);

  // Simulated AC ticks (only while AC simulation is on).
  useEffect(() => {
    if (!acSim) return;
    const simState = acSimState.current;
    const add = () => { const r = acSimRow(acSimBulb, simState); offer("ac_sim", r); setAcSimRows((rows) => [...rows, r].slice(-CHART_ROWS)); };
    add();
    const id = setInterval(add, 1000);
    return () => { clearInterval(id); simState.last = 0; };
  }, [acSim, acSimBulb, offer]);

  // Clock for stale-data detection while a link is open.
  useEffect(() => {
    if (esp.state !== "open" && ac.state !== "open") return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [esp.state, ac.state]);

  /* ----- DC derived state ----- */
  const live = mode === "live";
  const rows = live ? liveRows : demoRows;
  const s = rows[rows.length - 1];
  const st = batteryState(s);
  const solarOk = s?.solar_available !== false;
  const totals = energyTotals(rows);
  const dcFresh = esp.state === "open" && stats.last > 0 && now - stats.last <= STALE_MS;
  const dcStale = live && !!s && !dcFresh;
  const measured: [Tone, string] = !live ? ["demo", "Demo"] : dcStale ? ["pending", "Stale"] : ["measured", "Measured"];
  const low = isLowBattery(s), over = isOverCurrent(s);
  const lastDcTime = live && s ? timeOf(s.timestamp) : null;

  const status = esp.state === "open"
    ? (stats.packets === 0 ? "Connected — waiting for ESP8266 JSON at 115200 baud"
      : !dcFresh ? `No data for ${Math.round((now - stats.last) / 1000)} s — check the USB cable and firmware`
      : `Receiving sensor data · ${stats.packets} packets`) + (stats.skipped ? ` · ${stats.skipped} malformed/other lines skipped` : "")
    : esp.state === "connecting" ? "Connecting…"
    : esp.message === "Not connected" ? (live ? "Not connected" : "No hardware connected — showing simulated demo") : esp.message;

  /* ----- AC derived state ----- */
  const acLiveLast = acLive[acLive.length - 1];
  const acFresh = ac.state === "open" && acStats.last > 0 && now - acStats.last <= STALE_MS;
  const acCalibrated = acLiveLast?.ac_calibrated === true || cal.complete;
  const acMode: AcMode = ac.active ? (acCalibrated ? "live" : "diagnostic") : acSim ? "simulated" : "disconnected";
  const acRow = acMode === "simulated" ? acSimRows[acSimRows.length - 1] : acLiveLast;
  const flowAc = ac.active
    ? {
        title: "ESP32 AC Monitoring", lines: ["220 V nominal supply", `${AC_RATED_POWER_W} W rated bulb`, "ACS712 + ZMPT101B"],
        status: ac.state !== "open" ? "Connecting…" : acFresh ? (acCalibrated ? "Receiving live data" : "Receiving diagnostics") : acStats.packets ? "No recent data" : "Waiting for data",
        color: acFresh ? (acCalibrated ? C.battery : C.solar) : "#a9b6c8",
      }
    : acSim
      ? { title: "AC simulation", lines: ["220 V nominal supply", `${AC_RATED_POWER_W} W bulb · ${acSimBulb ? "ON" : "OFF"}`, "Simulated — not measured"], status: "Simulated Mode", color: C.sim }
      : { title: "Separate AC circuit", lines: ["Independent of DC system", "ACS712 + ZMPT101B"], status: "ESP32 Offline", color: C.off };

  function returnToDemo() {
    demo.current = newDemo();
    setDemoRows([]);
    setStats({ packets: 0, skipped: 0, last: 0 });
    setMode("demo");
  }

  const showImported = chartView === "imported" && !!imported;
  const series = showImported ? imported.series : rows.slice(-CHART_ROWS).map((r) => ({
    t: timeOf(r.timestamp),
    voltage: r.battery_voltage_v, current: r.battery_current_a, soc: r.battery_soc,
    solar: r.solar_available === false ? null : r.pv_power_w, load: r.load_power_w,
  }));
  const sourceActive: Record<DatasetKey, boolean> = { dc_live: esp.state === "open", ac_live: ac.state === "open", dc_sim: !live, ac_sim: acSim };

  const solarCard = (label: string, v: number | null | undefined, d: number, u: string): [string, string, string | undefined, [Tone, string]] =>
    solarOk ? [label, f(v, d, u), undefined, measured] : [label, "Unavailable", "Verification pending — not shown as measured", ["pending", "Pending"]];

  const cards: CardProps[] = [
    { label: "Battery voltage", value: f(s?.battery_voltage_v, 3, "V"), sub: `Low-battery threshold ${LOW_BATTERY_VOLTAGE_V} V`, tag: measured, accent: low ? C.alert : undefined },
    { label: "Battery current", value: f(s?.battery_current_a, 4, "A"), sub: `+ charging · − discharging · max ${MAX_CHARGE_CURRENT_A} A`, tag: measured, accent: over ? C.warn : undefined },
    { label: "Signed battery power", value: f(s?.battery_power_w, 3, "W"), sub: "+ into battery · − out of battery", tag: measured },
    { label: "Battery nominal capacity", value: f(s?.battery_capacity_wh ?? NOMINAL_CAPACITY_WH, 1, "Wh"), sub: "12 V × 5.5 Ah (2 × 6 V in series)", tag: ["info", "Nominal"] },
    ...[solarCard("Solar voltage", s?.pv_voltage_v, 3, "V"), solarCard("Solar current", s?.pv_current_a, 4, "A"), solarCard("Solar generation", s?.pv_power_w, 3, "W")]
      .map(([label, value, sub, tag]) => ({ label, value, sub: sub ?? (label === "Solar generation" ? "50 W rated panel" : undefined), tag })),
    {
      label: "Estimated DC system consumption", value: f(s?.load_power_w, 3, "W"),
      sub: s && s.load_power_w === null ? "Not reported by firmware" : s?.load_estimated ? (live ? "Estimated by firmware — not directly measured" : "Virtual bulb in demo") : "12 V DC bulb via controller LOAD",
      tag: dcStale ? measured : s?.load_estimated ? ["estimated", "Estimated"] : measured,
    },
    {
      label: "Temperature", value: f(s?.temperature_c, 2, "°C"),
      sub: s?.temperature_simulated ? "DS18B20 unavailable — placeholder value, not measured" : undefined,
      tag: s?.temperature_simulated ? ["simulated", "Simulated"] : measured,
    },
    {
      label: "Battery operating state", value: st ?? "—",
      sub: s?.battery_status ? `${live ? "Firmware" : "Demo"} status: ${s.battery_status}` : "Derived from battery power",
      tag: measured, accent: st === "Charging" ? C.battery : st === "Discharging" ? C.grid : undefined,
    },
    {
      label: "Total energy consumed", value: f(totals.consumed, 4, "Wh"),
      sub: totals.consumedFromFirmware ? (live ? "ESP8266 counter since boot" : "Demo counter this session") : "Integrated in browser · this session",
      tag: dcStale ? measured : s?.load_estimated ? ["estimated", "Estimated"] : measured,
    },
    {
      label: "Total solar energy generated", value: f(totals.solar, 4, "Wh"),
      sub: totals.solarFromFirmware ? (live ? "ESP8266 counter since boot" : "Demo counter this session") : "Integrated in browser · this session",
      tag: solarOk ? measured : ["pending", "Pending"],
    },
  ];

  const connectBtn = "rounded-full bg-white px-5 py-2.5 font-medium text-night disabled:opacity-60";
  return (
    <MotionConfig reducedMotion="user">
      <Nav />
      <main>
        <div id="hero" className="relative overflow-hidden bg-night text-white">
          <div className="pointer-events-none absolute -top-40 left-1/2 h-[520px] w-[1100px] -translate-x-1/2 rounded-full opacity-40 blur-3xl" style={{ background: "radial-gradient(closest-side, rgba(232,159,0,0.35), rgba(47,123,224,0.18), transparent)" }} />
          <div className="relative mx-auto max-w-[1200px] px-4 pb-16 pt-28 sm:px-8 sm:pt-32">
            <motion.h1 initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} className="max-w-[820px] font-display text-[2.6rem] font-semibold leading-[1.02] tracking-[-0.035em] sm:text-[4.2rem]">Smart Energy Management System</motion.h1>
            <p className="mt-5 max-w-[60ch] text-[1.1rem] leading-relaxed text-white/75">Physical prototype · 50 W solar panel, 12 V 5.5 Ah (66 Wh) battery bank and ESP8266 monitoring with two INA219 sensors.</p>
            <a className="mt-4 inline-block text-solar underline" href="https://smart-energy-management-three.vercel.app/">Household-scale simulation ↗</a>

            <div id="simulator" className="mt-12 rounded-2xl bg-night2 p-5 ring-1 ring-white/10 sm:p-8">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="font-display text-2xl">Prototype simulator</h2>
                <span className={`rounded-full px-4 py-2 text-sm ${!live ? "bg-white/10" : dcStale ? "bg-solar/15 text-solar" : "bg-battery/20 text-battery"}`}>
                  {!live ? "Simulated demo — not measured" : dcStale ? `Live sensor mode · stale — last reading ${lastDcTime}` : "Live sensor mode · ESP8266"}
                </span>
              </div>

              <div className="mt-5">
                <Flow solar={s?.pv_power_w ?? null} battery={s?.battery_power_w ?? null} load={s?.load_power_w ?? null} voltage={s?.battery_voltage_v ?? null}
                  state={s ? st : null} solarAvailable={s?.solar_available ?? null} loadEstimated={s?.load_estimated ?? false} soc={s?.battery_soc ?? null}
                  paused={dcStale} ac={flowAc} />
              </div>

              <div className="mt-6 grid gap-4 lg:grid-cols-2">
                <div className={`rounded-xl p-4 ring-1 ring-white/10 ${live ? "opacity-50" : ""}`}>
                  <p className="text-xs uppercase tracking-wider text-white/50">Virtual simulation controls{live && " · disabled in sensor mode"}</p>
                  <div className="mt-3 grid gap-4 sm:grid-cols-2">
                    <label className="text-sm">Sunlight {sun}%
                      <input disabled={live} className="mt-3 block w-full accent-solar" type="range" min="0" max="100" value={sun} onChange={(e) => setSun(+e.target.value)} />
                    </label>
                    <button disabled={live} className="rounded-full bg-white/10 p-3 text-sm disabled:cursor-not-allowed" onClick={() => setBulb(!bulb)}>Virtual DC bulb: {bulb ? "ON" : "OFF"}</button>
                  </div>
                  {live && <p className="mt-2 text-xs text-white/60">These controls only drive the simulation and cannot control the real hardware.</p>}
                </div>
                <div className="rounded-xl p-4 ring-1 ring-white/10">
                  <p className="text-xs uppercase tracking-wider text-white/50">DC hardware connection · ESP8266 · Web Serial 115200 baud</p>
                  <div className="mt-3 flex flex-wrap gap-3">
                    {esp.active ? (
                      <button className={connectBtn} disabled={esp.state !== "open"} onClick={esp.disconnect}>{esp.state === "connecting" ? "Connecting…" : esp.state === "closing" ? "Disconnecting…" : "Disconnect ESP8266"}</button>
                    ) : (
                      <>
                        <button className={connectBtn} onClick={() => void (esp.canReconnect ? esp.reconnect() : esp.connect())}>{live ? "Reconnect ESP8266" : "Connect ESP8266"}</button>
                        {esp.canReconnect && <button className="rounded-full bg-white/10 px-4 py-2.5 text-sm" onClick={() => void esp.connect()}>Choose port…</button>}
                        {live && <button className="rounded-full bg-white/10 px-5 py-2.5" onClick={returnToDemo}>Return to demo</button>}
                      </>
                    )}
                  </div>
                  <p className={`mt-3 text-sm ${dcStale && esp.state === "open" ? "text-solar" : "text-white/60"}`} role="status">
                    {status}{lastDcTime && <span className="text-white/40"> · last reading {lastDcTime}</span>}
                  </p>
                </div>
              </div>

              <div className="mt-6 grid gap-4 lg:grid-cols-[1fr_1.4fr]">
                <SocGauge s={s} />
                <EmsPanel s={s} live={live} staleAt={dcStale ? lastDcTime : null} />
              </div>

              <div className={`mt-4 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4 ${dcStale ? "opacity-60" : ""}`}>
                {cards.map((c) => <Card key={c.label} {...c} />)}
              </div>

              <div className="mt-4">
                <AcPanel link={ac} mode={acMode} row={acRow} lastLive={acLiveLast} fresh={acFresh} stats={acStats} now={now} raw={acRaw}
                  sim={acSim} setSim={setAcSim} simBulb={acSimBulb} setSimBulb={setAcSimBulb} cal={cal} onCal={updateCal} liveRows={acLive} />
              </div>

              <div className="mt-4">
                <RecorderPanel r={recorder} active={sourceActive} imported={imported}
                  onImported={(d) => { setImported(d); setChartView(d ? "imported" : "session"); }} />
              </div>
            </div>
          </div>
        </div>

        <div className="mx-auto max-w-[1200px] px-4 py-8 sm:px-8">
          <Panel>
            <PanelTitle sub={showImported ? `Imported synthetic test file “${imported.name}” · ${imported.dcRows.toLocaleString()} DC rows · not measured, not mixed with live data`
              : live ? `Live ESP8266 readings only · last ${CHART_ROWS} samples · no generated values${dcStale ? ` · stale since ${lastDcTime}` : ""}` : `Current simulated session · last ${CHART_ROWS} samples · separate from the monthly synthetic analysis`}>
              {showImported ? "Imported synthetic data" : "Session monitoring"}
            </PanelTitle>
            {imported && (
              <div className="-mt-2 mb-4 flex flex-wrap gap-2 text-sm" role="group" aria-label="Chart data">
                {(["session", "imported"] as const).map((v) => (
                  <button key={v} onClick={() => setChartView(v)} aria-pressed={chartView === v}
                    className={`rounded-full px-4 py-1.5 ring-1 ${chartView === v ? "bg-ink text-white ring-ink" : "ring-line text-muted"}`}>
                    {v === "session" ? (live ? "Live session" : "Simulated session") : "Imported synthetic file"}
                  </button>
                ))}
              </div>
            )}
            <div className="grid gap-6 lg:grid-cols-2">
              <MiniChart title="Battery voltage" data={series} dataKey="voltage" color={C.battery} unit="V" limit={{ y: LOW_BATTERY_VOLTAGE_V, label: `Low ${LOW_BATTERY_VOLTAGE_V} V` }} />
              <MiniChart title="Battery current" data={series} dataKey="current" color={C.pred} unit="A" limit={{ y: MAX_CHARGE_CURRENT_A, label: `Max charge ${MAX_CHARGE_CURRENT_A} A` }} />
              <MiniChart title="Battery SOC (estimated)" data={series} dataKey="soc" color={C.battery} unit="%" domain={[0, 100]} limit={{ y: LOW_BATTERY_SOC, label: `Low ${LOW_BATTERY_SOC}%` }} />
              <MiniChart title="Solar generation" data={series} dataKey="solar" color={C.solar} unit="W" note={showImported ? "Synthetic" : solarOk ? undefined : "Gaps = solar unavailable / pending"} />
              <div className="lg:col-span-2">
                <MiniChart title={showImported ? "DC consumption (synthetic)" : s?.load_estimated ? "Estimated DC consumption" : "DC consumption"} data={series} dataKey="load" color={C.grid} unit="W" note={showImported ? undefined : s?.load_estimated ? "Estimated by firmware" : undefined} />
              </div>
            </div>
            {!showImported && <div className="mt-6 grid gap-4 border-t border-line pt-4 text-sm sm:grid-cols-3">
              <div>Solar energy{totals.solarFromFirmware ? " (counter)" : " (retained samples)"}<br /><b className="font-mono text-xl">{f(totals.solar, 4, "Wh")}</b></div>
              <div>DC load energy{s?.load_estimated ? " (estimated)" : ""}<br /><b className="font-mono text-xl">{totals.consumed === null ? "Unavailable" : f(totals.consumed, 4, "Wh")}</b></div>
              <div>Grid-only equivalent @ ₹{tariff}/kWh<br /><b className="font-mono text-xl">{totals.consumed === null ? "Unavailable" : "₹" + ((totals.consumed * tariff) / 1000).toFixed(5)}</b></div>
            </div>}
          </Panel>
        </div>

        <History />

        <div className="bg-night text-white">
          <Section id="conclusion" title="Conclusion" dark>
            <p className="max-w-[75ch] text-white/75">This scaled hardware prototype validates sensor acquisition separately from the household-scale simulation. The historical charts and LSTM evaluation use explicitly synthetic prototype-scale data. Live measurements remain separate. EMS recommendations are advisory; grid charging, automatic source transfer and calibrated physical SOC are not implemented.</p>
          </Section>
        </div>
      </main>
      <footer className="bg-night px-8 py-8 text-sm text-white/60">
        Smart Energy Management System · Prototype companion · <a href="#recorder" className="underline">Data recording &amp; CSV export</a>
      </footer>
    </MotionConfig>
  );
}
