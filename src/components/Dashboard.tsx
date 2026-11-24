"use client";
import { useEffect, useRef, useState } from "react";
import { MotionConfig, motion } from "motion/react";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine } from "recharts";
import Nav from "./Nav";
import History, { Flow } from "./History";
import { Section, Panel, PanelTitle, axisProps } from "./ui";
import { useSerialLink } from "@/lib/useSerialLink";
import {
  Sample, JsonStream, parsePacket, batteryState, isLowBattery, isOverCurrent, deriveRecommendation,
  classifyRecommendation, energyTotals, toCsv, EMS_STATES, EmsKey, NOMINAL_CAPACITY_WH, MAX_CHARGE_CURRENT_A,
  LOW_BATTERY_VOLTAGE_V, LOW_BATTERY_SOC, AcSample, parseAcPacket, parseLenientJson, AC_RATED_POWER_W,
} from "@/lib/telemetry";

const C = { solar: "#e89f00", battery: "#16a672", grid: "#2f7be0", pred: "#6a55e0", alert: "#e04848", warn: "#eb6834" };
const MAX_ROWS = 3600; // retained for CSV export
const CHART_ROWS = 120; // rolling window for live graphs
const f = (v: number | null | undefined, d: number, u: string) => (v === null || v === undefined ? "—" : `${v.toFixed(d)} ${u}`);

/* ---------- Simulated demo (browser only, never mixed with sensor data) ---------- */
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
function Card({ label, value, sub, tag, accent }: { label: string; value: string; sub?: string; tag?: [Tone, string]; accent?: string }) {
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

function EmsPanel({ s, live }: { s: Sample | undefined; live: boolean }) {
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
      <p className="mt-2 font-display text-3xl font-semibold" style={{ color: active?.color ?? "white" }}>{rec ?? "Waiting for data"}</p>
      <p className="mt-1 text-sm text-white/60">{active ? `State: ${active.state}` : rec ? "Unrecognised recommendation — shown as received" : ""}{source && ` · ${source}`}</p>
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

/** Independent ESP32 AC circuit. Uncalibrated readings are shown only as diagnostics. */
type LinkApi = ReturnType<typeof useSerialLink>;
type LinkStats = { packets: number; skipped: number; last: number };
function AcPanel({ link, a, stats, now, raw }: { link: LinkApi; a: AcSample | undefined; stats: LinkStats; now: number; raw: string | null }) {
  const calibrated = a?.ac_calibrated === true;
  const readingTag: [Tone, string] = calibrated ? ["measured", "Measured"] : ["pending", "Uncalibrated"];
  const dim = calibrated ? undefined : "#a9b6c8";
  const stale = link.state === "open" && stats.last > 0 && now - stats.last > 5000;
  const status = link.state === "open"
    ? (stats.packets === 0 ? "Connected — waiting for ESP32 AC JSON at 115200 baud"
      : stale ? `No AC data for ${Math.round((now - stats.last) / 1000)} s — check the ESP32 USB cable`
      : `Receiving ESP32 diagnostic data · ${stats.packets} packets`)
      + (stats.skipped ? ` · ${stats.skipped} non-AC lines skipped${stats.packets === 0 ? " (is this the ESP32 port?)" : ""}` : "")
    : link.message === "Not connected" ? "Not connected · the AC circuit is monitored separately from the DC system" : link.message;
  const cards: { label: string; value: string; sub?: string; tag?: [Tone, string]; accent?: string }[] = a ? [
    { label: "AC voltage", value: f(a.ac_voltage_v, 1, "V"), sub: calibrated ? "ZMPT101B" : "ZMPT101B · unverified diagnostic", tag: readingTag, accent: dim },
    { label: "AC current", value: f(a.ac_current_a, 3, "A"), sub: calibrated ? "ACS712 20 A" : "ACS712 20 A · unverified diagnostic", tag: readingTag, accent: dim },
    { label: "AC power", value: f(a.ac_power_w, 2, "W"), sub: calibrated ? "Active power" : `Active power · unverified (bulb rated ${AC_RATED_POWER_W} W)`, tag: readingTag, accent: dim },
    { label: "Voltage offset", value: f(a.voltage_offset_v, 4, "V"), sub: "ZMPT101B zero offset", tag: ["info", "Diagnostic"] },
    { label: "Current offset", value: f(a.current_offset_v, 4, "V"), sub: "ACS712 zero offset", tag: ["info", "Diagnostic"] },
    { label: "Apparent power", value: f(a.apparent_power_va, 2, "VA"), tag: readingTag, accent: dim },
    { label: "Power factor", value: f(a.power_factor, 3, ""), sub: a.power_factor === null ? "Not available (e.g. no load)" : undefined, tag: readingTag, accent: dim },
    { label: "Grid status", value: a.grid_status ?? "Unknown", sub: a.grid_status === null ? "Not reported by ESP32" : "Reported by ESP32", tag: a.grid_status === null ? ["pending", "N/A"] : ["info", "Status"] },
    { label: "Raw voltage RMS", value: f(a.raw_voltage_rms, 4, ""), sub: "Sensor-level value before calibration", tag: ["info", "Diagnostic"] },
    { label: "Raw current RMS", value: f(a.raw_current_rms, 4, ""), sub: "Sensor-level value before calibration", tag: ["info", "Diagnostic"] },
  ] : [];
  return (
    <div className="rounded-xl border border-dashed border-white/15 bg-night3/60 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-display text-lg text-white">Separate AC circuit</p>
          <p className="mt-1 text-sm text-white/60">Independent of the DC system · no AC/DC transfer wiring · own ESP32 serial link</p>
        </div>
        {calibrated ? <Tag tone="measured">Calibrated</Tag> : <Tag tone="estimated">Calibration Pending — Unverified Diagnostics</Tag>}
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
        {[["Controller", "ESP32"], ["Current sensor", "ACS712 20 A"], ["Voltage sensor", "ZMPT101B"], ["Supply", "220 V AC"], ["Load", "15 W rated bulb"]].map(([k, v]) => (
          <div key={k} className="rounded-lg bg-white/5 px-3 py-2"><span className="block text-xs text-white/50">{k}</span><span className="text-white">{v}</span></div>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button className="rounded-full bg-white px-5 py-2.5 text-sm font-medium text-night disabled:opacity-60" disabled={link.state === "connecting" || link.state === "closing"} onClick={() => (link.active ? link.disconnect() : void link.connect())}>
          {link.state === "connecting" ? "Connecting…" : link.state === "closing" ? "Disconnecting…" : link.active ? "Disconnect ESP32 (AC)" : "Connect ESP32 (AC)"}
        </button>
        <span className={`text-xs ${stale ? "text-solar" : "text-white/60"}`} role="status">{status}</span>
      </div>
      {!a && raw && link.state === "open" && (
        <p className="mt-3 break-all text-xs text-white/50">Last raw line: <code className="font-mono text-white/70">{raw}</code></p>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl bg-night3 p-4">
          <div className="flex items-start justify-between gap-2"><p className="text-sm text-white/60">Bulb rated power</p><Tag tone="info">Nameplate</Tag></div>
          <p className="mt-2 font-mono text-xl text-white">{AC_RATED_POWER_W.toFixed(0)} W</p>
          <p className="mt-1 text-xs text-white/50">Manufacturer rating — a fixed specification, not a measurement</p>
        </div>
        <div className="rounded-xl bg-night3 p-4">
          <div className="flex items-start justify-between gap-2"><p className="text-sm text-white/60">Measured active power</p>{a && <Tag tone={readingTag[0]}>{readingTag[1]}</Tag>}</div>
          <p className="mt-2 font-mono text-xl" style={{ color: dim ?? "white" }}>{a ? f(a.ac_power_w, 2, "W") : "—"}</p>
          <p className="mt-1 text-xs text-white/50">{!a ? "No ESP32 data" : calibrated ? "From calibrated ESP32 readings" : "Uncalibrated diagnostic — not an accurate mains measurement"}</p>
        </div>
      </div>

      {a && !calibrated && (
        <p className="mt-3 rounded-lg bg-solar/10 px-3 py-2 text-sm text-solar">
          Calibration Pending — Unverified Diagnostics. These ESP32 readings are uncalibrated and only for checking the sensors; they are not accurate mains measurements.
        </p>
      )}
      {a && (
        <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-3">
          {cards.map((c) => <Card key={c.label} {...c} />)}
        </div>
      )}
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
  const [rows, setRows] = useState<Sample[]>([]);
  const [stats, setStats] = useState({ packets: 0, skipped: 0, last: 0 });
  const [now, setNow] = useState(0);
  const [tariff] = useState(7);
  const demo = useRef<DemoState>(newDemo());
  const stream = useRef(new JsonStream());

  const esp = useSerialLink("ESP8266", {
    onOpen: () => {
      stream.current.reset();
      setRows([]);
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
      if (fresh.length) setRows((r) => [...r, ...fresh].slice(-MAX_ROWS));
      if (fresh.length || skipped) setStats((st) => ({ packets: st.packets + fresh.length, skipped: st.skipped + skipped, last: fresh.length ? Date.now() : st.last }));
    },
  });

  // Independent ESP32 AC link: own port, own reader, own rows. Never touches DC state.
  const [acRows, setAcRows] = useState<AcSample[]>([]);
  const [acStats, setAcStats] = useState({ packets: 0, skipped: 0, last: 0 });
  const [acRaw, setAcRaw] = useState<string | null>(null);
  const acStream = useRef(new JsonStream());
  const acLineBuf = useRef("");
  const ac = useSerialLink("ESP32 (AC)", {
    onOpen: () => {
      acStream.current.reset();
      acLineBuf.current = "";
      setAcRows([]);
      setAcStats({ packets: 0, skipped: 0, last: 0 });
      setAcRaw(null);
    },
    onText: (text) => {
      // keep the last raw line for troubleshooting before the first valid packet
      acLineBuf.current += text;
      const lines = acLineBuf.current.split(/\r?\n/);
      acLineBuf.current = (lines.pop() ?? "").slice(-2048);
      const lastLine = lines.map((l) => l.trim()).filter(Boolean).pop();
      if (lastLine) setAcRaw(lastLine.slice(0, 240));
      const fresh: AcSample[] = [];
      let skipped = 0;
      for (const obj of acStream.current.push(text)) {
        try {
          const a = parseAcPacket(parseLenientJson(obj));
          if (a) fresh.push(a); else skipped++;
        } catch { skipped++; }
      }
      if (fresh.length) setAcRows((r) => [...r, ...fresh].slice(-MAX_ROWS));
      if (fresh.length || skipped) setAcStats((st) => ({ packets: st.packets + fresh.length, skipped: st.skipped + skipped, last: fresh.length ? Date.now() : st.last }));
    },
  });
  const acLast = acRows[acRows.length - 1];

  // Simulated demo ticks (only in demo mode).
  useEffect(() => {
    if (mode !== "demo") return;
    const add = () => { const s = demoSample(sun, bulb, demo.current); setRows((r) => [...r, s].slice(-MAX_ROWS)); };
    add();
    const id = setInterval(add, 1000);
    return () => clearInterval(id);
  }, [sun, bulb, mode]);

  // Clock for stale-data detection while connected.
  useEffect(() => {
    if (esp.state !== "open" && ac.state !== "open") return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [esp.state, ac.state]);

  const live = mode === "live";
  const s = rows[rows.length - 1];
  const st = batteryState(s);
  const solarOk = s?.solar_available !== false;
  const totals = energyTotals(rows);
  const measured: [Tone, string] = live ? ["measured", "Measured"] : ["demo", "Demo"];
  const low = isLowBattery(s), over = isOverCurrent(s);

  const stale = esp.state === "open" && stats.last > 0 && now - stats.last > 5000;
  const status = esp.state === "open"
    ? (stats.packets === 0 ? "Connected — waiting for ESP8266 JSON at 115200 baud"
      : stale ? `No data for ${Math.round((now - stats.last) / 1000)} s — check the USB cable and firmware`
      : `Receiving sensor data · ${stats.packets} packets`) + (stats.skipped ? ` · ${stats.skipped} malformed/other lines skipped` : "")
    : esp.message === "Not connected" ? (live ? "Not connected" : "No hardware connected — showing simulated demo") : esp.message;

  function returnToDemo() {
    demo.current = newDemo();
    setRows([]);
    setStats({ packets: 0, skipped: 0, last: 0 });
    setMode("demo");
  }

  function download() {
    if (!rows.length && !acRows.length) return;
    const url = URL.createObjectURL(new Blob([toCsv(rows, acRows)], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `prototype-${live ? "live-sensor" : "simulated-demo"}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const series = rows.slice(-CHART_ROWS).map((r) => ({
    t: new Date(r.timestamp).toLocaleTimeString([], { hour12: false }),
    voltage: r.battery_voltage_v, current: r.battery_current_a, soc: r.battery_soc,
    solar: r.solar_available === false ? null : r.pv_power_w, load: r.load_power_w,
  }));

  const solarCard = (label: string, v: number | null | undefined, d: number, u: string): [string, string, string | undefined, [Tone, string]] =>
    solarOk ? [label, f(v, d, u), undefined, measured] : [label, "Unavailable", "Verification pending — not shown as measured", ["pending", "Pending"]];

  const cards: { label: string; value: string; sub?: string; tag?: [Tone, string]; accent?: string }[] = [
    { label: "Battery voltage", value: f(s?.battery_voltage_v, 3, "V"), sub: `Low-battery threshold ${LOW_BATTERY_VOLTAGE_V} V`, tag: measured, accent: low ? C.alert : undefined },
    { label: "Battery current", value: f(s?.battery_current_a, 4, "A"), sub: `+ charging · − discharging · max ${MAX_CHARGE_CURRENT_A} A`, tag: measured, accent: over ? C.warn : undefined },
    { label: "Signed battery power", value: f(s?.battery_power_w, 3, "W"), sub: "+ into battery · − out of battery", tag: measured },
    { label: "Battery nominal capacity", value: f(s?.battery_capacity_wh ?? NOMINAL_CAPACITY_WH, 1, "Wh"), sub: "12 V × 5.5 Ah (2 × 6 V in series)", tag: ["info", "Nominal"] },
    ...[solarCard("Solar voltage", s?.pv_voltage_v, 3, "V"), solarCard("Solar current", s?.pv_current_a, 4, "A"), solarCard("Solar generation", s?.pv_power_w, 3, "W")]
      .map(([label, value, sub, tag]) => ({ label, value, sub: sub ?? (label === "Solar generation" ? "50 W rated panel" : undefined), tag })),
    {
      label: "Estimated DC system consumption", value: f(s?.load_power_w, 3, "W"),
      sub: s && s.load_power_w === null ? "Not reported by firmware" : s?.load_estimated ? (live ? "Estimated by firmware — not directly measured" : "Virtual bulb in demo") : "12 V DC bulb via controller LOAD",
      tag: s?.load_estimated ? ["estimated", "Estimated"] : measured,
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
      tag: s?.load_estimated ? ["estimated", "Estimated"] : measured,
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
                <span className={`rounded-full px-4 py-2 text-sm ${live ? "bg-battery/20 text-battery" : "bg-white/10"}`}>{live ? "Live sensor mode · ESP8266" : "Simulated demo — not measured"}</span>
              </div>

              <div className="mt-5">
                <Flow solar={s?.pv_power_w ?? null} battery={s?.battery_power_w ?? null} load={s?.load_power_w ?? null} voltage={s?.battery_voltage_v ?? null}
                  state={s ? st : null} solarAvailable={s?.solar_available ?? null} loadEstimated={s?.load_estimated ?? false} soc={s?.battery_soc ?? null}
                  acNote={acLast?.ac_calibrated === true ? "Calibrated · independent" : ac.state === "open" ? "ESP32 linked · uncalibrated" : "Calibration pending · independent"} />
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
                  <p className="text-xs uppercase tracking-wider text-white/50">Hardware connection · Web Serial 115200 baud</p>
                  <div className="mt-3 flex flex-wrap gap-3">
                    {esp.active ? (
                      <button className={connectBtn} disabled={esp.state !== "open"} onClick={esp.disconnect}>{esp.state === "connecting" ? "Connecting…" : esp.state === "closing" ? "Disconnecting…" : "Disconnect ESP8266"}</button>
                    ) : (
                      <>
                        <button className={connectBtn} onClick={() => void esp.connect()}>{live ? "Reconnect ESP8266" : "Connect ESP8266"}</button>
                        {live && <button className="rounded-full bg-white/10 px-5 py-2.5" onClick={returnToDemo}>Return to demo</button>}
                      </>
                    )}
                  </div>
                  <p className={`mt-3 text-sm ${stale ? "text-solar" : "text-white/60"}`} role="status">{status}</p>
                </div>
              </div>

              <div className="mt-6 grid gap-4 lg:grid-cols-[1fr_1.4fr]">
                <SocGauge s={s} />
                <EmsPanel s={s} live={live} />
              </div>

              <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
                {cards.map((c) => <Card key={c.label} {...c} />)}
              </div>

              <div className="mt-4"><AcPanel link={ac} a={acLast} stats={acStats} now={now} raw={acRaw} /></div>

              <div className="mt-5 flex flex-wrap items-center gap-3">
                <button className="rounded-full bg-white/10 px-5 py-2 disabled:opacity-50" disabled={!rows.length && !acRows.length} onClick={download}>Download {live ? "live sensor" : "simulated demo"} CSV</button>
                <span className="text-xs text-white/50">{rows.length} DC samples{acRows.length ? ` · ${acRows.length} AC rows (separate circuit column)` : ""} · blank cells = unavailable · includes simulated/estimated/ac_calibrated flags{live ? "" : " · demo data only, never mixed with sensor data"}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="mx-auto max-w-[1200px] px-4 py-8 sm:px-8">
          <Panel>
            <PanelTitle sub={live ? `Live ESP8266 readings only · last ${CHART_ROWS} samples · no generated values` : `Current simulated session · last ${CHART_ROWS} samples · separate from the monthly synthetic analysis`}>
              Session monitoring
            </PanelTitle>
            <div className="grid gap-6 lg:grid-cols-2">
              <MiniChart title="Battery voltage" data={series} dataKey="voltage" color={C.battery} unit="V" limit={{ y: LOW_BATTERY_VOLTAGE_V, label: `Low ${LOW_BATTERY_VOLTAGE_V} V` }} />
              <MiniChart title="Battery current" data={series} dataKey="current" color={C.pred} unit="A" limit={{ y: MAX_CHARGE_CURRENT_A, label: `Max charge ${MAX_CHARGE_CURRENT_A} A` }} />
              <MiniChart title="Battery SOC (estimated)" data={series} dataKey="soc" color={C.battery} unit="%" domain={[0, 100]} limit={{ y: LOW_BATTERY_SOC, label: `Low ${LOW_BATTERY_SOC}%` }} />
              <MiniChart title="Solar generation" data={series} dataKey="solar" color={C.solar} unit="W" note={solarOk ? undefined : "Gaps = solar unavailable / pending"} />
              <div className="lg:col-span-2">
                <MiniChart title={s?.load_estimated ? "Estimated DC consumption" : "DC consumption"} data={series} dataKey="load" color={C.grid} unit="W" note={s?.load_estimated ? "Estimated by firmware" : undefined} />
              </div>
            </div>
            <div className="mt-6 grid gap-4 border-t border-line pt-4 text-sm sm:grid-cols-3">
              <div>Solar energy{totals.solarFromFirmware ? " (counter)" : " (retained samples)"}<br /><b className="font-mono text-xl">{f(totals.solar, 4, "Wh")}</b></div>
              <div>DC load energy{s?.load_estimated ? " (estimated)" : ""}<br /><b className="font-mono text-xl">{totals.consumed === null ? "Unavailable" : f(totals.consumed, 4, "Wh")}</b></div>
              <div>Grid-only equivalent @ ₹{tariff}/kWh<br /><b className="font-mono text-xl">{totals.consumed === null ? "Unavailable" : "₹" + ((totals.consumed * tariff) / 1000).toFixed(5)}</b></div>
            </div>
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
        Smart Energy Management System · Prototype companion · <button onClick={download} className="underline">Download session CSV</button>
      </footer>
    </MotionConfig>
  );
}
