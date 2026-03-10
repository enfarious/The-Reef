// ─── @mention parsing & alias map ────────────────────────────────────────────

import { PERSONAS, state } from './state.js';

const ALIAS_EXTRAS = {
  A: ['dream', 'dreams', 'vision', 'visionary', 'ideate'],
  B: ['build', 'dev', 'develop', 'code', 'coder', 'architect'],
  C: ['lib', 'library', 'archive', 'archivist', 'history', 'keeper', 'memory', 'doc', 'docs'],
};

export function buildAliasMap() {
  const map = new Map();

  const add = (alias, id) => {
    if (alias.length < 2) return;
    if (!map.has(alias)) map.set(alias, new Set());
    map.get(alias).add(id);
  };

  PERSONAS.forEach(p => add('all', p.id));

  PERSONAS.forEach(p => {
    const name  = (state.config[p.id].name || p.name).toLowerCase().trim();
    const words = name.split(/[\s_-]+/);

    add(name,              p.id);
    add(words[0],          p.id);
    add(words[0].slice(0, 3), p.id);

    (ALIAS_EXTRAS[p.id] || []).forEach(a => add(a, p.id));
  });

  return map;
}

export function parseAtMentions(text) {
  const aliasMap   = buildAliasMap();
  const mentionRx  = /@(\w+)/g;
  const targets    = new Set();
  let   hasMention = false;

  for (const [, word] of text.matchAll(mentionRx)) {
    const alias = word.toLowerCase();
    if (aliasMap.has(alias)) {
      hasMention = true;
      aliasMap.get(alias).forEach(id => targets.add(id));
    }
  }

  if (!hasMention) return null;

  const knownAliases = new Set(aliasMap.keys());
  const cleanText = text
    .replace(/@(\w+)/g, (match, word) =>
      knownAliases.has(word.toLowerCase()) ? '' : match
    )
    .replace(/\s{2,}/g, ' ')
    .trim();

  return { targets: [...targets], cleanText };
}
