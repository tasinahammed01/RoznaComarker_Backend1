'use strict';
// Line-for-line port of the frontend's report chart geometry (RoznaComarker
// src/app/components/teacher/assignment-report-charts/report-chart-geometry.ts). The two must give the same bars for the same points:
// both repos test against the same golden file (reportChartGeometry.golden.json), and the backend test also compares with the
// frontend source directly when the frontend repo sits next to this one. Change both together, or neither.

const PAD = { top: 22, right: 8, bottom: 30, left: 32 };
const MAX_LABELS = 10;
const GAP = 2;          // 2px surface gap between adjacent bars
const MAX_BAR = 64;

function niceMax(value) {
  if (value <= 4) return Math.max(1, Math.ceil(value));
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  const step = [1, 2, 2.5, 5, 10].map((s) => s * magnitude).find((s) => value / s <= 4) ?? 10 * magnitude;
  return Math.ceil(value / step) * step;
}

function columnChartGeometry(points, { width, height }) {
  const plotLeft = PAD.left, plotRight = width - PAD.right, plotTop = PAD.top, plotBottom = height - PAD.bottom;
  const safe = (points || []).map((p) => ({ label: String(p.label ?? ''), value: Number.isFinite(p.value) && p.value > 0 ? p.value : 0 }));
  const rawMax = safe.reduce((m, p) => Math.max(m, p.value), 0);
  const maxValue = niceMax(rawMax);
  const plotHeight = plotBottom - plotTop;
  const slot = safe.length ? (plotRight - plotLeft) / safe.length : 0;
  const barWidth = Math.max(1, Math.min(MAX_BAR, slot - GAP));
  const every = Math.max(1, Math.ceil(safe.length / MAX_LABELS));
  const bars = safe.map((p, i) => {
    const h = rawMax > 0 ? (p.value / maxValue) * plotHeight : 0;
    const centerX = plotLeft + slot * i + slot / 2;
    return { label: p.label, value: p.value, x: centerX - barWidth / 2, y: plotBottom - h, width: barWidth, height: h, centerX,
      showLabel: i % every === 0 || i === safe.length - 1 && safe.length <= MAX_LABELS };
  });
  const tickStep = maxValue <= 4 ? 1 : maxValue / 4;
  const ticks = [];
  for (let v = 0; v <= maxValue + 1e-9; v += tickStep) ticks.push({ value: Math.round(v * 100) / 100, y: plotBottom - (v / maxValue) * plotHeight });
  return { width, height, plotTop, plotBottom, plotLeft, plotRight, maxValue, bars, ticks };
}

/** A bar with 4px rounded data-end and a square base on the baseline (SVG path). */
function roundedTopBarPath(bar, radius = 4) {
  if (bar.height <= 0) return '';
  const r = Math.min(radius, bar.width / 2, bar.height);
  const { x, y, width: w, height: h } = bar;
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

module.exports = { columnChartGeometry, roundedTopBarPath };
