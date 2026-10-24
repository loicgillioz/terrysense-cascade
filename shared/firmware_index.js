/*
 * The instance's public firmware index and the version order —
 * `window.TerrySenseFirmwareIndex`, for the firmware widget and the device view.
 * Contract: logr-product-docs/FIRMWARE_DELIVERY.md §2 (version order), §3 (index).
 */
(function (root) {
'use strict';

var INDEX_BASE = 'https://git.in-terra.ch/api/v4/projects/project%2Flogr%2Ffirmware-logr-releases/packages/generic/logr-fw-index/';
var loading = null;

/** Production's index on the production host, staging's everywhere else. */
function url() {
  return INDEX_BASE + (root.location.hostname === 'sense.terryspace.io' ? 'production' : 'staging') + '/index.json';
}

/** The index, fetched once per page; no index yet is an empty one. */
function load() {
  // No credentials: the index is public and GitLab answers any origin.
  loading = loading || fetch(url(), { cache: 'no-store', credentials: 'omit' }).then(function (r) {
    if (r.status === 404) { return { boards: {} }; }
    if (!r.ok) { throw { status: r.status }; }
    return r.json();
  });
  loading.catch(function () { loading = null; });
  return loading;
}

/** The tag form of a version: `1.0.1-dev+16` is `1.0.1-dev16`, `1.0.1+0` is `1.0.1`. */
function tagForm(v) {
  return String(v || '').trim().replace(/^v/, '').replace(/-(dev|rc)\+(\d+)$/, '-$1$2').replace(/\+\d+$/, '');
}

/** The order of FIRMWARE_DELIVERY.md §2: X.Y.Z, then -devN < -rcN < final, N as a number. */
function compare(a, b) {
  function parts(v) {
    var m = /^(\d+)\.(\d+)\.(\d+)(?:-(dev|rc)(\d+))?$/.exec(tagForm(v)) || [];
    return [+m[1] || 0, +m[2] || 0, +m[3] || 0, m[4] === 'dev' ? 0 : m[4] === 'rc' ? 1 : 2, +m[5] || 0];
  }
  var x = parts(a), y = parts(b);
  for (var i = 0; i < 5; i++) { if (x[i] !== y[i]) { return x[i] - y[i]; } }
  return 0;
}

function isFinal(v) { return /^\d+\.\d+\.\d+$/.test(v); }

/** The entry a technician should take from `list`, highest first: the highest final, else the highest pre-release. */
function current(list) {
  return list.filter(function (p) { return isFinal(p.version); })[0] || list[0];
}

/** The index board of a device's hardware version (`4.0.2`, `v2.6.2`): the most
 * specific revision the index lists, `LOGR2.6` for a `v2.6.2` it does not. */
function boardOf(boards, hw) {
  var parts = String(hw || '').replace(/^\D+/, '').split('.');
  for (var n = parts.length; n >= 2; n--) {
    var board = 'LOGR' + parts.slice(0, n).join('.');
    if (boards[board]) { return board; }
  }
  return null;
}

/** What the index offers a device running `fw` on hardware `hw`: { version, final }
 * of the newer release, `version` null when only "newer" is certain, or null when
 * the device is current or the index lists nothing for its board. A LOGR2's
 * entries are per sensor firmware and the device does not report its own, so it
 * counts as outdated only when every sensor firmware of its board is newer. */
function updateFor(index, hw, fw) {
  var board = fw && boardOf((index && index.boards) || {}, hw);
  if (!board) { return null; }
  var bySensor = {};
  index.boards[board].forEach(function (e) { (bySensor[e.sensor || ''] = bySensor[e.sensor || ''] || []).push(e); });
  var tops = Object.keys(bySensor).map(function (s) {
    return current(bySensor[s].sort(function (x, y) { return compare(y.version, x.version); }));
  }).sort(function (x, y) { return compare(x.version, y.version); });
  if (!tops.length || compare(tops[0].version, fw) <= 0) { return null; }
  var one = tops.length === 1;
  return { version: one ? tops[0].version : null, final: isFinal(tops[0].version) };
}

// A DRYC reports no board revision: the app assumes this one (FIRMWARE_DELIVERY.md §10).
var DRYC_BOARD = 'DRYC3.0.0';

function core(v) { return tagForm(v).replace(/-.*$/, ''); }

/** What the index offers a DRYC running `fw` (`major.minor.patch`, the core only): { version, final }
 * when the entry to take has a higher core, else null; one core's pre-releases cannot be ordered. */
function drycUpdateFor(index, fw) {
  var list = fw && ((index && index.boards) || {})[DRYC_BOARD];
  if (!list || !list.length) { return null; }
  var top = current(list.slice().sort(function (x, y) { return compare(y.version, x.version); }));
  return compare(core(top.version), core(fw)) > 0 ? { version: top.version, final: isFinal(top.version) } : null;
}

root.TerrySenseFirmwareIndex = { url: url, load: load, compare: compare, isFinal: isFinal, current: current, updateFor: updateFor,
  drycUpdateFor: drycUpdateFor };
})(window);
