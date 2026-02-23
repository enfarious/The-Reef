'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('reef', {
  // ─── Skills ────────────────────────────────────────────────────────────────
  invoke: (skillName, args) => ipcRenderer.invoke('skill:run', skillName, args),

  // ─── Config persistence ────────────────────────────────────────────────────
  saveConfig: (config) => ipcRenderer.invoke('skill:run', 'config.save', config),
  loadConfig: () => ipcRenderer.invoke('skill:run', 'config.load', {}),

  // ─── Confirmation bridge (main → renderer → main) ──────────────────────────
  // Renderer registers a handler; main sends 'confirm:request' events.
  onConfirmRequest: (cb) => {
    ipcRenderer.on('confirm:request', (_event, id, message) => cb(id, message));
  },
  respondConfirm: (id, approved) => ipcRenderer.invoke('confirm:response', id, approved),
});
