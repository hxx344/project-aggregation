"use client";

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { bandPath, dotsPath, linePath, plotValue } from "../lib/svg-plot";
import { nearestTimeIndex } from "../modules/oil/chart-performance.mjs";

type Row = { time: number };
export type PlotLayer =
  | { kind: "line"; key: string; color: string; width: number; dash?: string; opacity?: number; active?: boolean; dots?: number }
  | { kind: "area"; key: string; lower: string | number; fill: string; opacity?: number };
export type PlotScales = { x: (time: number) => number; y: (value: number) => number };

/** Shared hover time so stacked charts show the same hour; subscribers re-render, the page does not. */
export type HoverStore = { get: () => number | null; set: (time: number | null) => void; subscribe: (listener: () => void) => () => void };
export function createHoverStore(): HoverStore {
  let time: number | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => time,
    set: next => { if (next === time) return; time = next; listeners.forEach(listener => listener()); },
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

const date = (time: number) => new Date(time).toISOString().slice(5, 10).replace("-", "/");

/**
 * Hand-drawn SVG plot: `rows` (possibly sampled) are drawn, `hoverRows` (every record) are inspected,
 * so tooltips never land on a dropped hour. Missing values break lines and areas.
 */
export const SvgPlot = memo(function SvgPlot({ rows, hoverRows = rows, xDomain, yDomain, yTicks, yTick, layers, references = [], zones = [], margin, label, height, hover, tooltip, overlay, defs }: {
  rows: readonly Row[];
  hoverRows?: readonly Row[];
  xDomain: readonly [number, number];
  yDomain: readonly [number, number];
  yTicks: readonly number[];
  yTick: (value: number) => string;
  layers: readonly PlotLayer[];
  references?: readonly { y: number; color: string; dash?: string }[];
  zones?: readonly { from: number; to: number; fill: string; opacity: number }[];
  margin: { top: number; right: number; bottom: number };
  label: string;
  height: number;
  hover?: HoverStore;
  tooltip: (row: Row) => ReactNode;
  overlay?: (scales: PlotScales) => ReactNode;
  defs?: ReactNode;
}) {
  const element = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height });
  const [localHover] = useState(createHoverStore);
  const store = hover ?? localHover;
  const hoverTime = useSyncExternalStore(store.subscribe, store.get, store.get);
  useLayoutEffect(() => {
    const node = element.current;
    if (!node) return;
    const measure = () => {
      const { width, height } = node.getBoundingClientRect();
      // A hidden page keeps its last geometry instead of collapsing to zero.
      if (width > 0 && height > 0) setSize(previous => previous.width === width && previous.height === height ? previous : { width, height });
    };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const geometry = useMemo(() => {
    const left = 0, right = size.width - margin.right, top = margin.top, bottom = Math.max(top + 1, size.height - margin.bottom);
    const [start, end] = xDomain, [low, high] = yDomain;
    const x = (time: number) => left + (end === start ? 0.5 : (time - start) / (end - start)) * (right - left);
    const y = (value: number) => top + (high === low ? 0.5 : (high - value) / (high - low)) * (bottom - top);
    const paths = layers.map(layer => layer.kind === "area" ? bandPath(rows, layer.key, layer.lower, x, y) : linePath(rows, layer.key, x, y));
    const dots = layers.map(layer => layer.kind === "line" && layer.dots ? dotsPath(rows, layer.key, x, y) : "");
    const count = end === start ? 1 : Math.max(2, Math.min(6, Math.floor((right - left) / 115)));
    const times = Array.from({ length: count }, (_, index) => start + (end - start) * index / Math.max(1, count - 1));
    return { left, right, top, bottom, x, y, paths, dots, times };
  }, [rows, layers, xDomain, yDomain, size, margin.right, margin.top, margin.bottom]);
  // A reading held by touch would snap to an edge hour the user never picked once the window moves.
  const [domainStart, domainEnd] = xDomain;
  useEffect(() => { store.set(null); }, [store, domainStart, domainEnd]);
  const index = hoverTime === null ? -1 : nearestTimeIndex(hoverRows, hoverTime);
  const row = index < 0 ? null : hoverRows[index];
  const content = row ? tooltip(row) : null;
  const pick = (event: React.PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = ((event.clientX - rect.left) * size.width / rect.width - geometry.left) / (geometry.right - geometry.left);
    store.set(xDomain[0] + Math.max(0, Math.min(1, ratio)) * (xDomain[1] - xDomain[0]));
  };
  const step = (key: string) => {
    if (!hoverRows.length) return;
    const current = index < 0 ? hoverRows.length - 1 : index;
    const next = key === "Home" ? 0 : key === "End" ? hoverRows.length - 1 : Math.max(0, Math.min(hoverRows.length - 1, current + (key === "ArrowLeft" ? -1 : 1)));
    store.set(hoverRows[next].time);
  };
  const cursorX = row ? geometry.x(row.time) : 0;
  const tip = useRef<HTMLDivElement>(null);
  // Beside the cursor on the roomier side, clamped inside the chart so narrow screens never clip it.
  useLayoutEffect(() => {
    const node = tip.current;
    if (!node) return;
    const width = node.offsetWidth, preferred = cursorX > size.width / 2 ? cursorX - 12 - width : cursorX + 12;
    node.style.left = `${Math.max(0, Math.min(size.width - width, preferred))}px`;
  });
  return <div ref={element} className="svg-plot">
    <svg className="svg-plot-surface" width="100%" height="100%" viewBox={`0 0 ${size.width} ${size.height}`} role="graphics-document" aria-label={label} tabIndex={0}
      onPointerMove={pick} onPointerDown={pick} onPointerLeave={event => { if (event.pointerType !== "touch") store.set(null); }}
      onFocus={event => { if (event.target === event.currentTarget && hoverRows.length) store.set(store.get() ?? hoverRows.at(-1)!.time); }}
      onBlur={event => { if (event.target === event.currentTarget) store.set(null); }}
      onKeyDown={event => { if (event.target !== event.currentTarget) return; if (event.key === "Escape") { store.set(null); return; } if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return; event.preventDefault(); step(event.key); }}>
      <title>{label}</title><desc>缺失时段断线；触摸、鼠标或左右方向键查看各时点数值。</desc>
      {defs && <defs>{defs}</defs>}
      {zones.map((zone, key) => { const top = geometry.y(Math.max(zone.from, zone.to)), bottom = geometry.y(Math.min(zone.from, zone.to)); return <rect key={key} x={geometry.left} width={geometry.right - geometry.left} y={top} height={Math.max(0, bottom - top)} fill={zone.fill} fillOpacity={zone.opacity}/>; })}
      {yTicks.map(value => { const y = geometry.y(value); return <g key={value}>
        <line x1={geometry.left} x2={geometry.right} y1={y} y2={y} stroke="var(--border)" strokeDasharray="3 5"/>
        <text className="svg-plot-tick" x={geometry.right + 8} y={y + 4} textAnchor="start">{yTick(value)}</text>
      </g>; })}
      {geometry.times.map((time, key) => <text key={key} className="svg-plot-tick" x={geometry.x(time)} y={geometry.bottom + 22} textAnchor={key === 0 ? "start" : key === geometry.times.length - 1 ? "end" : "middle"}>{date(time)}</text>)}
      {references.map(line => <line key={line.y} x1={geometry.left} x2={geometry.right} y1={geometry.y(line.y)} y2={geometry.y(line.y)} stroke={line.color} strokeDasharray={line.dash}/>)}
      {layers.map((layer, key) => layer.kind === "area"
        ? <path key={key} data-series={layer.key} d={geometry.paths[key]} fill={layer.fill} fillOpacity={layer.opacity} stroke="none"/>
        : <g key={key} data-series={layer.key}>
          <path d={geometry.paths[key]} fill="none" stroke={layer.color} strokeWidth={layer.width} strokeDasharray={layer.dash} strokeOpacity={layer.opacity} strokeLinecap={layer.dash ? "butt" : "round"} strokeLinejoin="round"/>
          {layer.dots ? <path d={geometry.dots[key]} fill="none" stroke={layer.color} strokeWidth={layer.dots * 2 + layer.width} strokeLinecap="round"/> : null}
        </g>)}
      {row && <g aria-hidden="true" pointerEvents="none">
        <line x1={cursorX} x2={cursorX} y1={geometry.top} y2={geometry.bottom} stroke="var(--muted-foreground)" strokeDasharray="3 3"/>
        {layers.map(layer => { if (layer.kind !== "line" || !layer.active) return null; const value = plotValue(row, layer.key); return value === null ? null : <circle key={layer.key} cx={cursorX} cy={geometry.y(value)} r={4} fill={layer.color} stroke="var(--card)" strokeWidth={2}/>; })}
      </g>}
      {overlay?.({ x: geometry.x, y: geometry.y })}
    </svg>
    {content && <div ref={tip} className="svg-plot-tooltip">{content}</div>}
  </div>;
});
