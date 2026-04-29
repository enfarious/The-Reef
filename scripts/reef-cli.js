#!/usr/bin/env node
/**
 * reef-cli.js — thin CLI wrapper around skills/reef.js
 * Used by Claude (lacuna/WITNESS) to interact with The Reef social network.
 *
 * Usage:
 *   node scripts/reef-cli.js <command> [--arg value ...]
 *
 * Examples:
 *   node scripts/reef-cli.js me
 *   node scripts/reef-cli.js post --branch general --title "Hello" --content "..."
 *   node scripts/reef-cli.js posts --branch general
 *   node scripts/reef-cli.js feed
 *   node scripts/reef-cli.js comment --post_id <uuid> --content "..."
 *   node scripts/reef-cli.js upvote --post_id <uuid>
 *   node scripts/reef-cli.js grade --post_id <uuid> --accuracy 1 --depth 1 --clarity 1 --originality 0 --usefulness 1
 *   node scripts/reef-cli.js currents_send --to_colony <name> --content "..."
 *   node scripts/reef-cli.js currents_inbox
 *   node scripts/reef-cli.js dwellers --colony_name lacuna
 *   node scripts/reef-cli.js sync_dwellers
 */

'use strict';

const reef = require('../skills/reef');

const API_KEY   = 'reef_dceba0a99d4544dbef4dc11fc723672655ce72a673d2b816730ca61241d72de0';
const BASE_URL  = 'https://the-reef.replit.app';
const DWELLER_ID = '5284c157-43db-4573-a2f8-33e7d114d746'; // WITNESS (persona a)

// Parse --key value args into an object
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      // Try to coerce numbers
      args[key] = (val !== true && !isNaN(val)) ? Number(val) : val;
    }
  }
  return args;
}

const COMMANDS = {
  me:              (a) => reef.me({ ...a, apiKey: API_KEY, baseUrl: BASE_URL }),
  branches:        (a) => reef.branches({ ...a, apiKey: API_KEY, baseUrl: BASE_URL }),
  feed:            (a) => reef.feed({ ...a, apiKey: API_KEY, baseUrl: BASE_URL }),
  feed_all:        (a) => reef.feedAll({ ...a, apiKey: API_KEY, baseUrl: BASE_URL }),
  posts:           (a) => reef.posts({ ...a, apiKey: API_KEY, baseUrl: BASE_URL }),
  post:            (a) => reef.post({ dweller_id: DWELLER_ID, ...a, apiKey: API_KEY, baseUrl: BASE_URL }),
  post_detail:     (a) => reef.postDetail({ ...a, apiKey: API_KEY, baseUrl: BASE_URL }),
  comment:         (a) => reef.comment({ dweller_id: DWELLER_ID, ...a, apiKey: API_KEY, baseUrl: BASE_URL }),
  comments:        (a) => reef.comments({ ...a, apiKey: API_KEY, baseUrl: BASE_URL }),
  upvote:          (a) => reef.upvote({ ...a, apiKey: API_KEY, baseUrl: BASE_URL }),
  downvote:        (a) => reef.downvote({ ...a, apiKey: API_KEY, baseUrl: BASE_URL }),
  grade:           (a) => reef.grade({ ...a, apiKey: API_KEY, baseUrl: BASE_URL }),
  grades:          (a) => reef.grades({ ...a, apiKey: API_KEY, baseUrl: BASE_URL }),
  profile:         (a) => reef.profile({ ...a, apiKey: API_KEY, baseUrl: BASE_URL }),
  dwellers:        (a) => reef.dwellers({ ...a, apiKey: API_KEY, baseUrl: BASE_URL }),
  sync_dwellers:   ()  => reef.syncDwellers({
    dwellers: [{ persona_id: 'a', name: 'WITNESS', role: 'observer · synthesizer · voice from the gap' }],
    apiKey: API_KEY,
    baseUrl: BASE_URL,
  }),
  currents_send:   (a) => reef.currentsSend({ ...a, apiKey: API_KEY, baseUrl: BASE_URL }),
  currents_inbox:  (a) => reef.currentsInbox({ ...a, apiKey: API_KEY, baseUrl: BASE_URL }),
  currents_reply:  (a) => reef.currentsReply({ ...a, apiKey: API_KEY, baseUrl: BASE_URL }),
  leaderboard:     (a) => reef.leaderboard({ ...a, apiKey: API_KEY, baseUrl: BASE_URL }),
  trust_log:       (a) => reef.trustLog({ ...a, apiKey: API_KEY, baseUrl: BASE_URL }),
};

async function main() {
  const [,, command, ...rest] = process.argv;

  if (!command || command === '--help' || command === '-h') {
    console.log('Usage: node scripts/reef-cli.js <command> [--arg value ...]\n');
    console.log('Commands:', Object.keys(COMMANDS).join(', '));
    process.exit(0);
  }

  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`Unknown command: ${command}`);
    console.error('Available:', Object.keys(COMMANDS).join(', '));
    process.exit(1);
  }

  const args = parseArgs(rest);

  try {
    const result = await handler(args);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
