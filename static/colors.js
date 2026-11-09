// Colour helpers: categorical palette for groups / integer codes, viridis for continuous data.

const BASE = [
  '#4e79a7', '#f28e2b', '#59a14f', '#e15759', '#76b7b2', '#edc948', '#b07aa1', '#ff9da7',
  '#9c755f', '#bab0ac', '#86bcb6', '#d37295', '#8cd17d', '#b6992d', '#499894', '#f1ce63',
  '#a0cbe8', '#ffbe7d', '#d4a6c8', '#79706e',
];

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function rgbToHex([r, g, b]) {
  return '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
}

function hslToRgb(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = n => { const k = (n + h * 12) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/** Stable categorical colour for the i-th category. */
export function categorical(i) {
  if (i < BASE.length) return hexToRgb(BASE[i]);
  const h = ((i - BASE.length) * 0.618033988749895 + 0.11) % 1;
  return hslToRgb(h, 0.55 + 0.25 * ((i * 7) % 3) / 2, 0.55 + 0.1 * ((i * 5) % 2));
}

const VIRIDIS = [
  [68, 1, 84], [72, 35, 116], [64, 67, 135], [52, 94, 141], [41, 120, 142], [32, 144, 140],
  [34, 167, 132], [68, 190, 112], [121, 209, 81], [189, 222, 38], [253, 231, 37],
];
/** t in [0,1] -> [r,g,b] */
export function viridis(t) {
  if (!(t >= 0)) t = 0; else if (t > 1) t = 1;
  const x = t * (VIRIDIS.length - 1), i = Math.min(Math.floor(x), VIRIDIS.length - 2), f = x - i;
  const a = VIRIDIS[i], b = VIRIDIS[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}
export const VIRIDIS_CSS = `linear-gradient(to right, ${VIRIDIS.map(c => `rgb(${c})`).join(',')})`;

export const SELECT_RGB = [255, 43, 200];   // magenta: absent from the categorical palette
export const DIM_RGB = [52, 55, 62];         // unselected elements fade toward this while a selection exists
export const NEUTRAL_RGB = [170, 174, 182];
export const UNASSIGNED_RGB = [92, 95, 103];   // values equal to a variable's unassigned_value
