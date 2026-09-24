/*
 * Config overrides — the CA-2/CA-3 widget. One widget type, used at CUSTOMER,
 * PROJECT, LOCATION and STATION level: lists the cascade overrides set on the
 * bound entity, shows what each one replaces, and adds/edits/removes them.
 *
 * Same runtime shape as `alarm_cascade_editor/controller.js` (html_container,
 * Plain-HTML mode, `window.<fn>(ctx, container)`, services reached through
 * `ctx.$scope.$injector.get(ctx.servicesMap.get('<name>'))`) — see that
 * file's header and `terrysense/operations/widget_deploy.py`'s module
 * docstring for the ThingsBoard quirks behind that shape. This widget adds
 * one more resource dependency: `resources/widgets/shared/resolver.js` must
 * be loaded first (the deploy script lists it before this file), since all
 * cascade logic here is `window.TerrySenseResolver`, not reimplemented.
 *
 * CUSTOMER level also reads the tenant-wide DEFAULTS asset (a tenant-owned
 * asset of type `Defaults`, shared read-only with customers — found via
 * `GET /api/user/assets?type=Defaults`, the one lookup here with no
 * documented Angular service wrapper, so it goes through the injected `http`
 * client directly) and shows its values as greyed, read-only rows.
 */

window.TerrySenseConfigOverrides = function (ctx, container) {

var resolver = window.TerrySenseResolver;

function getService(name) {
  return ctx.$scope.$injector.get(ctx.servicesMap.get(name));
}

function toPromise(observable) {
  return new Promise(function (resolve, reject) {
    observable.subscribe({ next: function (v) { resolve(v); }, error: function (e) { reject(e); } });
  });
}

function entityIdObj(entityType, id) { return { entityType: entityType, id: id }; }

// -- IO: the resolver's contract, backed by real ThingsBoard services -------

function getAttrsMap(entityType, id) {
  return toPromise(getService('attributeService').getEntityAttributes(entityIdObj(entityType, id), 'SERVER_SCOPE'))
    .then(function (list) {
      var map = {};
      (list || []).forEach(function (a) { map[a.key] = a.value; });
      return map;
    })
    .catch(function () { return {}; });
}

function httpGet(url, params) {
  return toPromise(getService('http').get(url, { params: params }));
}

function findParentAssetId(assetId) {
  var query = {
    parameters: { rootId: assetId, rootType: 'ASSET', direction: 'TO', relationTypeGroup: 'COMMON', maxLevel: 1, fetchLastLevelOnly: false },
    filters: [{ relationType: 'Contains', entityTypes: ['ASSET'] }]
  };
  return toPromise(getService('entityRelationService').findByQuery(query)).then(function (relations) {
    return relations && relations.length ? relations[0].from.id : null;
  });
}

function getAsset(id) {
  return toPromise(getService('assetService').getAsset(id));
}

var defaultsPromise = null;

var io = {
  fetchAttrs: function (entity) { return getAttrsMap(entity.entityType, entity.id); },

  fetchParent: function (entity) {
    return findParentAssetId(entity.id).then(function (parentId) {
      if (!parentId) { return null; }
      return getAsset(parentId).then(function (asset) {
        return { entityType: 'ASSET', id: asset.id.id, name: asset.name, kind: asset.type };
      });
    });
  },

  fetchChildren: function (entity) {
    var query = {
      parameters: { rootId: entity.id, rootType: 'ASSET', direction: 'FROM', relationTypeGroup: 'COMMON', maxLevel: 1, fetchLastLevelOnly: false },
      filters: [{ relationType: 'Contains', entityTypes: ['ASSET'] }]
    };
    return toPromise(getService('entityRelationService').findByQuery(query)).then(function (relations) {
      var ids = {};
      (relations || []).forEach(function (r) { if (r.to.entityType === 'ASSET') { ids[r.to.id] = true; } });
      return Promise.all(Object.keys(ids).map(function (id) { return getAsset(id); }));
    }).then(function (assets) {
      return assets.map(function (a) { return { entityType: 'ASSET', id: a.id.id, name: a.name, kind: a.type }; });
    });
  },

  // `ownerId` (not `customerId`) is the immediate-owner field ThingsBoard PE
  // stamps on every asset — `{id, entityType: 'CUSTOMER'|'TENANT'}` — and
  // what config_resolver.py's `_ancestors_nearest_first` reads for the same
  // lookup, so the two resolvers agree on which entity is "the customer".
  fetchCustomer: function (entity) {
    return getAsset(entity.id).then(function (asset) {
      var owner = asset.ownerId;
      if (!owner || owner.entityType !== 'CUSTOMER') { return null; }
      return toPromise(getService('customerService').getCustomer(owner.id)).then(function (customer) {
        return { entityType: 'CUSTOMER', id: owner.id, name: customer.title || customer.name };
      });
    });
  },

  fetchDefaults: function () {
    if (!defaultsPromise) {
      defaultsPromise = httpGet('/api/user/assets', { type: 'Defaults', pageSize: '1', page: '0' }).then(function (page) {
        var item = page && page.data && page.data[0];
        if (!item) { return null; }
        return { entityType: 'ASSET', id: item.id.id, name: item.name };
      }).catch(function () { return null; });
    }
    return defaultsPromise;
  },

  // Ownership is orthogonal to `Contains` (ENTITY_MODEL.md §1) — a customer's
  // stations are found by asset ownership, not by walking relations from the
  // CUSTOMER entity (which has none).
  fetchCustomerStations: function (customer) {
    return httpGet('/api/customer/' + customer.id + '/assets', { type: 'Station', pageSize: '1000', page: '0' }).then(function (page) {
      return ((page && page.data) || []).map(function (a) { return { entityType: 'ASSET', id: a.id.id, name: a.name, kind: a.type }; });
    });
  }
};

function saveAttrs(entity, attrs) {
  var pairs = Object.keys(attrs).map(function (k) { return { key: k, value: attrs[k] }; });
  if (!pairs.length) { return Promise.resolve(); }
  return toPromise(getService('attributeService').saveEntityAttributes(entityIdObj(entity.entityType, entity.id), 'SERVER_SCOPE', pairs));
}

function deleteAttrs(entity, keys) {
  if (!keys.length) { return Promise.resolve(); }
  return toPromise(getService('attributeService').deleteEntityAttributes(entityIdObj(entity.entityType, entity.id), 'SERVER_SCOPE', keys));
}

// -- DOM ----------------------------------------------------------------

var root = container;
var els = {
  title: root.querySelector('.co-title'),
  status: root.querySelector('.co-status'),
  loading: root.querySelector('.co-loading'),
  message: root.querySelector('.co-message'),
  table: root.querySelector('.co-table'),
  own: root.querySelector('.co-own'),
  defaultsHead: root.querySelector('.co-defaults-head'),
  defaults: root.querySelector('.co-defaults'),
  add: root.querySelector('.co-add'),

  dialogBackdrop: root.querySelector('.co-dialog-backdrop'),
  dialogTitle: root.querySelector('.co-dialog-title'),
  category: root.querySelector('.co-category'),
  stepTarget: root.querySelector('.co-step-target'),
  targetMode: root.querySelector('.co-target-mode'),
  targetValue: root.querySelector('.co-target-value'),
  stepValue: root.querySelector('.co-step-value'),
  valueLabel: root.querySelector('.co-value-label'),
  valueInherited: root.querySelector('.co-value-inherited'),
  valueInput: root.querySelector('.co-value-input'),
  valueList: root.querySelector('.co-value-list'),
  listRows: root.querySelector('.co-list-rows'),
  listAdd: root.querySelector('.co-list-add'),
  valueBool: root.querySelector('.co-value-bool'),
  tokens: root.querySelector('.co-tokens'),
  tokensList: root.querySelector('.co-tokens-list'),
  dialogMessage: root.querySelector('.co-dialog-message'),
  dialogCancel: root.querySelector('.co-dialog-cancel'),
  dialogSave: root.querySelector('.co-dialog-save'),

  confirmBackdrop: root.querySelector('.co-confirm-backdrop'),
  confirmText: root.querySelector('.co-confirm-text'),
  confirmCancel: root.querySelector('.co-confirm-cancel'),
  confirmOk: root.querySelector('.co-confirm-ok')
};

var state = {
  origin: null,        // {entityType, id, name, kind}
  ownAttrs: {},
  channelKinds: {},     // {channel: wireKind}
  dictionaryKinds: [],  // wire kinds named in the channel-name dictionary
  editingKey: null      // set when the dialog is editing an existing row, else null (adding)
};

function setMessage(text, cls) {
  els.message.hidden = !text;
  els.message.textContent = text || '';
  els.message.className = 'co-message' + (cls ? ' ' + cls : '');
}

// -- formatting -----------------------------------------------------------

function formatValue(category, value) {
  if (category && category.list && Array.isArray(value)) { return value.join(', '); }
  if (category && category.boolean) { return value === true || value === 'true' ? 'On' : 'Off'; }
  return value === null || value === undefined ? '—' : String(value);
}

function descriptorFromParsed(parsed) {
  if (parsed.axis === 'config') { return { axis: 'config', field: parsed.field }; }
  if (parsed.axis === 'channel') { return { axis: 'channel', channel: parsed.target, kind: state.channelKinds[parsed.target], field: parsed.field }; }
  return { axis: 'kind', kind: parsed.target, field: parsed.field };
}

// -- render: existing overrides -------------------------------------------

function renderRow(tbody, key, value, options) {
  options = options || {};
  var desc = resolver.describeOverride(key);
  var tr = document.createElement('tr');
  if (options.readOnly) { tr.className = 'co-row-default'; }

  var tdLabel = document.createElement('td'); tdLabel.textContent = desc.label;
  var tdValue = document.createElement('td'); tdValue.textContent = formatValue(desc.category, value);
  var tdReplaces = document.createElement('td'); tdReplaces.className = 'co-replaces'; tdReplaces.textContent = options.replacesText || '';
  var tdActions = document.createElement('td'); tdActions.className = 'co-row-actions';

  if (!options.readOnly) {
    var editBtn = document.createElement('button'); editBtn.type = 'button'; editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', function () { openDialog(key); });
    var removeBtn = document.createElement('button'); removeBtn.type = 'button'; removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', function () { removeOverride(key); });
    tdActions.appendChild(editBtn); tdActions.appendChild(removeBtn);
  }

  tr.appendChild(tdLabel); tr.appendChild(tdValue); tr.appendChild(tdReplaces); tr.appendChild(tdActions);
  tbody.appendChild(tr);
}

function renderOwnRows() {
  els.own.innerHTML = '';
  var overrides = resolver.listOverrides(state.ownAttrs);
  if (!overrides.length) {
    els.own.innerHTML = '<tr><td colspan="4">No overrides set on this entity.</td></tr>';
    return Promise.resolve();
  }
  var work = Promise.resolve();
  overrides.forEach(function (o) {
    work = work.then(function () {
      var parsed = resolver.parseOverrideKey(o.key);
      var descriptor = parsed ? descriptorFromParsed(parsed) : null;
      var lookup = descriptor ? resolver.inheritedValue(state.origin, descriptor, io) : Promise.resolve(null);
      return lookup.then(function (hit) {
        var replacesText = hit ? ('replaces ' + formatValue(resolver.describeOverride(o.key).category, hit.value) + ' from ' + hit.source) : 'no inherited value';
        renderRow(els.own, o.key, o.value, { replacesText: replacesText });
      });
    });
  });
  return work;
}

function renderDefaultsRows(defaultsAttrs) {
  var isCustomer = state.origin.entityType === 'CUSTOMER';
  els.defaultsHead.hidden = !isCustomer;
  els.defaults.innerHTML = '';
  if (!isCustomer) { return; }
  var ownKeys = Object.keys(state.ownAttrs);
  var rows = resolver.listOverrides(defaultsAttrs).filter(function (o) { return ownKeys.indexOf(o.key) < 0; });
  rows.forEach(function (o) { renderRow(els.defaults, o.key, o.value, { readOnly: true }); });
}

// -- load -------------------------------------------------------------------

function resolveOriginatorDatasource() {
  var live = ctx.datasources && ctx.datasources[0];
  if (live && live.entityId) { return Promise.resolve(live); }
  var configured = ctx.widget && ctx.widget.config && ctx.widget.config.datasources;
  if (!configured || !configured.length) { return Promise.resolve(null); }
  return toPromise(ctx.aliasController.resolveDatasources(JSON.parse(JSON.stringify(configured)), true))
    .then(function (resolved) { return (resolved || []).filter(function (d) { return d && d.entityId; })[0] || null; });
}

function loadOrigin(ds) {
  if (ds.entityType === 'CUSTOMER') {
    return toPromise(getService('customerService').getCustomer(ds.entityId)).then(function (customer) {
      return { entityType: 'CUSTOMER', id: ds.entityId, name: customer.title || customer.name, kind: 'Customer' };
    });
  }
  return getAsset(ds.entityId).then(function (asset) {
    return { entityType: 'ASSET', id: ds.entityId, name: asset.name, kind: asset.type };
  });
}

function load() {
  els.loading.hidden = false;
  els.table.hidden = true;
  setMessage('');

  resolveOriginatorDatasource().then(function (ds) {
    if (!ds) {
      els.loading.textContent = 'No entity bound to this widget — bind a CUSTOMER, PROJECT, LOCATION or STATION in the widget\'s Data tab.';
      return;
    }
    return loadOrigin(ds).then(function (origin) {
      state.origin = origin;
      els.title.textContent = origin.kind + ' · ' + origin.name;

      return Promise.all([
        io.fetchAttrs(origin),
        resolver.discoverChannels(origin, io),
        io.fetchDefaults().then(function (d) { return d ? io.fetchAttrs(d) : {}; })
      ]).then(function (results) {
        state.ownAttrs = results[0];
        state.channelKinds = results[1].channels;
        var defaultsAttrs = results[2];
        state.dictionaryKinds = dictionaryKinds(defaultsAttrs['config.channelNames']);

        return resolver.buildChain(origin, io).then(function (chain) {
          els.status.textContent = 'inherits from: ' + chain.slice(1).map(resolver.levelDisplay).join(' → ') || 'nothing above this level';
          // Every chain ends at the Defaults asset (config_resolver.py's
          // `_ancestors_nearest_first` raises if it is missing entirely); its
          // absence *here* means this customer has no read access to it yet
          // (the "Shared defaults" entity group was never shared with them) —
          // worth surfacing since every kind-axis fallback silently stops
          // working, not just the greyed CUSTOMER-level rows.
          if (!chain.some(function (l) { return l.role === 'defaults'; })) {
            setMessage('The in-terra defaults are not shared with this customer yet — kind-wide fallbacks will not resolve until a tenant admin shares them.', 'co-error');
          }
        }).then(function () {
          return renderOwnRows();
        }).then(function () {
          renderDefaultsRows(defaultsAttrs);
          els.loading.hidden = true;
          els.table.hidden = false;
        });
      });
    });
  }).catch(function (err) {
    els.loading.textContent = 'Failed to load: ' + (err && err.message ? err.message : err);
  });
}

// -- save / remove: write the key, fan out effective.* -----------------

function applyToAffectedStations() {
  return resolver.affectedStations(state.origin, io).then(function (stations) {
    function resolveAndApply(station) {
      return Promise.all([resolver.resolveStation(station, io), io.fetchAttrs(station)]).then(function (r) {
        var resolved = r[0], currentAttrs = r[1];
        var diff = resolver.effectiveDiff(currentAttrs, resolved);
        return saveAttrs(station, diff.toWrite).then(function () { return deleteAttrs(station, diff.toDelete); });
      });
    }

    function runAll() {
      return Promise.all(stations.map(resolveAndApply)).then(function () {
        setMessage(stations.length + ' station(s) updated.', 'co-ok');
        return load();
      });
    }

    if (stations.length > 1) {
      return confirmDialog(
        'This override applies to ' + stations.length + ' stations here. Apply the change to all of them?'
      ).then(function (confirmed) {
        if (!confirmed) { setMessage('Cancelled — no changes were written to any station.'); return; }
        return runAll();
      });
    }
    return runAll();
  });
}

function saveOverride(key, value) {
  setMessage('Saving…');
  var attrs = {}; attrs[key] = value;
  return saveAttrs(state.origin, attrs)
    .then(function () { return applyToAffectedStations(); })
    .catch(function (err) { setMessage('Save failed: ' + (err && err.message ? err.message : err), 'co-error'); throw err; });
}

function removeOverride(key) {
  setMessage('Removing…');
  deleteAttrs(state.origin, [key])
    .then(function () { return applyToAffectedStations(); })
    .catch(function (err) { setMessage('Remove failed: ' + (err && err.message ? err.message : err), 'co-error'); });
}

// -- confirm dialog -----------------------------------------------------

function confirmDialog(text) {
  return new Promise(function (resolve) {
    els.confirmText.textContent = text;
    els.confirmBackdrop.hidden = false;
    function cleanup(result) {
      els.confirmBackdrop.hidden = true;
      els.confirmOk.removeEventListener('click', onOk);
      els.confirmCancel.removeEventListener('click', onCancel);
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }
    els.confirmOk.addEventListener('click', onOk);
    els.confirmCancel.addEventListener('click', onCancel);
  });
}

// -- add/edit dialog ------------------------------------------------------

function availableCategories() {
  var isCustomer = state.origin.entityType === 'CUSTOMER';
  return resolver.CATEGORIES.filter(function (c) {
    if (!c.perMeasurement) { return true; }
    return isCustomer ? kindOptions().length > 0 : Object.keys(state.channelKinds).length > 0 || kindOptions().length > 0;
  });
}

function dictionaryKinds(channelNames) {
  if (typeof channelNames === 'string') {
    try { channelNames = JSON.parse(channelNames); } catch (e) { return []; }
  }
  return Object.keys(channelNames || {}).map(function (name) { return channelNames[name].kind; }).filter(Boolean);
}

// Kinds offered as a target: the tenant vocabulary plus whatever the stations below actually measure.
function kindOptions() {
  var seen = {};
  var out = [];
  var wireKinds = state.dictionaryKinds.concat(Object.keys(state.channelKinds).map(function (ch) { return state.channelKinds[ch]; }));
  wireKinds.forEach(function (wireKind) {
    if (!wireKind || resolver.NEVER_KIND_TARGETS.indexOf(resolver.wireKind(wireKind)) >= 0) { return; }
    var camel = resolver.camelKind(wireKind);
    if (!seen[camel]) { seen[camel] = true; out.push(camel); }
  });
  return out.sort();
}

function channelOptions() {
  return Object.keys(state.channelKinds).sort();
}

function currentCategory() {
  var id = els.category.value;
  return resolver.CATEGORIES.filter(function (c) { return c.id === id; })[0] || null;
}

function refreshTargetStep() {
  var cat = currentCategory();
  var isCustomer = state.origin.entityType === 'CUSTOMER';
  els.stepTarget.hidden = !cat || !cat.perMeasurement;
  if (!cat || !cat.perMeasurement) { refreshValueStep(); return; }

  els.targetMode.hidden = isCustomer;
  if (isCustomer) { els.targetMode.value = 'kind'; }

  fillTargetValues();
  refreshValueStep();
}

function fillTargetValues() {
  var mode = els.targetMode.value;
  var options = mode === 'channel' ? channelOptions() : kindOptions();
  els.targetValue.innerHTML = '';
  options.forEach(function (opt) {
    var o = document.createElement('option'); o.value = opt; o.textContent = opt;
    els.targetValue.appendChild(o);
  });
}

function refreshValueStep() {
  var cat = currentCategory();
  if (!cat) { els.stepValue.hidden = true; els.dialogSave.disabled = true; return; }
  els.stepValue.hidden = false;

  els.valueList.hidden = !cat.list;
  els.valueBool.hidden = !cat.boolean;
  els.valueInput.hidden = !!(cat.list || cat.boolean);
  els.tokens.hidden = cat.id.indexOf('alarmText') !== 0;
  if (!els.tokens.hidden) { els.tokensList.textContent = resolver.ALARM_TEXT_TOKENS.join(' '); }
  els.valueInput.type = cat.numeric ? 'number' : 'text';

  var descriptor = descriptorForDialog();
  var lookup = descriptor ? resolver.inheritedValue(state.origin, descriptor, io) : Promise.resolve(null);
  return lookup.then(function (hit) {
    els.valueInherited.textContent = hit
      ? ('inherited: ' + formatValue(cat, hit.value) + ' (from ' + hit.source + ')')
      : 'nothing inherited above this level';

    var seedValue = state.editingKey ? state.ownAttrs[state.editingKey] : (hit ? hit.value : null);
    if (cat.list) {
      renderListRows(Array.isArray(seedValue) ? seedValue : []);
    } else if (cat.boolean) {
      els.valueBool.value = seedValue === true || seedValue === 'true' ? 'true' : 'false';
    } else {
      els.valueInput.value = seedValue === null || seedValue === undefined ? '' : String(seedValue);
    }

    if (cat.numeric || cat.field === 'unit' || (cat.field && cat.field.indexOf('alarm.') === 0)) {
      return resolver.inheritedValue(state.origin, unitDescriptorFor(descriptor), io).then(function (unitHit) {
        els.valueLabel.textContent = 'Value' + (unitHit ? ' (' + unitHit.value + ')' : '');
        updateSaveEnabled();
      });
    }
    els.valueLabel.textContent = 'Value';
    updateSaveEnabled();
  });
}

function unitDescriptorFor(descriptor) {
  if (!descriptor || descriptor.axis === 'config') { return descriptor; }
  var copy = {}; Object.keys(descriptor).forEach(function (k) { copy[k] = descriptor[k]; });
  copy.field = 'unit';
  return copy;
}

function renderListRows(values) {
  els.listRows.innerHTML = '';
  (values.length ? values : ['']).forEach(function (v) { addListRow(v); });
}

function addListRow(value) {
  var row = document.createElement('div'); row.className = 'co-list-row';
  var input = document.createElement('input'); input.type = 'text'; input.value = value || '';
  input.addEventListener('input', updateSaveEnabled);
  var remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '✕';
  remove.addEventListener('click', function () { row.remove(); updateSaveEnabled(); });
  row.appendChild(input); row.appendChild(remove);
  els.listRows.appendChild(row);
}

function descriptorForDialog() {
  var cat = currentCategory();
  if (!cat) { return null; }
  if (cat.scalarField) { return { axis: 'config', field: cat.scalarField }; }
  if (!cat.perMeasurement) { return null; }
  var mode = els.targetMode.value;
  var target = els.targetValue.value;
  if (!target) { return null; }
  if (mode === 'channel') { return { axis: 'channel', channel: target, kind: state.channelKinds[target], field: cat.field }; }
  return { axis: 'kind', kind: target, field: cat.field };
}

function keyForDialog() {
  var cat = currentCategory();
  if (cat.scalarField) { return resolver.CONFIG_PREFIX + cat.scalarField; }
  var mode = els.targetMode.value;
  var target = els.targetValue.value;
  if (mode === 'channel') { return resolver.CHANNEL_PREFIX + target + '.' + cat.field; }
  return resolver.KIND_PREFIX + resolver.camelKind(target) + '.' + cat.field;
}

function valueForDialog() {
  var cat = currentCategory();
  if (cat.list) {
    return Array.prototype.map.call(els.listRows.querySelectorAll('input'), function (i) { return i.value.trim(); })
      .filter(function (v) { return v; });
  }
  if (cat.boolean) { return els.valueBool.value === 'true'; }
  if (cat.numeric) {
    var n = Number(els.valueInput.value);
    return Number.isFinite(n) ? n : NaN;
  }
  return els.valueInput.value;
}

function updateSaveEnabled() {
  var cat = currentCategory();
  var ok = !!cat;
  if (ok && cat.perMeasurement && !els.targetValue.value) { ok = false; }
  if (ok && cat.numeric && !cat.list) {
    var n = Number(els.valueInput.value);
    ok = els.valueInput.value !== '' && Number.isFinite(n);
  }
  if (ok && cat.list) {
    var any = Array.prototype.some.call(els.listRows.querySelectorAll('input'), function (i) { return i.value.trim(); });
    ok = any;
  }
  els.dialogSave.disabled = !ok;
}

function fillCategoryOptions() {
  els.category.innerHTML = '';
  availableCategories().forEach(function (c) {
    var o = document.createElement('option'); o.value = c.id; o.textContent = c.label;
    els.category.appendChild(o);
  });
}

function openDialog(existingKey) {
  state.editingKey = existingKey || null;
  els.dialogMessage.textContent = '';
  fillCategoryOptions();

  if (existingKey) {
    var parsed = resolver.parseOverrideKey(existingKey);
    var cat = resolver.CATEGORIES.filter(function (c) {
      return parsed.axis === 'config' ? c.scalarField === parsed.field : c.field === parsed.field;
    })[0];
    els.dialogTitle.textContent = 'Edit override';
    if (cat) { els.category.value = cat.id; }
    els.category.disabled = true;
    refreshTargetStep();
    if (parsed.axis !== 'config') {
      els.targetMode.value = parsed.axis;
      els.targetMode.disabled = true;
      fillTargetValues();
      els.targetValue.value = parsed.target;
      els.targetValue.disabled = true;
    }
  } else {
    els.dialogTitle.textContent = 'Add override';
    els.category.disabled = false;
    els.targetMode.disabled = false;
    els.targetValue.disabled = false;
    refreshTargetStep();
  }

  els.dialogBackdrop.hidden = false;
}

function closeDialog() {
  els.dialogBackdrop.hidden = true;
  state.editingKey = null;
}

els.category.addEventListener('change', refreshTargetStep);
els.targetMode.addEventListener('change', function () { fillTargetValues(); refreshValueStep(); });
els.targetValue.addEventListener('change', refreshValueStep);
els.valueInput.addEventListener('input', updateSaveEnabled);
els.valueBool.addEventListener('change', updateSaveEnabled);
els.listAdd.addEventListener('click', function () { addListRow(''); updateSaveEnabled(); });
els.dialogCancel.addEventListener('click', closeDialog);
els.add.addEventListener('click', function () { openDialog(null); });

els.dialogSave.addEventListener('click', function () {
  var key = keyForDialog();
  var value = valueForDialog();
  if (typeof value === 'number' && !Number.isFinite(value)) {
    els.dialogMessage.textContent = 'Enter a valid number.';
    return;
  }
  els.dialogSave.disabled = true;
  saveOverride(key, value).then(function () {
    closeDialog();
  }).catch(function (err) {
    els.dialogMessage.textContent = err && err.message ? err.message : String(err);
    els.dialogSave.disabled = false;
  });
});

load();

};
