/*
 * Firmware — the firmware releases a technician downloads for the LOGR
 * companion app, read from the ThingsBoard OTA packages.
 * Contract: logr-product-docs/FIRMWARE_DELIVERY.md §3 (index fields), §6 (LOGR2).
 *
 * One card per bundle family: a LOGR3/LOGR4 board revision, or a LOGR2 sensor
 * firmware with one download per board revision. The highest version is the
 * download; the other versions stay listed under it. A pre-release is shown only
 * when no final release of that family exists.
 *
 * Loads after shared/resolver.js, glossary.js, ui.js and tb_io.js.
 */

window.TerrySenseFirmware = function (ctx, container, opts) {

opts = opts || {};

var t = window.TerrySenseI18n(ctx);
var tb = window.TerrySenseTbIo(ctx);
var root = container.querySelector('.ts-root') || container;
var ui = window.TerrySenseUi(root);
var h = ui.h, esc = ui.esc, ICON = ui.ICON;

var ICON_CHIP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="1"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/></svg>';
var ICON_DOWNLOAD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>';

var TITLE = /^(LOGR(\d+)(?:\.\d+)+)_(logr2?-fw)(?:_(.+))?$/;

/** Semantic-version order; a pre-release sorts below its release. */
function compareVersions(a, b) {
  function parts(v) {
    var m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(v) || [];
    return { nums: [+m[1] || 0, +m[2] || 0, +m[3] || 0], pre: m[4] || null };
  }
  var x = parts(a), y = parts(b);
  for (var i = 0; i < 3; i++) { if (x.nums[i] !== y.nums[i]) { return x.nums[i] - y.nums[i]; } }
  if (x.pre === y.pre) { return 0; }
  if (x.pre === null) { return 1; }
  if (y.pre === null) { return -1; }
  return x.pre < y.pre ? -1 : 1;
}

function isFinal(v) { return /^\d+\.\d+\.\d+$/.test(v); }

function boardOrder(a, b) { return compareVersions(a.replace(/^LOGR/, '') + '.0.0', b.replace(/^LOGR/, '') + '.0.0'); }

/** OTA packages → families, each { key, generation, name, boards: { board: [package…] } }. */
function families(packages) {
  var byKey = {};
  packages.forEach(function (p) {
    var m = TITLE.exec(p.title || '');
    if (!m || !p.url) { return; }
    var board = m[1], generation = +m[2], sensor = m[4] || '';
    var key = sensor ? 'LOGR' + generation + ' ' + sensor : board;
    var fam = byKey[key] = byKey[key] || { key: key, generation: generation, sensor: sensor, boards: {} };
    (fam.boards[board] = fam.boards[board] || []).push(p);
  });
  return Object.keys(byKey).map(function (k) {
    var fam = byKey[k];
    Object.keys(fam.boards).forEach(function (b) {
      fam.boards[b].sort(function (x, y) { return compareVersions(y.version, x.version); });
    });
    return fam;
  }).sort(function (a, b) { return b.generation - a.generation || a.key.localeCompare(b.key); });
}

/** The package a technician should take: the highest final, else the highest pre-release. */
function current(list) {
  return list.filter(function (p) { return isFinal(p.version); })[0] || list[0];
}

function imageLine(p) {
  var manifest = (p.additionalInfo || {}).manifest;
  if (!manifest || !manifest.images) { return ''; }
  return manifest.images.map(function (i) { return esc(i.name) + ' ' + esc(i.version); }).join(' · ');
}

function downloadLink(p, label) {
  var a = h('<a class="ts-btn ts-fw-dl" target="_blank" rel="noopener">' + ICON_DOWNLOAD + '<span></span></a>');
  a.href = p.url;
  a.querySelector('span').textContent = label;
  a.title = p.url.split('/').pop();
  return a;
}

function bundleCard(fam) {
  var board = Object.keys(fam.boards)[0];
  var list = fam.boards[board], top = current(list);
  var card = h('<div class="ts-fw-fam"><div class="ts-fw-head"><span class="ts-fw-name"></span>' +
    '<span class="ts-chip accent"></span></div><div class="ts-fw-body"></div></div>');
  card.querySelector('.ts-fw-name').textContent = board;
  card.querySelector('.ts-chip').textContent = isFinal(top.version) ? top.version : t('firmware.preRelease', '{version} · pre-release', { version: top.version });
  var body = card.querySelector('.ts-fw-body');
  var row = body.appendChild(h('<div class="ts-fw-row"><div class="ts-fw-main"><div class="ts-fw-images"></div>' +
    '<div class="ts-fw-notes"></div></div></div>'));
  row.querySelector('.ts-fw-images').innerHTML = imageLine(top) || 'logic + power';
  row.querySelector('.ts-fw-notes').textContent = (top.additionalInfo || {}).description || '';
  row.appendChild(downloadLink(top, t('firmware.download', 'Download')));
  others(body, list.filter(function (p) { return p !== top; }), function (p) { return p.version; });
  return card;
}

function sensorCard(fam) {
  var boards = Object.keys(fam.boards).sort(boardOrder);
  var tops = boards.map(function (b) { return current(fam.boards[b]); });
  var versions = tops.map(function (p) { return p.version; }).filter(function (v, i, all) { return all.indexOf(v) === i; });
  var card = h('<div class="ts-fw-fam"><div class="ts-fw-head"><span class="ts-fw-name"></span>' +
    '<span class="ts-chip accent"></span></div><div class="ts-fw-body"><div class="ts-fw-boards"></div></div></div>');
  card.querySelector('.ts-fw-name').textContent = fam.key.replace(/_/g, ' ');
  card.querySelector('.ts-chip').textContent = versions.join(' / ');
  var row = card.querySelector('.ts-fw-boards');
  boards.forEach(function (b, i) {
    row.appendChild(downloadLink(tops[i], b + (versions.length > 1 ? ' · ' + tops[i].version : '')));
  });
  var rest = [];
  boards.forEach(function (b, i) {
    fam.boards[b].forEach(function (p) { if (p !== tops[i]) { rest.push(p); } });
  });
  others(card.querySelector('.ts-fw-body'), rest, function (p) { return p.tag + ' · ' + p.version; });
  return card;
}

function others(body, list, label) {
  if (!list.length) { return; }
  var box = body.appendChild(h('<details class="ts-fw-others"><summary></summary><div class="ts-fw-boards"></div></details>'));
  box.querySelector('summary').textContent = list.length === 1 ? t('firmware.othersOne', '1 other version') : t('firmware.othersMany', '{n} other versions', { n: list.length });
  list.forEach(function (p) { box.querySelector('.ts-fw-boards').appendChild(downloadLink(p, label(p))); });
}

root.innerHTML =
  '<div class="ts-card ts-fw">' +
  '  <div class="ts-head"><div class="ts-head-icon">' + ICON_CHIP + '</div>' +
  '    <div class="ts-head-text"><div class="ts-title">' + esc(t('nav.firmware', 'Firmware')) + '</div><div class="ts-subtitle"></div></div></div>' +
  '  <div class="ts-body">' +
  '    <div class="ts-fw-hint">' + esc(t('firmware.hint', 'Install with the LOGR companion app: it finds the firmware for a unit by itself. Download a file here only to install it by hand.')) + '</div>' +
  '    <div class="ts-search">' + ICON.search + '<input class="ts-input" placeholder="' + esc(t('firmware.search', 'Search by board or sensor')) + '"></div>' +
  '    <div class="ts-fw-list"><div class="ts-loading">' + esc(t('common.loading', 'Loading…')) + '</div></div>' +
  '  </div></div>';
var cardEl = root.querySelector('.ts-fw');
window.TerrySenseNav(ctx, tb, ui, cardEl, opts);
var listEl = root.querySelector('.ts-fw-list');
var input = root.querySelector('.ts-input');

function render(all) {
  var tokens = input.value.toLowerCase().split(/\s+/).filter(Boolean);
  listEl.innerHTML = '';
  var shown = all.filter(function (fam) {
    var text = (fam.key + ' ' + Object.keys(fam.boards).join(' ')).toLowerCase().replace(/_/g, ' ');
    return tokens.every(function (t) { return text.indexOf(t) >= 0; });
  });
  if (!shown.length) {
    listEl.appendChild(h('<div class="ts-empty"></div>')).textContent = all.length ? t('firmware.noMatch', 'No firmware matches.') : t('firmware.none', 'No firmware published yet.');
    return;
  }
  var generation = null, section = null;
  shown.forEach(function (fam) {
    if (fam.generation !== generation) {
      generation = fam.generation;
      section = listEl.appendChild(h('<div class="ts-section"><div class="ts-section-head"></div><div class="ts-fw-grid"></div></div>'));
      section.querySelector('.ts-section-head').textContent = generation >= 4
        ? t('firmware.together', 'LOGR{n} · logic and power together', { n: generation }) : 'LOGR' + generation;
      section = section.querySelector('.ts-fw-grid');
    }
    section.appendChild(fam.sensor ? sensorCard(fam) : bundleCard(fam));
  });
}

tb.getAll('/api/otaPackages').then(function (packages) {
  var all = families((packages || []).filter(function (p) { return p.type === 'FIRMWARE'; }));
  var n = all.length;
  cardEl.querySelector('.ts-subtitle').textContent = n === 1 ? t('firmware.countOne', '1 firmware') : t('firmware.countMany', '{n} firmwares', { n: n });
  input.addEventListener('input', function () { render(all); });
  render(all);
}).catch(function (err) {
  listEl.innerHTML = '';
  listEl.appendChild(h('<div class="ts-empty ts-error"></div>')).textContent =
    t('firmware.loadFailed', 'The firmware list could not load: {error}', { error: (err && err.status) || err });
});

};
