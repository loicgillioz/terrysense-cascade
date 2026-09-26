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

var TERMS = {
  cascade: 'Settings flow down: <b>in-terra defaults → Customer → Project → Location → Station</b>. The nearest level that sets a value wins. A value set here applies to every station below.',
  measurements: 'Alarm thresholds, display unit and hysteresis, set per measurement.',
  notifications: 'Who receives alarm messages, by SMS and e-mail, and what the messages say.',
  retention: 'How long measured data is kept before it is deleted. A change applies to new data only.',
  hysteresis: 'An absolute margin, zero or positive, in the measurement unit. The alarm clears only once the value is back past the threshold by this margin, so a value hovering at the limit does not trigger alarms repeatedly.',
  unit: 'The unit shown in dashboards and alarm messages. Leave empty to use the standard unit of the measurement.',
  label: 'The name alarm messages use for this measurement, e.g. “Tank 3 pH”. Leave empty to use the standard name.',
  severity: '<b>Critical</b> — immediate action required, significant damage possible.<br><b>Major</b> — action required, damage possible.<br><b>Minor</b> — action required, no damage expected.<br><b>Warning</b> — heads-up; action on site not mandatory.<br><b>Indeterminate</b> — no severity chosen.',
  thresholds: 'An alarm is raised when a value goes above or below a threshold. Several thresholds with different severities escalate one alarm, e.g. Warning above 8, Critical above 9.',
  boolAlarm: 'Raise an alarm when the input takes this value. One condition per severity.',
  stateAlarm: 'Raise an alarm when the measurement reports this state. One condition per severity.',
  boolText: 'How the two values read in dashboards and alarm messages, e.g. “open” and “closed”.',
  alarmText: 'The wording of the SMS, also used for the e-mail unless a longer e-mail text is set. Insert fields such as the measured value; they are filled in when the message is sent.',
  smsLength: 'One SMS holds 160 characters, or 70 when the text contains a character outside the SMS alphabet (e.g. ê, ç, emoji). Longer texts are split and billed per part. Fields count at a typical length, the dashboard link at 30.',
  contacts: 'People who receive alarm messages: platform users, whose e-mail and phone come from their profile, or external contacts. Each contact receives only the severities ticked for them.',
  channels: 'Master switches. When off, or never set, no message of that type leaves this level or any level below, whatever the contacts say.',
  noPhone: 'No phone number in this user’s profile. Add one in the user settings to send SMS.',
  channelName: 'The name a measurement is stored under. It stays the same when the LOGR or sensor is replaced, so the history is continuous.',
  position: 'The connector on the LOGR bus the sensor is plugged into. Position 0 is the LOGR itself.',
  device: 'The device that sends the data for this station. Change it after a hardware swap; the history stays intact.',
  station: 'The measuring point the measurements belong to, shown on dashboards.',
  diagnostics: 'Measurements about the LOGR itself (battery, charger, enclosure). Rarely needed on a station.',
  inUse: 'Measurements mapped on at least one station below this level.',
  uplink: 'Active while the LOGR has sent anything within its inactivity timeout. A unit that went silent shows here, even when every sensor was fine at its last uplink.',
  drycRules: 'The relay controller runs these rules itself, first to last. A rule that notifies wakes the logger when it starts and when it ends; the station then raises or clears an alarm, sent to its contacts like any other.',
  drycRecords: 'The relay controller holds at most 16 records: one per notifying rule, and one per relay a rule switches.',
  drycSync: 'Saving keeps the rules here. Send puts them on the relay controller, after the logger’s next uplink.',
  commands: 'A command reaches the LOGR after its next uplink (LoRaWAN Class A), so it waits here until the device answers. With no answer after a day, or two uplink intervals when longer, it is shown as unanswered.',
  peripheralFault: 'Sources the LOGR reported a failed read for, and that have not sent a value since. The device states the fault; nothing is guessed from missing data.'
};

// What a LOGR answers a command with, when it is not OK (TRX_NANO.md §10.2).
var COMMAND_STATUS = {
  ERR_UNKNOWN_OP: 'The device does not know this command',
  ERR_BAD_TARGET: 'No such source or position on the device',
  ERR_BAD_PARAMS: 'A parameter is out of range',
  ERR_UNSUPPORTED: 'Not supported by this device',
  ERR_BUSY: 'The device was busy: retry later',
  ERR_FAILED: 'The device tried and failed'
};

// The status codes a LOGR sends instead of a value, as a technician reads them
// (TRX_NANO.md §5).
var STATUS_CODES = {
  ERROR: 'Logger-side error, not the sensor',
  TIMEOUT: 'No reply: the sensor is silent',
  SENSOR_ERROR: 'The sensor replies but reports its own error',
  BUS_ERROR: 'Corrupted reply: check wiring and termination',
  INVALID_DATA: 'Read cleanly, but the value is not realistic',
  NOT_PRESENT: 'Expected but not connected'
};

// Low -> high, the resolvers' order.
var SEVERITIES = [
  { id: 'indeterminate', label: 'Indeterminate', desc: 'Severity not chosen' },
  { id: 'warning', label: 'Warning', desc: 'Heads-up, action on site not mandatory' },
  { id: 'minor', label: 'Minor', desc: 'Action required, no damage expected' },
  { id: 'major', label: 'Major', desc: 'Action required, damage possible' },
  { id: 'critical', label: 'Critical', desc: 'Immediate action required, significant damage possible' }
];

// `len` is the typical length after substitution, for the SMS estimate.
var TOKENS = [
  { token: '${ssName}', label: 'Station', len: 20 },
  { token: '${alarmLabel}', label: 'Measurement', len: 14 },
  { token: '${alarmChannel}', label: 'Channel key', len: 12 },
  { token: '${alarmValue}', label: 'Value', len: 6 },
  { token: '${alarmUnit}', label: 'Unit', len: 4 },
  { token: '${alarmThreshold}', label: 'Threshold', len: 6 },
  { token: '${alarmSeverity}', label: 'Severity', len: 8 },
  { token: '${ssUrl}', label: 'Dashboard link', len: 30 }
];

var LANGUAGES = { en: 'English', de: 'Deutsch', fr: 'Français', it: 'Italiano' };

// GSM 03.38 basic alphabet; anything else makes the SMS UCS-2 (70 per part).
var GSM7 = /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-.\/0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\\[~\]|€]*$/;
var GSM7_EXTENDED = /[\^{}\\\[~\]|€]/g;
var SMS_MAX_PARTS = 3;

/** Estimated SMS size of a template once its fields are filled in. */
function smsInfo(text) {
  var expanded = String(text || '');
  TOKENS.forEach(function (t) { expanded = expanded.split(t.token).join(new Array(t.len + 1).join('x')); });
  var gsm = GSM7.test(expanded);
  var len = expanded.length + (gsm ? (expanded.match(GSM7_EXTENDED) || []).length : 0);
  var single = gsm ? 160 : 70, part = gsm ? 153 : 67;
  return { len: len, gsm: gsm, single: single, parts: len <= single ? 1 : Math.ceil(len / part), maxParts: SMS_MAX_PARTS };
}

root.TerrySenseGlossary = {
  TERMS: TERMS, STATUS_CODES: STATUS_CODES, COMMAND_STATUS: COMMAND_STATUS, SEVERITIES: SEVERITIES, TOKENS: TOKENS, LANGUAGES: LANGUAGES,
  SMS_MAX_PARTS: SMS_MAX_PARTS, smsInfo: smsInfo,
  severity: function (id) { return SEVERITIES.filter(function (s) { return s.id === id; })[0] || { id: id, label: id, desc: '' }; },
  rank: function (id) { for (var i = 0; i < SEVERITIES.length; i++) { if (SEVERITIES[i].id === id) { return i; } } return -1; }
};

})(typeof self !== 'undefined' ? self : this);
