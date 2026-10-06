/*
 * terrySense widget translation — `window.TerrySenseI18n(ctx)` returns `t`, also
 * `window.TerrySenseT` for the shared scripts.
 *
 * `t(key, english, params)` is the text of `custom.terrysense.ui.<key>` in the
 * reader's ThingsBoard language, else `english`; `{name}` placeholders take
 * `params`. The English lives at the call site, the other languages in
 * `resources/i18n/<lang>.json`, pushed to the tenant's custom translation by
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

/** The vocabulary's label of a channel name, in the reader's language. */
t.channel = function (name, english) { return lookup('custom.terrysense.channel.' + name) || english; };

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
