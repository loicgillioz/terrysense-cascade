/*
 * terrySense widget translation — `window.TerrySenseI18n(ctx)` returns `t`, also
 * `window.TerrySenseT` for the shared scripts.
 *
 * `t(key, english, params)` is the text of `custom.terrysense.ui.<key>` in the
 * reader's ThingsBoard language, else `english`; `{name}` placeholders take
 * `params`. The English lives at the call site, the other languages in
 * `resources/i18n/<lang>/<namespace>.json`, pushed to the tenant's custom translation by
 * `scripts/push_translations.py`. Contract: logr-product-docs/cloud/I18N.md.
 *
 * Loads first: every other shared script reads `window.TerrySenseT`.
 */

(function (root) {
'use strict';

var translate = null;

function lookup(key) {
  if (!translate) { return null; }
  try {
    var text = translate.instant(key);
    return typeof text === 'string' && text && text !== key ? text : null;
  } catch (e) { return null; }
}

function fill(text, params) {
  if (!params) { return text; }
  return text.replace(/\{(\w+)\}/g, function (whole, name) { return params[name] != null ? String(params[name]) : whole; });
}

function t(key, english, params) { return fill(lookup('custom.terrysense.ui.' + key) || english, params); }

/** ThingsBoard's own name for an alarm severity (`critical`, …). */
t.severity = function (id, english) { return lookup('alarm.severity-' + id) || english; };

// The vocabulary's texts in the reader's language, each else its English.
t.channel = function (name, english) { return lookup('custom.terrysense.channel.' + name) || english; };
t.channelInfo = function (name, english) { return lookup('custom.terrysense.channelInfo.' + name) || english; };
/** `kind` as stored (`LEVEL_RATE`) or as the widgets carry it (`levelRate`). */
t.kind = function (kind, english) {
  var stored = /[a-z]/.test(kind || '') ? String(kind).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase() : kind;
  return lookup('custom.terrysense.kind.' + stored) || english;
};
t.attribute = function (attr, english) { return lookup('custom.terrysense.attribute.' + attr) || english; };
t.attributeInfo = function (attr, english) { return lookup('custom.terrysense.attributeInfo.' + attr) || english; };
/** `name` may be a channel key: an instance (`tiltX-3`) reads its name's states.
 * Without a translation: `english`, else the token itself. */
t.state = function (name, token, english) {
  return lookup('custom.terrysense.state.' + String(name || '').replace(/-\d+$/, '') + '.' + token) || english || token;
};

/** A channel's label as shown: the dictionary's in the reader's language, an
 * instance keeping its number; a label a level sets stays as typed. `names` is
 * `config.channelNames`. */
t.label = function (key, shown, names) {
  var m = /^(.+)-(\d+)$/.exec(key || '');
  var name = m ? m[1] : key, spec = (names || {})[name] || {};
  var english = spec.label && (m ? spec.label + ' ' + m[2] : spec.label);
  if (!english || shown !== english) { return shown; }
  var text = t.channel(name, spec.label);
  return m ? text + ' ' + m[2] : text;
};

/** How long ago `ts` (ms) was: "just now", "5 min ago", "3 h ago", "2 days ago"; "never" without one. */
t.ago = function (ts) {
  if (!ts) { return t('common.never', 'never'); }
  var s = Math.max(0, (Date.now() - Number(ts)) / 1000);
  if (s < 90) { return t('common.justNow', 'just now'); }
  if (s < 5400) { return t('common.minutesAgo', '{n} min ago', { n: Math.round(s / 60) }); }
  if (s < 129600) { return t('common.hoursAgo', '{n} h ago', { n: Math.round(s / 3600) }); }
  return t('common.daysAgo', '{n} days ago', { n: Math.round(s / 86400) });
};

/** The reader's locale for dates and numbers: `de-CH` for German. */
t.locale = function () {
  var lang = translate && translate.currentLang;
  return lang ? lang.split('_')[0] + '-CH' : undefined;
};

root.TerrySenseT = t;
root.TerrySenseI18n = function (ctx) {
  if (ctx && ctx.translate) { translate = ctx.translate; }
  return t;
};

})(typeof self !== 'undefined' ? self : this);
