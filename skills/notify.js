'use strict';

const { Notification } = require('electron');

// ─── Desktop notifications ───────────────────────────────────────────────────
// Lets entities send OS-level desktop notifications to get the operator's
// attention — e.g. when a long task completes, an error needs human input,
// or an interesting result was found during a heartbeat.

async function send({ title, body, silent = false } = {}) {
  if (!title && !body) throw new Error('At least title or body is required.');

  if (!Notification.isSupported()) {
    return 'Desktop notifications are not supported on this system.';
  }

  const notif = new Notification({
    title:  title || 'The Reef',
    body:   body  || '',
    silent: !!silent,
  });

  notif.show();
  return `Notification sent: ${title || '(no title)'}`;
}

module.exports = { send };
