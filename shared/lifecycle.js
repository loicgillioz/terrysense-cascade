/*
 * Lifecycle actions of a project, a station or a device —
 * `window.TerrySenseLifecycle(ui, tb)`: rename in place, move to another
 * project, public or private, retire, delete, silence; a device out of service
 * and its reassignment to another owner. Each flow confirms
 * with its consequences first and calls `done` after its writes. Shared by
 * the project widget and the station view, and by any widget whose row menu
 * holds these actions. Spec: logr-product-docs/cloud/FRONTEND.md *Interface
 * conventions*, *Project dashboard*, *Station view*.
 *
 * Loads after shared/resolver.js, glossary.js, ui.js and tb_io.js.
 */
(function (root) {
'use strict';

root.TerrySenseLifecycle = function (ui, tb) {
  var G = root.TerrySenseGlossary;
  var h = ui.h, esc = ui.esc;
  var EVENING_HOUR = 18;

  function errText(e) { return (e && e.error && e.error.message) || (e && e.message) || String(e); }

  function fail(what) { return function (err) { ui.toast(what + ': ' + errText(err), 'error'); }; }

  function names(list) { return list.map(function (e) { return '<b>' + esc(e.name) + '</b>'; }).join(', '); }

  /** Rename `entity` in place, in `target`; `done(name)` after the save. */
  function rename(entity, target, done) {
    ui.inlineEdit(target, entity.name, function (name) {
      return tb.renameEntity(entity, name).then(function () {
        ui.toast('Renamed to ' + name);
        done(name);
      });
    });
  }

  function valueText(key, v) {
    if (v === undefined || v === null || v === '') { return 'none'; }
    if (Array.isArray(v)) { return v.length + (v.length === 1 ? ' contact' : ' contacts'); }
    if (/\.ttlDays$/.test(key)) { return v + ' days'; }
    var s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return s.length > 40 ? s.slice(0, 39) + '…' : s;
  }

  /** The settings a move changes, as list items; `attrs` names the station's channels. */
  function changeList(changes, attrs) {
    function label(c) { return attrs['effective.' + c + '.label'] || c; }
    return '<ul class="ts-changes">' + changes.map(function (c) {
      return '<li data-setting="' + esc(c.key) + '">' + esc(G.settingLabel(c.key, label)) + ': ' + esc(valueText(c.key, c.from)) +
        ' → ' + esc(valueText(c.key, c.to)) + '</li>';
    }).join('') + '</ul>';
  }

  /** *Move to project…* (CA-11): the owner's other projects; the confirmation
   * lists the settings that change, resolved on the new chain; `done(project)`. */
  function moveStation(station, attrs, from, owner, done) {
    var dr = ui.openDrawer('Move to project…', esc(station.name));
    dr.body.appendChild(h('<div class="ts-loading">Loading the projects…</div>'));
    tb.ownerProjects(owner).then(function (projects) {
      dr.body.innerHTML = '';
      var others = projects.filter(function (p) { return p.id !== from.id; }).sort(function (a, b) { return a.name.localeCompare(b.name); });
      if (!others.length) { dr.body.appendChild(h('<div class="ts-empty">The owner has no other project.</div>')); }
      others.forEach(function (p) {
        var o = dr.body.appendChild(h('<div class="ts-opt" tabindex="0"><div class="ts-opt-main"><div class="ts-opt-label"></div></div></div>'));
        o.setAttribute('data-project', p.name);
        o.querySelector('.ts-opt-label').textContent = p.name;
        o.addEventListener('click', function () { confirmMove(p); });
      });
    }).catch(function (err) { dr.body.innerHTML = ''; dr.body.appendChild(h('<div class="ts-empty ts-error"></div>')).textContent = errText(err); });

    function confirmMove(to) {
      tb.settingChanges(station, to).then(function (changes) {
        return ui.confirm('Move <b>' + esc(station.name) + '</b> from <b>' + esc(from.name) + '</b> to <b>' + esc(to.name) + '</b>? ' +
          'Its history, alarms, dashboard and channels stay. ' +
          (changes.length ? (changes.length === 1 ? 'This setting changes:' : 'These ' + changes.length + ' settings change:') + changeList(changes, attrs)
            : 'No setting changes.'), 'Move');
      }).then(function (ok) {
        if (!ok) { return null; }
        return tb.moveStation(station, from, to).then(function () {
          ui.closeDrawer();
          ui.toast(station.name + ' moved to ' + to.name);
          done(to);
        });
      }).catch(fail('Not moved'));
    }
  }

  /** *Public* / *Private* (CA-12): in or out of the owner's public group.
   * `projectPublic` false: the project has no public link, so nothing shows the station yet. */
  function setPublic(entity, owner, on, done, projectPublic) {
    var text = !on ? 'Make <b>' + esc(entity.name) + '</b> private? The public link no longer shows it.'
      : projectPublic === false ? 'Make <b>' + esc(entity.name) + '</b> public? Its project has no public link yet, so no link shows it ' +
        'until <i>Public link on</i> in the project’s menu.'
      : 'Make <b>' + esc(entity.name) + '</b> public? The project’s public link then shows it and its readings, where the project dashboard does.';
    ui.confirm(text, on ? 'Make public' : 'Make private')
      .then(function (ok) {
        if (!ok) { return null; }
        return tb.setPublic(entity, owner, on).then(function () {
          ui.toast(entity.name + (on ? ' is public' : ' is private'));
          done();
        });
      }).catch(fail('Not changed'));
  }

  /** *Retire* (CA-17) and *Reactivate*: `service.state`. */
  function retire(station, done) {
    ui.confirm('Retire <b>' + esc(station.name) + '</b>? It raises no alarm, notifies nobody and is never stale; its history and dashboards stay. ' +
      'It folds into Retired at the end of the list and leaves the map.', 'Retire').then(function (ok) {
      if (!ok) { return null; }
      return tb.setServiceState(station, 'retired').then(function () { ui.toast(station.name + ' retired'); done(); });
    }).catch(fail('Not retired'));
  }

  function reactivate(station, done) {
    ui.confirm('Reactivate <b>' + esc(station.name) + '</b>? It raises alarms and notifies its contacts again.', 'Reactivate').then(function (ok) {
      if (!ok) { return null; }
      return tb.setServiceState(station, null).then(function () { ui.toast(station.name + ' is in service'); done(); });
    }).catch(fail('Not reactivated'));
  }

  /** *Delete* (CA-18): `target`, after the retired `stations` going with it,
   * confirmed by typing its name; their history only when ticked. */
  function remove(target, stations, done) {
    var html = target.kind === 'Project'
      ? 'Delete the project <b>' + esc(target.name) + '</b>' + (stations.length ? ' and its retired stations ' + names(stations) : '') + '? '
      : 'Delete the station <b>' + esc(target.name) + '</b>? ';
    html += 'Relations and channel maps go with ' + (stations.length ? 'them' : 'it') + '; dashboards stay. This cannot be undone.';
    ui.confirmTyped(html, target.name, 'Delete', 'Also delete the measurement history').then(function (answer) {
      if (!answer) { return null; }
      var work = Promise.resolve();
      stations.concat([target]).forEach(function (e) {
        work = work.then(function () { return answer.checked ? tb.deleteHistory(e) : null; }).then(function () { return tb.deleteEntity(e); });
      });
      return work.then(function () { ui.toast(target.name + ' deleted'); done(); });
    }).catch(fail('Not deleted'));
  }

  /** *Silence* (CA-19): 1 h, 4 h, until 18:00 or a chosen time. */
  function silenceMenu(anchor, entity, done) {
    var now = Date.now(), evening = new Date();
    evening.setHours(EVENING_HOUR, 0, 0, 0);
    var tomorrow = evening.getTime() <= now;
    if (tomorrow) { evening.setDate(evening.getDate() + 1); }
    var box = h('<div class="ts-menu"><div class="ts-menu-note">Alarms are still raised and shown; nobody is notified.</div></div>');
    var pop;
    function pick(until) {
      pop.close();
      tb.silence(entity, until).then(function () { ui.toast(ui.silenceText(until)); done(); }).catch(fail('Not silenced'));
    }
    [['1h', 'For 1 hour', now + 3600e3], ['4h', 'For 4 hours', now + 4 * 3600e3],
     ['evening', (tomorrow ? 'Until tomorrow ' : 'Until ') + EVENING_HOUR + ':00', evening.getTime()]].forEach(function (o) {
      var b = box.appendChild(h('<button type="button" class="ts-menu-item"></button>'));
      b.setAttribute('data-a', o[0]);
      b.textContent = o[1];
      b.addEventListener('click', function () { pick(o[2]); });
    });
    var custom = box.appendChild(h('<div class="ts-menu-custom"><input type="datetime-local" class="ts-input" data-f="until">' +
      '<button type="button" class="ts-btn" data-a="custom" disabled>Set</button></div>'));
    var input = custom.querySelector('input'), set = custom.querySelector('button');
    input.addEventListener('input', function () { set.disabled = !(new Date(input.value).getTime() > Date.now()); });
    set.addEventListener('click', function () { pick(new Date(input.value).getTime()); });
    pop = ui.popover(anchor, box);
    pop.el.classList.add('ts-menu-pop');
  }

  function endSilence(entity, done) {
    tb.endSilence(entity).then(function () { ui.toast('Silence ended: notifications go out again'); done(); }).catch(fail('Not ended'));
  }

  /** The row menu items of a station (FRONTEND.md *Project dashboard*, row menu).
   * `s`: {station, attrs, project, owner, isPublic, projectPublic, nameEl, changed(), deleted()}. */
  function stationItems(s) {
    var retired = tb.serviceOf(s.attrs).retired;
    return [
      { a: 'rename', label: 'Rename', run: function () { rename(s.station, s.nameEl, s.changed); } },
      s.project && { a: 'move', label: 'Move to project…', run: function () { moveStation(s.station, s.attrs, s.project, s.owner, s.changed); } },
      { a: s.isPublic ? 'private' : 'public', label: s.isPublic ? 'Make private' : 'Make public',
        run: function () { setPublic(s.station, s.owner, !s.isPublic, s.changed, s.projectPublic); } },
      retired ? { a: 'reactivate', label: 'Reactivate', run: function () { reactivate(s.station, s.changed); } }
        : { a: 'retire', label: 'Retire', run: function () { retire(s.station, s.changed); } },
      retired && { a: 'delete', label: 'Delete…', danger: true, run: function () { remove(s.station, [], s.deleted); } }
    ];
  }

  function deviceName(device) { return device.label || device.name; }

  /** *Out of service* (CA-23): in repair, lost or retired, picked in a panel. */
  function outOfService(device, done) {
    var dr = ui.openDrawer('Out of service', esc(deviceName(device)));
    dr.body.appendChild(h('<div class="ts-field-hint">It raises no device alarm and leaves <i>Needs a look</i>; its history and stations stay. ' +
      '<i>Back in service</i> undoes it.</div>'));
    Object.keys(G.SERVICE_STATES).forEach(function (value) {
      var o = dr.body.appendChild(h('<div class="ts-opt" tabindex="0"><div class="ts-opt-main"><div class="ts-opt-label"></div></div></div>'));
      o.setAttribute('data-state', value);
      o.querySelector('.ts-opt-label').textContent = G.SERVICE_STATES[value];
      o.addEventListener('click', function () {
        ui.confirm('Mark <b>' + esc(deviceName(device)) + '</b> out of service, ' + esc(G.SERVICE_STATES[value].toLowerCase()) + '?', 'Out of service')
          .then(function (ok) {
            if (!ok) { return null; }
            return tb.setServiceState(device, value).then(function () {
              ui.closeDrawer();
              ui.toast(deviceName(device) + ' is out of service');
              done();
            });
          }).catch(fail('Not changed'));
      });
    });
  }

  function backInService(device, done) {
    ui.confirm('Put <b>' + esc(deviceName(device)) + '</b> back in service? It raises device alarms again.', 'Back in service').then(function (ok) {
      if (!ok) { return null; }
      return tb.setServiceState(device, null).then(function () { ui.toast(deviceName(device) + ' is in service'); done(); });
    }).catch(fail('Not changed'));
  }

  /** *Reassign…* (TA-6): the new owner, then a confirmation naming the stations
   * the device leaves; one save disconnects it and changes its owner. */
  function reassign(device, done) {
    var dr = ui.openDrawer('Reassign…', esc(deviceName(device)));
    dr.body.appendChild(h('<div class="ts-loading">Loading the owners…</div>'));
    Promise.all([tb.ownerOf(device), tb.currentUser(), tb.getAll('/api/customers', {})]).then(function (got) {
      var current = got[0], owners = [{ entityType: 'TENANT', id: got[1].tenantId.id, name: 'Tenant, no customer' }].concat(
        got[2].map(function (c) { return { entityType: 'CUSTOMER', id: c.id.id, name: c.title }; })
          .sort(function (a, b) { return a.name.localeCompare(b.name); }));
      dr.body.innerHTML = '';
      dr.body.appendChild(h('<div class="ts-field-hint">The device leaves every station first: a station takes readings only from devices of its own owner.</div>'));
      owners.filter(function (o) { return o.id !== current.id; }).forEach(function (o) {
        var row = dr.body.appendChild(h('<div class="ts-opt" tabindex="0"><div class="ts-opt-main"><div class="ts-opt-label"></div></div></div>'));
        row.setAttribute('data-owner', o.name);
        row.querySelector('.ts-opt-label').textContent = o.name;
        row.addEventListener('click', function () { confirmReassign(o); });
      });
    }).catch(function (err) { dr.body.innerHTML = ''; dr.body.appendChild(h('<div class="ts-empty ts-error"></div>')).textContent = errText(err); });

    function confirmReassign(owner) {
      tb.deviceParents(device).then(function (parents) {
        return ui.confirm('Reassign <b>' + esc(deviceName(device)) + '</b> to <b>' + esc(owner.name) + '</b>? ' +
          (parents.length ? 'It leaves ' + names(parents) + (parents.length === 1 ? ', which keeps its history.' : ', which keep their history.')
            : 'It feeds no station.'), 'Reassign')
          .then(function (ok) {
            if (!ok) { return null; }
            return tb.reassignDevice(device, owner, parents).then(function () {
              ui.closeDrawer();
              ui.toast(deviceName(device) + ' reassigned to ' + owner.name);
              done();
            });
          });
      }).catch(fail('Not reassigned'));
    }
  }

  /** The service chips of a device's attributes: *Out of service*, else *Silenced until …*. */
  function deviceChips(attrs) {
    var sv = tb.serviceOf(attrs);
    if (sv.state) {
      var chip = ui.stateChip('outofservice');
      chip.title = G.SERVICE_STATES[sv.state] || sv.state;
      return [chip];
    }
    return sv.silencedUntil ? [ui.stateChip('silenced', sv.silencedUntil)] : [];
  }

  /** The service item of a device's row menu: *Out of service…* or *Back in service*. */
  function serviceItem(device, attrs, done) {
    return tb.serviceOf(attrs).state
      ? { a: 'back-in-service', label: 'Back in service', run: function () { backInService(device, done); } }
      : { a: 'out-of-service', label: 'Out of service…', run: function () { outOfService(device, done); } };
  }

  return {
    rename: rename, moveStation: moveStation, setPublic: setPublic, retire: retire, reactivate: reactivate,
    remove: remove, silenceMenu: silenceMenu, endSilence: endSilence, stationItems: stationItems, changeList: changeList,
    outOfService: outOfService, backInService: backInService, reassign: reassign, deviceChips: deviceChips, serviceItem: serviceItem
  };
};

})(typeof self !== 'undefined' ? self : this);
