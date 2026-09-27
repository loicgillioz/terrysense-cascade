/*
 * Project — every station of a project or location at a glance, under its
 * channel names (EU-1). Bound to one station, that station's channels as
 * charts with their alarm bands. Read-only for everyone.
 *
 * Channels are the keys of the station's `config.channelMap`; labels, units and
 * bands are its `effective.<channel>.*` attributes. A name the vocabulary marks
 * diagnostic (battery, firmware, ...) is folded away until asked for. A channel
 * with an active `<channel>.max|min|state` alarm takes that alarm's colour; the
 * station's other alarms (peripheral fault, device event, ...) are listed on the
 * card. Widget: logr-product-docs/cloud/FRONTEND.md *Project dashboard*.
 *
 * Loads after shared/resolver.js, glossary.js, ui.js and tb_io.js.
 */

window.TerrySenseProjectOverview = function (ctx, container) {

var resolver = window.TerrySenseResolver;
var G = window.TerrySenseGlossary;
var tb = window.TerrySenseTbIo(ctx);
var root = container.querySelector('.ts-root') || container;
var ui = window.TerrySenseUi(root);
var h = ui.h, esc = ui.esc, ICON = ui.ICON;

var REFRESH_MS = 60000;
var HOUR = 3600000;
var TREND_MS = 24 * HOUR;
var CHART_MS = 7 * 24 * HOUR;
var MAX_DEPTH = 4;
var CHANNEL_ALARM_RE = /^(.+)\.(max|min|state)$/;
var BAND_RE = /^effective\.(.+)\.alarm\.([a-z]+)\.threshold(Max|Min)$/;
var OTHER_ALARMS = [
  { prefix: 'peripheralFault.', text: 'Sensor fault' },
  { prefix: 'deviceEvent.movement', text: 'Logger moved' },
  { prefix: 'deviceEvent.batteryCritical', text: 'Logger battery critical' },
  { prefix: 'deviceEvent.power', text: 'Logger power changed' },
  { prefix: 'deviceHealth', text: 'Logger self-test fault' },
  { prefix: 'pipelineError', text: 'Data processing error' }
];

function parseJson(raw) {
  if (!raw) { return null; }
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return null; }
}

function ago(ts) {
  if (!ts) { return 'no reading yet'; }
  var s = Math.max(0, (Date.now() - Number(ts)) / 1000);
  if (s < 90) { return 'just now'; }
  if (s < 5400) { return Math.round(s / 60) + ' min ago'; }
  if (s < 129600) { return Math.round(s / 3600) + ' h ago'; }
  return Math.round(s / 86400) + ' days ago';
}

function fmtNumber(n) {
  var a = Math.abs(n);
  var digits = a >= 1000 ? 0 : a >= 100 ? 1 : a >= 1 ? 2 : 3;
  return String(Math.round(n * Math.pow(10, digits)) / Math.pow(10, digits));
}

function fmtDate(ts) {
  var d = new Date(ts);
  return d.getDate() + '.' + (d.getMonth() + 1) + '. ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
}

// -- data -------------------------------------------------------------------------------

var state = { entity: null, names: {}, stations: [], showDiagnostic: false, loadedAt: 0 };

function loadNames() {
  return tb.io.fetchDefaults().then(function (d) { return d ? tb.attrsMap(d) : {}; }).then(function (a) {
    state.names = parseJson(a['config.channelNames']) || {};
  });
}

/** Stations below `entity` over `Contains`, each with the location it sits in. */
function findStations(entity) {
  var out = [];
  function walk(level, location, depth) {
    if (depth > MAX_DEPTH) { return Promise.resolve(); }
    return tb.io.fetchChildren(level).then(function (children) {
      return Promise.all(children.map(function (c) {
        if (c.kind === 'Station') { out.push({ station: c, location: location }); return null; }
        if (c.kind === 'Location') { return walk(c, location ? location + ' › ' + c.name : c.name, depth + 1); }
        return null;
      }));
    });
  }
  return walk(entity, null, 0).then(function () {
    return out.sort(function (a, b) {
      return (a.location || '').localeCompare(b.location || '') || a.station.name.localeCompare(b.station.name);
    });
  });
}

function channelOf(key, attrs, latest, history) {
  var base = state.names[resolver.splitChannelKey(key).name] || {};
  var raw = latest[key] && latest[key][0];
  var bands = [];
  Object.keys(attrs).forEach(function (k) {
    var m = BAND_RE.exec(k);
    if (m && m[1] === key && isFinite(Number(attrs[k]))) { bands.push({ severity: m[2], side: m[3], value: Number(attrs[k]) }); }
  });
  return {
    key: key,
    label: attrs['effective.' + key + '.label'] || base.label || key,
    unit: attrs['effective.' + key + '.unit'] || '',
    diagnostic: !!base.diagnostic,
    states: base.states || null,
    whenTrue: attrs['effective.' + key + '.textWhenTrue'],
    whenFalse: attrs['effective.' + key + '.textWhenFalse'],
    latest: raw ? { ts: Number(raw.ts), value: raw.value } : null,
    history: ((history && history[key]) || []).map(function (p) { return [Number(p.ts), p.value]; })
      .sort(function (a, b) { return a[0] - b[0]; }),
    bands: bands,
    alarm: null
  };
}

function loadStation(entry, spanMs) {
  var s = entry.station, url = '/api/plugins/telemetry/ASSET/' + s.id + '/values/timeseries';
  return tb.attrsMap(s).then(function (attrs) {
    var keys = Object.keys(((parseJson(attrs['config.channelMap']) || {}).channels) || {});
    var now = Date.now();
    var reads = keys.length ? [
      tb.get(url, { keys: keys.join(',') }).catch(function () { return {}; }),
      tb.get(url, { keys: keys.join(','), startTs: String(now - spanMs), endTs: String(now), limit: '2000', agg: 'NONE', orderBy: 'ASC' })
        .catch(function () { return {}; })
    ] : [{}, {}];
    reads.push(tb.get('/api/alarm/ASSET/' + s.id, { searchStatus: 'ACTIVE', pageSize: '100', page: '0' }).catch(function () { return null; }));
    return Promise.all(reads).then(function (got) {
      var channels = keys.map(function (k) { return channelOf(k, attrs, got[0] || {}, got[1] || {}); });
      var byKey = {};
      channels.forEach(function (c) { byKey[c.key] = c; });
      var others = [];
      ((got[2] && got[2].data) || []).forEach(function (a) {
        var m = CHANNEL_ALARM_RE.exec(a.type), c = m && byKey[m[1]];
        if (c) {
          if (!c.alarm || G.rank(a.severity.toLowerCase()) > G.rank(c.alarm.toLowerCase())) { c.alarm = a.severity; }
        } else {
          others.push(a);
        }
      });
      entry.channels = channels;
      entry.alarms = others;
      entry.lastTs = channels.reduce(function (m, c) { return Math.max(m, c.latest ? c.latest.ts : 0); }, 0);
      return entry;
    });
  });
}

function load() {
  var e = state.entity;
  var stations = e.kind === 'Station' ? Promise.resolve([{ station: e, location: null }]) : findStations(e);
  return stations.then(function (list) {
    var span = e.kind === 'Station' ? CHART_MS : TREND_MS;
    return Promise.all(list.map(function (x) { return loadStation(x, span); }));
  }).then(function (list) {
    state.stations = list;
    state.loadedAt = Date.now();
  });
}

// -- model ------------------------------------------------------------------------------

function worst(severities) {
  return severities.filter(Boolean).sort(function (a, b) { return G.rank(b.toLowerCase()) - G.rank(a.toLowerCase()); })[0] || null;
}

function stationSeverity(entry) {
  return worst(entry.channels.map(function (c) { return c.alarm; }).concat(entry.alarms.map(function (a) { return a.severity; })));
}

function otherAlarmText(entry, a) {
  var kind = OTHER_ALARMS.filter(function (o) { return a.type.indexOf(o.prefix) === 0; })[0];
  if (kind && kind.prefix === 'peripheralFault.') {
    var channel = entry.channels.filter(function (c) { return c.key === a.type.slice(kind.prefix.length); })[0];
    return kind.text + (channel ? ': ' + channel.label : '');
  }
  return kind ? kind.text : a.type;
}

function shown(entry) {
  return entry.channels.filter(function (c) { return state.showDiagnostic || !c.diagnostic || c.alarm; });
}

function display(c) {
  if (!c.latest) { return { text: '—', unit: '' }; }
  var v = c.latest.value;
  if (v === true || v === 'true' || v === false || v === 'false') {
    var on = v === true || v === 'true';
    return { text: (on ? c.whenTrue : c.whenFalse) || (on ? 'on' : 'off'), unit: '' };
  }
  if (c.states && c.states[String(v)] !== undefined) { return { text: c.states[String(v)], unit: '' }; }
  var n = Number(v);
  return isNaN(n) ? { text: String(v), unit: '' } : { text: fmtNumber(n), unit: c.unit };
}

function numeric(points) {
  return points.map(function (p) {
    var v = p[1] === true || p[1] === 'true' ? 1 : p[1] === false || p[1] === 'false' ? 0 : Number(p[1]);
    return [p[0], v];
  }).filter(function (p) { return isFinite(p[1]); });
}

// -- charts -----------------------------------------------------------------------------

/** An SVG polyline over `points`, scaled into w x h; bands drawn as dashed lines. */
function plot(points, w, h, bands, from, to) {
  var pts = numeric(points);
  if (pts.length < 2) { return null; }
  var ys = pts.map(function (p) { return p[1]; }).concat(bands.map(function (b) { return b.value; }));
  var lo = Math.min.apply(null, ys), hi = Math.max.apply(null, ys);
  if (hi === lo) { hi += 1; lo -= 1; }
  var pad = (hi - lo) * 0.08;
  lo -= pad; hi += pad;
  var t0 = from || pts[0][0], t1 = to || pts[pts.length - 1][0];
  function x(t) { return ((t - t0) / Math.max(1, t1 - t0) * w).toFixed(1); }
  function y(v) { return (h - (v - lo) / (hi - lo) * h).toFixed(1); }
  var lines = bands.map(function (b) {
    return '<line x1="0" x2="' + w + '" y1="' + y(b.value) + '" y2="' + y(b.value) + '" stroke="var(--sev-' + esc(b.severity) +
      ')" stroke-width="1" stroke-dasharray="4 3" vector-effect="non-scaling-stroke"/>';
  }).join('');
  var path = pts.map(function (p) { return x(p[0]) + ',' + y(p[1]); }).join(' ');
  return { lo: lo + pad, hi: hi - pad, svg: '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">' + lines +
    '<polyline points="' + path + '" fill="none" stroke="var(--ts-accent)" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>' };
}

// -- scaffold ---------------------------------------------------------------------------

var cardEl = h(
  '<div class="ts-card ts-proj">' +
  '  <div class="ts-head"><div class="ts-head-icon">' + ICON.gauge + '</div>' +
  '    <div class="ts-head-text"><div class="ts-title">Project</div><div class="ts-subtitle"></div></div>' +
  '    <span class="ts-chip ts-proj-sev" hidden></span></div>' +
  '  <div class="ts-body"><div class="ts-loading">Loading…</div></div>' +
  '  <div class="ts-foot"><span class="ts-row-meta ts-proj-updated"></span><span class="ts-spacer"></span>' +
  '    <label class="ts-proj-diag"><input type="checkbox"> Diagnostic readings</label>' +
  '    <button type="button" class="ts-btn">Refresh</button></div>' +
  '</div>');
root.appendChild(cardEl);
var bodyEl = cardEl.querySelector('.ts-body');
var refreshBtn = cardEl.querySelector('.ts-foot .ts-btn');
var diagBox = cardEl.querySelector('.ts-proj-diag input');

function fail(text) {
  bodyEl.innerHTML = '';
  bodyEl.appendChild(h('<div class="ts-empty"></div>')).textContent = text;
}

function sevChip(el, severity, noData) {
  el.hidden = false;
  if (noData && !severity) {
    el.className = 'ts-chip ts-proj-sev';
    el.textContent = 'No data';
  } else if (severity) {
    el.className = 'ts-chip ts-proj-sev alarm';
    el.style.setProperty('--sev', 'var(--sev-' + severity.toLowerCase() + ')');
    el.textContent = G.severity(severity.toLowerCase()).label;
  } else {
    el.className = 'ts-chip ts-proj-sev ok';
    el.style.removeProperty('--sev');
    el.textContent = 'OK';
  }
}

function openStation(entry) {
  var sc = ctx.stateController;
  if (!sc) { return; }
  sc.openState('station', { entityId: { entityType: 'ASSET', id: entry.station.id }, entityName: entry.station.name }, false);
}

// -- render -----------------------------------------------------------------------------

function render() {
  var e = state.entity;
  var single = e.kind === 'Station';
  cardEl.querySelector('.ts-title').textContent = single ? 'Station' : e.kind === 'Location' ? 'Location' : 'Project';
  cardEl.querySelector('.ts-subtitle').textContent = e.name + (single ? '' : ' · ' + state.stations.length +
    (state.stations.length === 1 ? ' station' : ' stations'));
  sevChip(cardEl.querySelector('.ts-proj-sev'), worst(state.stations.map(stationSeverity)));
  cardEl.querySelector('.ts-proj-updated').textContent = 'Updated ' + fmtDate(state.loadedAt);
  var hidden = state.stations.reduce(function (n, s) { return n + s.channels.filter(function (c) { return c.diagnostic && !c.alarm; }).length; }, 0);
  diagBox.parentNode.hidden = !hidden && !state.showDiagnostic;

  bodyEl.innerHTML = '';
  if (!state.stations.length) { fail('No station in this ' + e.kind.toLowerCase() + ' yet.'); return; }
  if (single) { renderStation(state.stations[0]); return; }

  var groupEl = null, current;
  state.stations.forEach(function (entry) {
    if (!groupEl || entry.location !== current) {
      current = entry.location;
      if (current) { bodyEl.appendChild(h('<div class="ts-section-head ts-proj-loc"></div>')).textContent = current; }
      groupEl = bodyEl.appendChild(h('<div class="ts-proj-grid"></div>'));
    }
    groupEl.appendChild(stationCard(entry));
  });
}

function stationCard(entry) {
  var sev = stationSeverity(entry);
  var el = h('<div class="ts-st" tabindex="0" role="button"><div class="ts-st-head"><span class="ts-st-name"></span>' +
    '<span class="ts-chip ts-proj-sev"></span></div><div class="ts-row-meta ts-st-when"></div><div class="ts-st-rows"></div></div>');
  el.setAttribute('data-station', entry.station.name);
  el.querySelector('.ts-st-name').textContent = entry.station.name;
  sevChip(el.querySelector('.ts-proj-sev'), sev, !entry.lastTs);
  el.querySelector('.ts-st-when').textContent = entry.lastTs ? 'Last reading ' + ago(entry.lastTs) : 'No reading yet';
  var rows = el.querySelector('.ts-st-rows');
  var list = shown(entry);
  if (!list.length) { rows.appendChild(h('<div class="ts-empty">No channel mapped yet.</div>')); }
  list.forEach(function (c) {
    var d = display(c);
    var row = h('<div class="ts-st-row"><span class="ts-st-label"></span><span class="ts-st-spark"></span>' +
      '<span class="ts-st-value"><b></b> <small></small></span></div>');
    row.setAttribute('data-channel', c.key);
    if (c.alarm) { row.classList.add('alarm'); row.style.setProperty('--sev', 'var(--sev-' + c.alarm.toLowerCase() + ')'); }
    row.querySelector('.ts-st-label').textContent = c.label;
    row.querySelector('b').textContent = d.text;
    row.querySelector('small').textContent = d.unit;
    var p = plot(c.history, 100, 24, [], Date.now() - TREND_MS, Date.now());
    if (p) { row.querySelector('.ts-st-spark').innerHTML = p.svg; }
    rows.appendChild(row);
  });
  entry.alarms.forEach(function (a) {
    var row = h('<div class="ts-st-other"></div>');
    row.style.setProperty('--sev', 'var(--sev-' + a.severity.toLowerCase() + ')');
    row.textContent = otherAlarmText(entry, a);
    rows.appendChild(row);
  });
  el.addEventListener('click', function () { openStation(entry); });
  el.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { openStation(entry); } });
  return el;
}

function renderStation(entry) {
  if (entry.alarms.length) {
    var box = bodyEl.appendChild(h('<div class="ts-section"><div class="ts-section-head">Station alarms</div></div>'));
    entry.alarms.forEach(function (a) {
      var row = h('<div class="ts-st-other"></div>');
      row.style.setProperty('--sev', 'var(--sev-' + a.severity.toLowerCase() + ')');
      row.textContent = otherAlarmText(entry, a) + ' · since ' + fmtDate(a.startTs || a.createdTime);
      box.appendChild(row);
    });
  }
  var list = shown(entry);
  if (!list.length) { bodyEl.appendChild(h('<div class="ts-empty">No channel mapped yet.</div>')); return; }
  var grid = bodyEl.appendChild(h('<div class="ts-proj-charts"></div>'));
  var to = Date.now(), from = to - CHART_MS;
  list.forEach(function (c) {
    var d = display(c);
    var el = h('<div class="ts-chart"><div class="ts-chart-head"><span class="ts-st-label"></span>' +
      '<span class="ts-st-value"><b></b> <small></small></span></div><div class="ts-chart-body"><div class="ts-chart-y"></div>' +
      '<div class="ts-chart-plot"></div></div><div class="ts-chart-x"><span></span><span></span></div></div>');
    el.setAttribute('data-channel', c.key);
    if (c.alarm) { el.classList.add('alarm'); el.style.setProperty('--sev', 'var(--sev-' + c.alarm.toLowerCase() + ')'); }
    el.querySelector('.ts-st-label').textContent = c.label;
    el.querySelector('b').textContent = d.text;
    el.querySelector('small').textContent = d.unit + (c.latest ? ' · ' + ago(c.latest.ts) : '');
    var p = plot(c.history, 300, 90, c.bands, from, to);
    if (p) {
      el.querySelector('.ts-chart-plot').innerHTML = p.svg;
      el.querySelector('.ts-chart-y').innerHTML = '<span>' + esc(fmtNumber(p.hi)) + '</span><span>' + esc(fmtNumber(p.lo)) + '</span>';
      var x = el.querySelectorAll('.ts-chart-x span');
      x[0].textContent = fmtDate(from);
      x[1].textContent = fmtDate(to);
    } else {
      el.querySelector('.ts-chart-plot').appendChild(h('<div class="ts-empty">Not enough readings in the last 7 days.</div>'));
    }
    grid.appendChild(el);
  });
}

// -- load -------------------------------------------------------------------------------

var timer = null;
function refresh() {
  if (!root.isConnected && timer) { clearInterval(timer); return Promise.resolve(); }
  refreshBtn.disabled = true;
  return load().then(render).catch(function (err) {
    ui.toast('Refresh failed: ' + (err && err.message ? err.message : err), 'error');
  }).then(function () { refreshBtn.disabled = false; });
}
refreshBtn.addEventListener('click', refresh);
diagBox.addEventListener('change', function () { state.showDiagnostic = diagBox.checked; render(); });

tb.boundDatasource().then(function (ds) {
  if (!ds || ds.entityType !== 'ASSET') { fail('No project bound — bind a project, location or station in the widget\'s Data tab.'); return; }
  return Promise.all([tb.loadEntity(ds), loadNames()]).then(function (got) {
    state.entity = got[0];
    return load();
  }).then(function () {
    render();
    timer = setInterval(refresh, REFRESH_MS);
  });
}).catch(function (err) { fail('Could not load: ' + (err && err.message ? err.message : err)); });

};
