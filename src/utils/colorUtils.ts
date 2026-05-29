// src/utils/colorUtils.ts
// Builds WorksheetColorScheme objects from a named preset or a raw hex value.

import { WorksheetColorScheme } from "../types/worksheet";

// --- Preset named color schemes ---

const COLOR_PRESETS: Record<string, WorksheetColorScheme> = {
  green: {
    primary: "#2d6a2d",
    primaryLight: "#4a9e4a",
    background: "#ffffff",
    text: "#1a1a1a",
    accent: "#1a5c1a",
    headerBg: "#2d6a2d",
    headerText: "#ffffff",
    boxBorder: "#2d6a2d",
    labelBg: "#2d6a2d",
    labelText: "#ffffff",
  },
  blue: {
    primary: "#1a4f8a",
    primaryLight: "#2d72d2",
    background: "#ffffff",
    text: "#1a1a1a",
    accent: "#0d3666",
    headerBg: "#1a4f8a",
    headerText: "#ffffff",
    boxBorder: "#1a4f8a",
    labelBg: "#1a4f8a",
    labelText: "#ffffff",
  },
  purple: {
    primary: "#6b2fa0",
    primaryLight: "#9b59d0",
    background: "#ffffff",
    text: "#1a1a1a",
    accent: "#4a1a7a",
    headerBg: "#6b2fa0",
    headerText: "#ffffff",
    boxBorder: "#6b2fa0",
    labelBg: "#6b2fa0",
    labelText: "#ffffff",
  },
  orange: {
    primary: "#c75000",
    primaryLight: "#e87030",
    background: "#ffffff",
    text: "#1a1a1a",
    accent: "#8a3000",
    headerBg: "#c75000",
    headerText: "#ffffff",
    boxBorder: "#c75000",
    labelBg: "#c75000",
    labelText: "#ffffff",
  },
  red: {
    primary: "#b71c1c",
    primaryLight: "#e53935",
    background: "#ffffff",
    text: "#1a1a1a",
    accent: "#7f0000",
    headerBg: "#b71c1c",
    headerText: "#ffffff",
    boxBorder: "#b71c1c",
    labelBg: "#b71c1c",
    labelText: "#ffffff",
  },
  teal: {
    primary: "#00695c",
    primaryLight: "#00897b",
    background: "#ffffff",
    text: "#1a1a1a",
    accent: "#004d40",
    headerBg: "#00695c",
    headerText: "#ffffff",
    boxBorder: "#00695c",
    labelBg: "#00695c",
    labelText: "#ffffff",
  },
};

// --- Build from preset name ---

export function buildColorScheme(colorName: string): WorksheetColorScheme {
  const key = colorName.toLowerCase().trim();
  return COLOR_PRESETS[key] ?? COLOR_PRESETS["green"]!;
}

// --- Build from raw hex (used when replicating an uploaded worksheet) ---

export function buildColorSchemeFromHex(
  primaryHex: string,
  isDark: boolean
): WorksheetColorScheme {
  return {
    primary: primaryHex,
    primaryLight: lightenHex(primaryHex, 20),
    background: "#ffffff",
    text: "#1a1a1a",
    accent: darkenHex(primaryHex, 15),
    headerBg: primaryHex,
    headerText: isDark ? "#ffffff" : "#1a1a1a",
    boxBorder: primaryHex,
    labelBg: primaryHex,
    labelText: isDark ? "#ffffff" : "#1a1a1a",
  };
}

// --- Hex math helpers ---

function hexToRgb(hex: string): [number, number, number] {
  const num = parseInt(hex.replace("#", ""), 16);
  return [(num >> 16) & 0xff, (num >> 8) & 0xff, num & 0xff];
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

function lightenHex(hex: string, percent: number): string {
  const [r, g, b] = hexToRgb(hex);
  const amount = Math.round(2.55 * percent);
  return rgbToHex(
    Math.min(255, r + amount),
    Math.min(255, g + amount),
    Math.min(255, b + amount)
  );
}

function darkenHex(hex: string, percent: number): string {
  const [r, g, b] = hexToRgb(hex);
  const amount = Math.round(2.55 * percent);
  return rgbToHex(
    Math.max(0, r - amount),
    Math.max(0, g - amount),
    Math.max(0, b - amount)
  );
}
