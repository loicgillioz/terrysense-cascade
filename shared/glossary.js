/*
 * terrySense widget vocabulary — tooltip wording, severities, alarm-text
 * fields and status codes, shared by every terrySense widget (`window.TerrySenseGlossary`).
 *
 * Wording only: the severity definitions are ALARMING.md's, the alarm-text
 * fields are the token table of terrysense_v2/rulechains/alarm_notify.md, the
 * status codes are interface/TRX_NANO.md §5.
 * Change them there first.
 */
(function (root) {
'use strict';

var t = root.TerrySenseT;

// Tables are functions, so each read is in the reader's language.
function terms() {
  return {
    cascade: t('glossary.term.cascade', 'Settings flow down: <b>in-terra defaults → Customer → Project → Station</b>, and for a device <b>in-terra defaults → Device defaults → Device</b>. The nearest level that sets a value wins. A value set here applies to every station or device below.'),
    measurements: t('glossary.term.measurements', 'Alarm thresholds and hysteresis, set per measurement, in the unit it is stored in.'),
    notifications: t('glossary.term.notifications', 'Who receives alarm messages, by SMS and e-mail, and what the messages say. Measurement alarms and device alarms each have their own contacts.'),
    retention: t('glossary.term.retention', 'How long measured data is kept before it is deleted. A change applies to new data only.'),
    debounce: t('glossary.term.debounce', 'How many readings in a row must meet an alarm condition before anyone is notified. The alarm is recorded from the first reading but stays pending until then. Empty or 1 notifies on the first reading.'),
    hysteresis: t('glossary.term.hysteresis', 'An absolute margin, zero or positive, in the measurement unit. The alarm clears only once the value is back past the threshold by this margin, so a value hovering at the limit does not trigger alarms repeatedly.'),
    label: t('glossary.term.label', 'The name alarm messages use for this measurement, e.g. “Tank 3 pH”. Leave empty to use the standard name.'),
    severity: t('glossary.term.severity', '<b>{critical}</b> — immediate action required, significant damage possible.<br><b>{major}</b> — action required, damage possible.<br><b>{minor}</b> — action required, no damage expected.<br><b>{warning}</b> — heads-up; action on site not mandatory.<br><b>{indeterminate}</b> — no severity chosen.', severityNames()),
    thresholds: t('glossary.term.thresholds', 'An alarm is raised when a value goes above or below a threshold. Several thresholds with different severities escalate one alarm, e.g. Warning above 8, Critical above 9.'),
    boolAlarm: t('glossary.term.boolAlarm', 'Raise an alarm when the input takes this value. One condition per severity.'),
    stateAlarm: t('glossary.term.stateAlarm', 'Raise an alarm when the measurement reports this state. One condition per severity.'),
    boolText: t('glossary.term.boolText', 'How the two values read in dashboards and alarm messages, e.g. “open” and “closed”.'),
    alarmText: t('glossary.term.alarmText', 'The wording of the SMS, also used for the e-mail unless a longer e-mail text is set. Insert fields such as the measured value; they are filled in when the message is sent.'),
    smsLength: t('glossary.term.smsLength', 'One SMS holds 160 characters, or 70 when the text contains a character outside the SMS alphabet (e.g. ê, ç, emoji). Longer texts are split and billed per part. Fields count at a typical length, the dashboard link at 30.'),
    contacts: t('glossary.term.contacts', 'People who receive the measurement alarms of a station — a pH too high, a level too low: platform users, whose e-mail and phone come from their profile, or external contacts. Each contact receives only the severities ticked for them.'),
    addressBook: t('glossary.term.addressBook', 'People without a platform account who receive alarms. A contact list names one, so a number or address changed here changes in every list at once.'),
    deviceContacts: t('glossary.term.deviceContacts', 'People who receive the device alarms of the station’s loggers — a low battery, a self-diagnostic fault, a unit moved. Usually the technicians, set once for the customer. A station that names its own measurement contacts keeps these.'),
    channels: t('glossary.term.channels', 'Master switches. When off, or never set, no message of that type leaves this level or any level below, whatever the contacts say.'),
    noPhone: t('glossary.term.noPhone', 'No phone number in this user’s profile. Add one in the user settings to send SMS.'),
    channelName: t('glossary.term.channelName', 'The name a measurement is stored under. It stays the same when the LOGR or sensor is replaced, so the history is continuous.'),
    position: t('glossary.term.position', 'The connector on the LOGR bus the sensor is plugged into. Position 0 is the LOGR itself.'),
    device: t('glossary.term.device', 'The device that sends the data for this station. Change it after a hardware swap; the history stays intact.'),
    station: t('glossary.term.station', 'The measuring point the measurements belong to, shown on dashboards.'),
    diagnostics: t('glossary.term.diagnostics', 'Measurements about the LOGR itself (battery, charger, enclosure). Rarely needed on a station.'),
    inUse: t('glossary.term.inUse', 'Measurements mapped on at least one station below this level.'),
    statusSources: t('glossary.term.statusSources', 'Each value names its source: device values come from the LOGR’s own reports (STATUS, SUBSCRIPTIONS), network values from the network server’s reception of the last uplink. The cloud estimates none of them; the battery runtime is the same number the BLE app shows.'),
    wiring: t('glossary.term.wiring', 'The stations this device feeds, through their channel maps. A position or a reading feeding no station is stored on the device only and shows on no dashboard.'),
    uplink: t('glossary.term.uplink', 'Active while the LOGR has sent anything within its inactivity timeout. A unit that went silent shows here, even when every sensor was fine at its last uplink.'),
    drycRules: t('glossary.term.drycRules', 'The dry contact interface runs these rules itself, first to last. A rule that notifies wakes the logger when it starts and when it ends; the station then raises or clears an alarm, sent to its contacts like any other.'),
    drycRecords: t('glossary.term.drycRecords', 'The dry contact interface holds at most 16 records: one per notifying rule, and one per relay a rule switches.'),
    drycSync: t('glossary.term.drycSync', 'Saving keeps the rules here. Send puts them on the dry contact interface, after the logger’s next uplink.'),
    register: t('glossary.term.register', 'Facts an older unit (LOGR2) cannot report itself, kept by hand by in-terra or the customer admin: hardware version, hardware status, LoRa module firmware, whether a firmware update is possible, and the inactivity timeout. A LOGR3 or LOGR4 reports them itself.'),
    commands: t('glossary.term.commands', 'A command reaches the LOGR after its next uplink (LoRaWAN Class A), so it waits here until the device answers. Changes sent before then join one queued set: a later change to the same source replaces the earlier one, and the device receives only the final state. With no answer after a day, or two uplink intervals when longer, the set is shown as unanswered.'),
    peripheralFault: t('glossary.term.peripheralFault', 'Sources the LOGR reported a failed read for, and that have not sent a value since. The device states the fault; nothing is guessed from missing data.')
  };
}

/// What a LOGR answers a command with, when it is not OK (TRX_NANO.md §10.2).
function commandStatus() {
  return {
    ERR_UNKNOWN_OP: t('glossary.commandStatus.ERR_UNKNOWN_OP', 'The device does not know this command'),
    ERR_BAD_TARGET: t('glossary.commandStatus.ERR_BAD_TARGET', 'No such source or position on the device'),
    ERR_BAD_PARAMS: t('glossary.commandStatus.ERR_BAD_PARAMS', 'A parameter is out of range'),
    ERR_UNSUPPORTED: t('glossary.commandStatus.ERR_UNSUPPORTED', 'Not supported by this device'),
    ERR_BUSY: t('glossary.commandStatus.ERR_BUSY', 'The device was busy: retry later'),
    ERR_FAILED: t('glossary.commandStatus.ERR_FAILED', 'The device tried and failed')
  };
}

// The status codes a LOGR sends instead of a value, as a technician reads them
// (TRX_NANO.md §5).
function statusCodes() {
  return {
    ERROR: t('glossary.statusCode.ERROR', 'Logger-side error, not the sensor'),
    TIMEOUT: t('glossary.statusCode.TIMEOUT', 'No reply: the sensor is silent'),
    SENSOR_ERROR: t('glossary.statusCode.SENSOR_ERROR', 'The sensor replies but reports its own error'),
    BUS_ERROR: t('glossary.statusCode.BUS_ERROR', 'Corrupted reply: check wiring and termination'),
    INVALID_DATA: t('glossary.statusCode.INVALID_DATA', 'Read cleanly, but the value is not realistic'),
    NOT_PRESENT: t('glossary.statusCode.NOT_PRESENT', 'Expected but not connected')
  };
}

// Low -> high, the resolvers' order; the names are ThingsBoard's own.
function severities() {
  return [
    { id: 'indeterminate', label: t.severity('indeterminate', 'Indeterminate'), desc: t('glossary.severityDesc.indeterminate', 'Severity not chosen') },
    { id: 'warning', label: t.severity('warning', 'Warning'), desc: t('glossary.severityDesc.warning', 'Heads-up, action on site not mandatory') },
    { id: 'minor', label: t.severity('minor', 'Minor'), desc: t('glossary.severityDesc.minor', 'Action required, no damage expected') },
    { id: 'major', label: t.severity('major', 'Major'), desc: t('glossary.severityDesc.major', 'Action required, damage possible') },
    { id: 'critical', label: t.severity('critical', 'Critical'), desc: t('glossary.severityDesc.critical', 'Immediate action required, significant damage possible') }
  ];
}

function severityNames() {
  var out = {};
  severities().forEach(function (s) { out[s.id] = s.label; });
  return out;
}

// `len` is the typical length after substitution, for the SMS estimate.
function tokens() {
  return [
    { token: '${ssName}', label: t('common.station', 'Station'), len: 20 },
    { token: '${alarmLabel}', label: t('common.measurement', 'Measurement'), len: 14 },
    { token: '${alarmChannel}', label: t('glossary.token.alarmChannel', 'Channel key'), len: 12 },
    { token: '${alarmValue}', label: t('glossary.token.alarmValue', 'Value'), len: 6 },
    { token: '${alarmUnit}', label: t('glossary.token.alarmUnit', 'Unit'), len: 4 },
    { token: '${alarmThreshold}', label: t('glossary.token.alarmThreshold', 'Threshold'), len: 6 },
    { token: '${alarmSeverity}', label: t('common.severity', 'Severity'), len: 8 },
    { token: '${ssUrl}', label: t('glossary.setting.url', 'Dashboard link'), len: 30 }
  ];
}

// A device out of service (ATTRIBUTES.md §4 *Service state*), in the order offered.
function serviceStates() {
  return {
    repair: t('glossary.serviceState.repair', 'In repair'),
    lost: t('glossary.serviceState.lost', 'Lost or stolen'),
    retired: t('common.retired', 'Retired')
  };
}

var LANGUAGES = { en: 'English', de: 'Deutsch', fr: 'Français', it: 'Italiano' };

// GSM 03.38 basic alphabet; anything else makes the SMS UCS-2 (70 per part).
var GSM7 = /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-.\/0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\\[~\]|€]*$/;
var GSM7_EXTENDED = /[\^{}\\\[~\]|€]/g;
var SMS_MAX_PARTS = 3;

/** Estimated SMS size of a template once its fields are filled in. */
function smsInfo(text) {
  var expanded = String(text || '');
  tokens().forEach(function (t) { expanded = expanded.split(t.token).join(new Array(t.len + 1).join('x')); });
  var gsm = GSM7.test(expanded);
  var len = expanded.length + (gsm ? (expanded.match(GSM7_EXTENDED) || []).length : 0);
  var single = gsm ? 160 : 70, part = gsm ? 153 : 67;
  return { len: len, gsm: gsm, single: single, parts: len <= single ? 1 : Math.ceil(len / part), maxParts: SMS_MAX_PARTS };
}

// The Settings widget's names of the resolved scalars.
function settingLabels() {
  return {
    ttlDays: t('glossary.setting.ttlDays', 'Keep data for'), language: t('glossary.setting.language', 'Message language'),
    url: t('glossary.setting.url', 'Dashboard link'), 'sms.enabled': t('glossary.setting.smsEnabled', 'SMS'),
    'email.enabled': t('glossary.setting.emailEnabled', 'E-mail'),
    'notify.contacts': t('glossary.setting.contacts', 'Measurement alarm contacts'),
    'notify.deviceContacts': t('glossary.setting.deviceContacts', 'Device alarm contacts'),
    'alarmText.created': t('glossary.setting.alarmTextCreated', 'Message when an alarm starts'),
    'alarmText.cleared': t('glossary.setting.alarmTextCleared', 'Message when an alarm ends'),
    'emailText.created': t('glossary.setting.emailTextCreated', 'E-mail when an alarm starts'),
    'emailText.cleared': t('glossary.setting.emailTextCleared', 'E-mail when an alarm ends')
  };
}
function bandWords() {
  return { thresholdMax: t('glossary.band.thresholdMax', 'above'), thresholdMin: t('glossary.band.thresholdMin', 'below'),
           state: t('glossary.band.state', 'when'), debounce: t('glossary.band.debounce', 'debounce') };
}
function fieldWords() {
  return { label: t('glossary.field.label', 'name'), hysteresis: t('glossary.field.hysteresis', 'hysteresis'),
           textWhenTrue: t('glossary.field.textWhenTrue', 'text when on'), textWhenFalse: t('glossary.field.textWhenFalse', 'text when off') };
}

function severityLabel(id) { return (severities().filter(function (s) { return s.id === id; })[0] || { label: id }).label; }

/** An `effective.*` key in words, e.g. "pH · Critical above"; `channelLabel(channel)` names a channel. */
function settingLabel(key, channelLabel) {
  var k = key.replace(/^effective\./, '');
  var labels = settingLabels();
  if (labels[k]) { return labels[k]; }
  var band = /^(.+)\.alarm\.([a-z]+)\.([A-Za-z]+)$/.exec(k);
  if (band) { return channelLabel(band[1]) + ' · ' + severityLabel(band[2]) + ' ' + (bandWords()[band[3]] || band[3]); }
  var field = /^(.+)\.([A-Za-z]+)$/.exec(k);
  return field ? channelLabel(field[1]) + ' · ' + (fieldWords()[field[2]] || field[2]) : k;
}

// The tables are getters: a widget reading `G.TERMS.cascade` gets the reader's language.
root.TerrySenseGlossary = {
  settingLabel: settingLabel,
  get TERMS() { return terms(); },
  get STATUS_CODES() { return statusCodes(); },
  get COMMAND_STATUS() { return commandStatus(); },
  get SEVERITIES() { return severities(); },
  get TOKENS() { return tokens(); },
  LANGUAGES: LANGUAGES,
  get SERVICE_STATES() { return serviceStates(); },
  SMS_MAX_PARTS: SMS_MAX_PARTS, smsInfo: smsInfo,
  severity: function (id) { return severities().filter(function (s) { return s.id === id; })[0] || { id: id, label: id, desc: '' }; },
  rank: function (id) { var all = severities(); for (var i = 0; i < all.length; i++) { if (all[i].id === id) { return i; } } return -1; }
};

})(typeof self !== 'undefined' ? self : this);
