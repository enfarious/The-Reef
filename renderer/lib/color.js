// ─── Color system ─────────────────────────────────────────────────────────────

import { state } from './state.js';

export const COLOR_PALETTE = [
  { name: 'teal',    hex: '#00e5c8' },
  { name: 'azure',   hex: '#0097ff' },
  { name: 'violet',  hex: '#a855f7' },
  { name: 'amber',   hex: '#f0a500' },
  { name: 'emerald', hex: '#00c27a' },
  { name: 'rose',    hex: '#f43f5e' },
  { name: 'sky',     hex: '#38bdf8' },
  { name: 'indigo',  hex: '#6366f1' },
];

export const TEXT_COLOR_PRESETS = [
  { id: 'cool',    label: 'COOL',    preview: 'Aa',
    bright: '#e8f4f8', mid: '#7fa8c0', dim: '#3a5870' },
  { id: 'warm',    label: 'WARM',    preview: 'Aa',
    bright: '#f5ede0', mid: '#c09768', dim: '#6b4a2a' },
  { id: 'mono',    label: 'MONO',    preview: 'Aa',
    bright: '#e8e8e8', mid: '#909090', dim: '#484848' },
  { id: 'green',   label: 'GREEN',   preview: 'Aa',
    bright: '#c0f0c0', mid: '#52a052', dim: '#285028' },
  { id: 'amber',   label: 'AMBER',   preview: 'Aa',
    bright: '#f5e0a0', mid: '#c09040', dim: '#6b4a18' },
];

export function applyFontScale(v) {
  const scale = v / 100;
  const app   = document.getElementById('app');
  if (scale === 1) {
    app.style.transform       = '';
    app.style.transformOrigin = '';
    app.style.width           = '';
    app.style.height          = '';
  } else {
    const inv = (100 / scale).toFixed(3);
    app.style.transformOrigin = 'top left';
    app.style.transform       = `scale(${scale})`;
    app.style.width           = `${inv}vw`;
    app.style.height          = `${inv}vh`;
  }
  document.body.style.zoom = '';
}

export function applyTextColors(presetId) {
  const preset = TEXT_COLOR_PRESETS.find(p => p.id === presetId) || TEXT_COLOR_PRESETS[0];
  const root = document.documentElement;
  root.style.setProperty('--text-bright', preset.bright);
  root.style.setProperty('--text-mid',    preset.mid);
  root.style.setProperty('--text-dim',    preset.dim);
  state.config.settings.fontColors = preset.id;
}

export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

export function applyPersonaColor(id, hex) {
  const { r, g, b } = hexToRgb(hex);
  const col = document.getElementById(`col-${id}`);
  if (col) {
    col.style.setProperty('--p-color', hex);
    col.style.setProperty('--p-r', r);
    col.style.setProperty('--p-g', g);
    col.style.setProperty('--p-b', b);
  }
  const btn = document.querySelector(`.target-btn[data-target="${id}"]`);
  if (btn) {
    btn.style.setProperty('--p-color', hex);
    btn.style.setProperty('--p-r', r);
    btn.style.setProperty('--p-g', g);
    btn.style.setProperty('--p-b', b);
  }
}

export function applyColonyName(name) {
  const display = (name || 'THE REEF').trim().toUpperCase();
  const el = document.getElementById('colonyNameDisplay');
  if (el) el.textContent = display;
  document.title = display + ' — Colony Interface';
}
