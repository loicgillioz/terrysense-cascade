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
  var t = root.TerrySenseT;
  var h = ui.h, esc = ui.esc;
  var EVENING_HOUR = 18;

  function errText(e) { return (e && e.error && e.error.message) || (e && e.message) || String(e); }

  /** `what` is a message with an `{error}` placeholder. */
  function fail(what) { return function (err) { ui.toast(what.split('{error}').join(errText(err)), 'error'); }; }

  function names(list) { return list.map(function (e) { return '<b>' + esc(e.name) + '</b>'; }).join(', '); }

  /** Rename `entity` in place, in `target`; `done(name)` after the save. */
  function rename(entity, target, done) {
    ui.inlineEdit(target, entity.name, function (name) {
      return tb.renameEntity(entity, name).then(function () {
        ui.toast(t('lifecycle.renamed', 'Renamed to {name}', { name: name }));
        done(name);
      });
    });
  }

  function valueText(key, v) {
    if (v === undefined || v === null || v === '') { return t('common.none', 'none'); }
    if (Array.isArray(v)) {
      return v.length === 1 ? t('common.contactOne', '1 contact') : t('common.contactMany', '{n} contacts', { n: v.length });
    }
    if (/\.ttlDays$/.test(key)) { return t('common.days', '{n} days', { n: v }); }
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
    var dr = ui.openDrawer(esc(t('lifecycle.move.title', 'Move to project…')), esc(station.name));
    dr.body.appendChild(h('<div class="ts-loading"></div>')).textContent = t('lifecycle.move.loading', 'Loading the projects…');
    tb.ownerProjects(owner).then(function (projects) {
      dr.body.innerHTML = '';
      var others = projects.filter(function (p) { return p.id !== from.id; }).sort(function (a, b) { return a.name.localeCompare(b.name); });
      if (!others.length) { dr.body.appendChild(h('<div class="ts-empty"></div>')).textContent = t('lifecycle.move.noOther', 'The owner has no other project.'); }
      others.forEach(function (p) {
        var o = dr.body.appendChild(h('<div class="ts-opt" tabindex="0"><div class="ts-opt-main"><div class="ts-opt-label"></div></div></div>'));
        o.setAttribute('data-project', p.name);
        o.querySelector('.ts-opt-label').textContent = p.name;
        o.addEventListener('click', function () { confirmMove(p); });
      });
    }).catch(function (err) { dr.body.innerHTML = ''; dr.body.appendChild(h('<div class="ts-empty ts-error"></div>')).textContent = errText(err); });

    function confirmMove(to) {
      tb.settingChanges(station, to).then(function (changes) {
        return ui.confirm(t('lifecycle.move.confirm', 'Move <b>{station}</b> from <b>{from}</b> to <b>{to}</b>? Its history, alarms, dashboard and channels stay.',
          { station: esc(station.name), from: esc(from.name), to: esc(to.name) }) + ' ' +
          (changes.length ? (changes.length === 1 ? t('lifecycle.move.changeOne', 'This setting changes:')
            : t('lifecycle.move.changeMany', 'These {n} settings change:', { n: changes.length })) + changeList(changes, attrs)
            : t('lifecycle.move.noChange', 'No setting changes.')), t('common.move', 'Move'));
      }).then(function (ok) {
        if (!ok) { return null; }
        return tb.moveStation(station, from, to).then(function () {
          ui.closeDrawer();
          ui.toast(t('lifecycle.move.done', '{station} moved to {to}', { station: station.name, to: to.name }));
          done(to);
        });
      }).catch(fail(t('common.notMoved', 'Not moved: {error}')));
    }
  }

  /** *Public* / *Private* (CA-12): in or out of the owner's public group.
   * `projectPublic` false: the project has no public link, so nothing shows the station yet. */
  function setPublic(entity, owner, on, done, projectPublic) {
    var name = { name: esc(entity.name) };
    var text = !on ? t('lifecycle.public.confirmPrivate', 'Make <b>{name}</b> private? The public link no longer shows it.', name)
      : projectPublic === false ? t('lifecycle.public.confirmNoLink', 'Make <b>{name}</b> public? Its project has no public link yet, so no link shows it until <i>Public link on</i> in the project’s menu.', name)
      : t('lifecycle.public.confirmPublic', 'Make <b>{name}</b> public? The project’s public link then shows it and its readings, where the project dashboard does.', name);
    ui.confirm(text, on ? t('lifecycle.public.makePublic', 'Make public') : t('lifecycle.public.makePrivate', 'Make private'))
      .then(function (ok) {
        if (!ok) { return null; }
        return tb.setPublic(entity, owner, on).then(function () {
          ui.toast(on ? t('lifecycle.public.isPublic', '{name} is public', { name: entity.name })
            : t('lifecycle.public.isPrivate', '{name} is private', { name: entity.name }));
          done();
        });
      }).catch(fail(t('common.notChanged', 'Not changed: {error}')));
  }

  /** *Retire* (CA-17) and *Reactivate*: `service.state`. */
  function retire(station, done) {
    ui.confirm(t('lifecycle.retire.confirm', 'Retire <b>{name}</b>? It raises no alarm, notifies nobody and is never stale; its history and dashboards stay. It folds into Retired at the end of the list and leaves the map.', { name: esc(station.name) }), t('lifecycle.retire.ok', 'Retire')).then(function (ok) {
      if (!ok) { return null; }
      return tb.setServiceState(station, 'retired').then(function () {
        ui.toast(t('lifecycle.retire.done', '{name} retired', { name: station.name }));
        done();
      });
    }).catch(fail(t('lifecycle.retire.failed', 'Not retired: {error}')));
  }

  function reactivate(station, done) {
    ui.confirm(t('lifecycle.reactivate.confirm', 'Reactivate <b>{name}</b>? It raises alarms and notifies its contacts again.', { name: esc(station.name) }),
      t('lifecycle.reactivate.ok', 'Reactivate')).then(function (ok) {
      if (!ok) { return null; }
      return tb.setServiceState(station, null).then(function () { ui.toast(t('lifecycle.inService', '{name} is in service', { name: station.name })); done(); });
    }).catch(fail(t('lifecycle.reactivate.failed', 'Not reactivated: {error}')));
  }

  /** *Delete* (CA-18): `target`, after the retired `stations` going with it,
   * confirmed by typing its name; their history only when ticked. */
  function remove(target, stations, done) {
    var html = target.kind === 'Project'
      ? (stations.length ? t('lifecycle.delete.projectWithStations', 'Delete the project <b>{name}</b> and its retired stations {stations}?',
        { name: esc(target.name), stations: names(stations) }) : t('lifecycle.delete.project', 'Delete the project <b>{name}</b>?', { name: esc(target.name) }))
      : t('lifecycle.delete.station', 'Delete the station <b>{name}</b>?', { name: esc(target.name) });
    html += ' ' + (stations.length ? t('lifecycle.delete.consequenceMany', 'Relations and channel maps go with them; dashboards stay. This cannot be undone.')
      : t('lifecycle.delete.consequenceOne', 'Relations and channel maps go with it; dashboards stay. This cannot be undone.'));
    ui.confirmTyped(html, target.name, t('common.delete', 'Delete'), t('lifecycle.delete.history', 'Also delete the measurement history')).then(function (answer) {
      if (!answer) { return null; }
      var work = Promise.resolve();
      stations.concat([target]).forEach(function (e) {
        work = work.then(function () { return answer.checked ? tb.deleteHistory(e) : null; }).then(function () { return tb.deleteEntity(e); });
      });
      return work.then(function () { ui.toast(t('lifecycle.delete.done', '{name} deleted', { name: target.name })); done(); });
    }).catch(fail(t('common.notDeleted', 'Not deleted: {error}')));
  }

  /** *Silence* (CA-19): 1 h, 4 h, until 18:00 or a chosen time. */
  function silenceMenu(anchor, entity, done) {
    var now = Date.now(), evening = new Date();
    evening.setHours(EVENING_HOUR, 0, 0, 0);
    var tomorrow = evening.getTime() <= now;
    if (tomorrow) { evening.setDate(evening.getDate() + 1); }
    var box = h('<div class="ts-menu"><div class="ts-menu-note"></div></div>');
    box.firstChild.textContent = t('lifecycle.silence.note', 'Alarms are still raised and shown; nobody is notified.');
    var pop;
    function pick(until) {
      pop.close();
      tb.silence(entity, until).then(function () { ui.toast(ui.silenceText(until)); done(); }).catch(fail(t('lifecycle.silence.failed', 'Not silenced: {error}')));
    }
    var hour = { time: EVENING_HOUR + ':00' };
    [['1h', t('lifecycle.silence.hour', 'For 1 hour'), now + 3600e3], ['4h', t('lifecycle.silence.hours', 'For 4 hours'), now + 4 * 3600e3],
     ['evening', tomorrow ? t('lifecycle.silence.untilTomorrow', 'Until tomorrow {time}', hour) : t('lifecycle.silence.until', 'Until {time}', hour),
      evening.getTime()]].forEach(function (o) {
      var b = box.appendChild(h('<button type="button" class="ts-menu-item"></button>'));
      b.setAttribute('data-a', o[0]);
      b.textContent = o[1];
      b.addEventListener('click', function () { pick(o[2]); });
    });
    var custom = box.appendChild(h('<div class="ts-menu-custom"><input type="datetime-local" class="ts-input" data-f="until"><button type="button" class="ts-btn" data-a="custom" disabled></button></div>'));
    var input = custom.querySelector('input'), set = custom.querySelector('button');
    set.textContent = t('lifecycle.silence.set', 'Set');
    input.addEventListener('input', function () { set.disabled = !(new Date(input.value).getTime() > Date.now()); });
    set.addEventListener('click', function () { pick(new Date(input.value).getTime()); });
    pop = ui.popover(anchor, box);
    pop.el.classList.add('ts-menu-pop');
  }

  function endSilence(entity, done) {
    tb.endSilence(entity).then(function () { ui.toast(t('lifecycle.silence.ended', 'Silence ended: notifications go out again')); done(); })
      .catch(fail(t('lifecycle.silence.notEnded', 'Not ended: {error}')));
  }

  /** The row menu items of a station (FRONTEND.md *Project dashboard*, row menu).
   * `s`: {station, attrs, project, owner, isPublic, projectPublic, nameEl, changed(), deleted()}. */
  function stationItems(s) {
    var retired = tb.serviceOf(s.attrs).retired;
    return [
      { a: 'rename', label: t('common.rename', 'Rename'), run: function () { rename(s.station, s.nameEl, s.changed); } },
      s.project && { a: 'move', label: t('lifecycle.move.title', 'Move to project…'), run: function () { moveStation(s.station, s.attrs, s.project, s.owner, s.changed); } },
      { a: s.isPublic ? 'private' : 'public', label: s.isPublic ? t('lifecycle.public.makePrivate', 'Make private') : t('lifecycle.public.makePublic', 'Make public'),
        run: function () { setPublic(s.station, s.owner, !s.isPublic, s.changed, s.projectPublic); } },
      retired ? { a: 'reactivate', label: t('lifecycle.reactivate.ok', 'Reactivate'), run: function () { reactivate(s.station, s.changed); } }
        : { a: 'retire', label: t('lifecycle.retire.ok', 'Retire'), run: function () { retire(s.station, s.changed); } },
      retired && { a: 'delete', label: t('lifecycle.menu.delete', 'Delete…'), danger: true, run: function () { remove(s.station, [], s.deleted); } }
    ];
  }

  function deviceName(device) { return device.label || device.name; }

  // A state name starts a sentence in the panel and continues one in the confirmation.
  function lowerFirst(text) { return text.charAt(0).toLowerCase() + text.slice(1); }

  /** *Out of service* (CA-23): in repair, lost or retired, picked in a panel. */
  function outOfService(device, done) {
    var states = G.SERVICE_STATES;
    var dr = ui.openDrawer(esc(t('common.outOfService', 'Out of service')), esc(deviceName(device)));
    dr.body.appendChild(h('<div class="ts-field-hint">' + t('lifecycle.service.outHint', 'It raises no device alarm and leaves <i>Needs a look</i>; its history and stations stay. <i>Back in service</i> undoes it.') + '</div>'));
    Object.keys(states).forEach(function (value) {
      var o = dr.body.appendChild(h('<div class="ts-opt" tabindex="0"><div class="ts-opt-main"><div class="ts-opt-label"></div></div></div>'));
      o.setAttribute('data-state', value);
      o.querySelector('.ts-opt-label').textContent = states[value];
      o.addEventListener('click', function () {
        ui.confirm(t('lifecycle.service.outConfirm', 'Mark <b>{name}</b> out of service, {state}?', { name: esc(deviceName(device)), state: esc(lowerFirst(states[value])) }),
          t('common.outOfService', 'Out of service'))
          .then(function (ok) {
            if (!ok) { return null; }
            return tb.setServiceState(device, value).then(function () {
              ui.closeDrawer();
              ui.toast(t('lifecycle.service.isOut', '{name} is out of service', { name: deviceName(device) }));
              done();
            });
          }).catch(fail(t('common.notChanged', 'Not changed: {error}')));
      });
    });
  }

  function backInService(device, done) {
    ui.confirm(t('lifecycle.service.backConfirm', 'Put <b>{name}</b> back in service? It raises device alarms again.', { name: esc(deviceName(device)) }),
      t('lifecycle.service.back', 'Back in service')).then(function (ok) {
      if (!ok) { return null; }
      return tb.setServiceState(device, null).then(function () { ui.toast(t('lifecycle.inService', '{name} is in service', { name: deviceName(device) })); done(); });
    }).catch(fail(t('common.notChanged', 'Not changed: {error}')));
  }

  /** *Reassign…* (TA-6): the new owner, then a confirmation naming the stations
   * the device leaves; one save disconnects it and changes its owner. */
  function reassign(device, done) {
    var dr = ui.openDrawer(esc(t('lifecycle.reassign.title', 'Reassign…')), esc(deviceName(device)));
    dr.body.appendChild(h('<div class="ts-loading"></div>')).textContent = t('lifecycle.reassign.loading', 'Loading the owners…');
    Promise.all([tb.ownerOf(device), tb.currentUser(), tb.getAll('/api/customers', {})]).then(function (got) {
      var current = got[0], owners = [{ entityType: 'TENANT', id: got[1].tenantId.id, name: t('lifecycle.reassign.tenant', 'Tenant, no customer') }].concat(
        got[2].map(function (c) { return { entityType: 'CUSTOMER', id: c.id.id, name: c.title }; })
          .sort(function (a, b) { return a.name.localeCompare(b.name); }));
      dr.body.innerHTML = '';
      dr.body.appendChild(h('<div class="ts-field-hint"></div>')).textContent =
        t('lifecycle.reassign.hint', 'The device leaves every station first: a station takes readings only from devices of its own owner.');
      owners.filter(function (o) { return o.id !== current.id; }).forEach(function (o) {
        var row = dr.body.appendChild(h('<div class="ts-opt" tabindex="0"><div class="ts-opt-main"><div class="ts-opt-label"></div></div></div>'));
        row.setAttribute('data-owner', o.name);
        row.querySelector('.ts-opt-label').textContent = o.name;
        row.addEventListener('click', function () { confirmReassign(o); });
      });
    }).catch(function (err) { dr.body.innerHTML = ''; dr.body.appendChild(h('<div class="ts-empty ts-error"></div>')).textContent = errText(err); });

    function confirmReassign(owner) {
      tb.deviceParents(device).then(function (parents) {
        var who = { name: esc(deviceName(device)), owner: esc(owner.name), stations: names(parents) };
        return ui.confirm(!parents.length ? t('lifecycle.reassign.confirmNone', 'Reassign <b>{name}</b> to <b>{owner}</b>? It feeds no station.', who)
          : parents.length === 1 ? t('lifecycle.reassign.confirmOne', 'Reassign <b>{name}</b> to <b>{owner}</b>? It leaves {stations}, which keeps its history.', who)
          : t('lifecycle.reassign.confirmMany', 'Reassign <b>{name}</b> to <b>{owner}</b>? It leaves {stations}, which keep their history.', who),
          t('lifecycle.reassign.ok', 'Reassign'))
          .then(function (ok) {
            if (!ok) { return null; }
            return tb.reassignDevice(device, owner, parents).then(function () {
              ui.closeDrawer();
              ui.toast(t('lifecycle.reassign.done', '{name} reassigned to {owner}', { name: deviceName(device), owner: owner.name }));
              done();
            });
          });
      }).catch(fail(t('lifecycle.reassign.failed', 'Not reassigned: {error}')));
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
      ? { a: 'back-in-service', label: t('lifecycle.service.back', 'Back in service'), run: function () { backInService(device, done); } }
      : { a: 'out-of-service', label: t('lifecycle.service.outMenu', 'Out of service…'), run: function () { outOfService(device, done); } };
  }

  return {
    rename: rename, moveStation: moveStation, setPublic: setPublic, retire: retire, reactivate: reactivate,
    remove: remove, silenceMenu: silenceMenu, endSilence: endSilence, stationItems: stationItems, changeList: changeList,
    outOfService: outOfService, backInService: backInService, reassign: reassign, deviceChips: deviceChips, serviceItem: serviceItem
  };
};

})(typeof self !== 'undefined' ? self : this);
