/*
 * Calculated measurements of a station — `window.TerrySenseCalculations(ui, tb)`.
 * The form for the `calc.*` constants a calculated name reads, and the save that
 * resolves the station at once, so the calculated channel gets its label, unit
 * and alarm bands with its first value. Shared by the project widget (a
 * template that needs a setting) and the Settings widget (the station's
 * calculated measurements). Spec: logr-product-docs/measurement/vocabulary.md §4,
 * logr-product-docs/cloud/FRONTEND.md *Station dashboards*.
 *
 * Loads after shared/resolver.js, ui.js and tb_io.js.
 */
(function (root) {
'use strict';

root.TerrySenseCalculations = function (ui, tb) {
  var resolver = root.TerrySenseResolver;
  var h = ui.h, esc = ui.esc;
  var PREFIX = resolver.CALC_PREFIX;

  function parseJson(raw) {
    if (!raw) { return null; }
    try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return null; }
  }

  /** The channel names and the constants' labels, from the Defaults asset. */
  function loadMeta() {
    return tb.io.fetchDefaults().then(function (d) { return d ? tb.attrsMap(d) : {}; }).then(function (a) {
      return { names: parseJson(a['config.channelNames']) || {}, attributes: parseJson(a['config.calcAttributes']) || {},
               kinds: parseJson(a['config.kinds']) || {} };
    });
  }

  function attrSpec(meta, attr) { return meta.attributes[attr] || { label: attr, unit: '', description: '' }; }

  /** "Sensor altitude (masl)". */
  function attrLabel(meta, attr) {
    var s = attrSpec(meta, attr);
    return s.label + (s.unit ? ' (' + s.unit + ')' : '');
  }

  /** A channel key under its station label, else its vocabulary label. */
  function channelLabel(meta, attrs, key) {
    var base = meta.names[resolver.splitChannelKey(key).name] || {};
    return (attrs && attrs['effective.' + key + '.label']) || base.label || key;
  }

  /** A list as prose: "a, b and c". */
  function listText(items) {
    return items.length < 2 ? items.join('') : items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
  }

  /** A reading for a person: at most four decimals, no float noise. */
  function shown(v) { return String(Number(Number(v).toFixed(4))); }

  function parseNumber(text) {
    var t = String(text == null ? '' : text).trim().replace(',', '.');
    if (!t) { return null; }
    var n = Number(t);
    return isFinite(n) ? n : null;
  }

  /** One input per constant in `attrNames`, filled with the station's value.
   * Returns `{el, values(), onChange(fn)}`; `values()` is the `calc.*` write,
   * or null while one input is empty or not a number. */
  function form(station, attrs, attrNames, meta) {
    var el = h('<div class="ts-calc-form"></div>'), listeners = [];
    attrNames.forEach(function (attr) {
      var spec = attrSpec(meta, attr), current = attrs[PREFIX + attr];
      var f = h('<div class="ts-field" data-calc="' + esc(attr) + '"><label class="ts-field-label"></label>' +
        '<div class="ts-field-hint"></div>' +
        '<div class="ts-calc-input"><input class="ts-input num" inputmode="decimal"><span class="ts-calc-unit"></span></div></div>');
      f.querySelector('label').textContent = spec.label;
      f.querySelector('.ts-calc-unit').textContent = spec.unit;
      f.querySelector('.ts-field-hint').textContent = spec.description;
      var input = f.querySelector('input');
      if (current != null) { input.value = String(current); }
      input.addEventListener('input', function () { listeners.forEach(function (fn) { fn(); }); });
      if (spec.reading) {
        var use = h('<button type="button" class="ts-btn ghost ts-calc-reading" disabled>Latest reading…</button>');
        f.appendChild(use);
        tb.get('/api/plugins/telemetry/ASSET/' + station.id + '/values/timeseries', { keys: spec.reading }).then(function (got) {
          var p = got && got[spec.reading] && got[spec.reading][0];
          var v = p && p.value !== null && p.value !== undefined ? Number(p.value) : NaN;
          if (!isFinite(v)) { use.textContent = 'No reading yet'; return; }
          use.textContent = 'Use the latest reading: ' + shown(v) + (spec.unit ? ' ' + spec.unit : '');
          use.title = String(v);
          use.disabled = false;
          use.addEventListener('click', function () {
            input.value = String(v);
            input.dispatchEvent(new Event('input', { bubbles: true }));
          });
        }).catch(function () { use.textContent = 'No reading yet'; });
      }
      el.appendChild(f);
    });
    return {
      el: el,
      values: function () {
        var out = {}, ok = true;
        attrNames.forEach(function (attr) {
          var n = parseNumber(el.querySelector('[data-calc="' + attr + '"] input').value);
          if (n === null) { ok = false; } else { out[PREFIX + attr] = n; }
        });
        return ok ? out : null;
      },
      onChange: function (fn) { listeners.push(fn); },
      focus: function () { var i = el.querySelector('input'); if (i) { i.focus(); } }
    };
  }

  /** Write `write` on the station, then resolve it, so what it turns on is labelled and banded at once. */
  function save(station, write) {
    return tb.saveAttrs(station, write).then(function () { return tb.resolveStations([station]); });
  }

  /** Remove the constants, which turns off every calculated name that reads them. */
  function clear(station, attrNames) {
    return tb.deleteAttrs(station, attrNames.map(function (a) { return PREFIX + a; }))
      .then(function () { return tb.resolveStations([station]); });
  }

  /** "Water level and Water level rise rate", the plan entries a constant turns on. */
  function enabledBy(plan, attrNames, meta, attrs) {
    return plan.filter(function (p) {
      return p.needs.length && p.needs.every(function (a) { return attrNames.indexOf(a) >= 0; });
    }).map(function (p) { return channelLabel(meta, attrs, p.name); });
  }

  return {
    loadMeta: loadMeta, attrLabel: attrLabel, channelLabel: channelLabel, listText: listText,
    form: form, save: save, clear: clear, enabledBy: enabledBy, parseNumber: parseNumber, shown: shown
  };
};

})(typeof self !== 'undefined' ? self : this);
