/*
 * The picture calibration LG stores on a rooted TV, read from its files.
 *
 * A 1D or 3D LUT, a 3x3 gamut matrix or an enable flag written to the picture
 * service is kept in /mnt/lg/cmn_data/external_pqldb/<mode>_<profileN>_<RECORD>.
 * This reports each file's size and checksum, never its contents. It is the
 * stored state: a write sent with dataOpt 0 stays in RAM and is not in the
 * files, and the slot follows the picture mode a calibration session was
 * started in, not the mode on screen.
 *
 * Strict ES5 for Node 0.12.2 on webOS 4.
 */

var fs = require('fs');
var crypto = require('crypto');

var SLOT_DIR = '/mnt/lg/cmn_data/external_pqldb';
// 3072 little-endian 16-bit values, and 33 x 33 x 33 x 3 of them.
var KINDS = [
  { suffix: '1D_DPG_DATA', kind: '1d-lut', bytes: 6144 },
  { suffix: '3D_LUT_DATA', kind: '3d-lut', bytes: 215622 },
  { suffix: '3BY3_GAMUT_DATA', kind: 'gamut-matrix', bytes: 36 },
  { suffix: '_EN', kind: 'enable-flag', bytes: 2 }
];
var NAME_PATTERN = /^([A-Za-z0-9]+(?:_[A-Za-z0-9]+)*?)_(profile[0-9]+)_([A-Za-z0-9_]+)$/;

var dir = SLOT_DIR;

function endsWith(text, suffix) {
  return text.length >= suffix.length && text.substr(text.length - suffix.length) === suffix;
}

function classify(name) {
  var m = NAME_PATTERN.exec(name);
  if (!m) return null;
  var record = m[3];
  for (var i = 0; i < KINDS.length; i++) {
    if (endsWith(record, KINDS[i].suffix)) {
      return { mode: m[1], profile: m[2], record: record, kind: KINDS[i].kind, expectedBytes: KINDS[i].bytes };
    }
  }
  return { mode: m[1], profile: m[2], record: record, kind: 'other', expectedBytes: null };
}

function describeFile(name, cb) {
  var info = classify(name);
  if (!info) return cb(null);
  fs.readFile(dir + '/' + name, function (err, data) {
    if (err) return cb(null);
    info.file = name;
    info.bytes = data.length;
    info.sizeMatches = info.expectedBytes === null ? null : data.length === info.expectedBytes;
    info.sha256 = crypto.createHash('sha256').update(data).digest('hex');
    cb(info);
  });
}

/**
 * Calls cb with { available, dir, slots }, slots sorted by file name, or with
 * { available: false } where the folder is missing or unreadable.
 */
function readSlots(cb) {
  fs.readdir(dir, function (err, names) {
    if (err || !names) return cb({ available: false });
    names.sort();
    var slots = [];
    var pending = names.length;
    if (!pending) return cb({ available: true, dir: dir, slots: slots });
    names.forEach(function (name, index) {
      describeFile(name, function (info) {
        if (info) slots[index] = info;
        if (--pending === 0) {
          cb({ available: true, dir: dir, slots: slots.filter(Boolean) });
        }
      });
    });
  });
}

// The two table reads a modern LG answers through externalpq/getExternalPqData.
var TABLES = {
  GET_1D_DPG_DATA: { suffix: '1D_DPG_DATA', bytes: 6144, count: 3072, type: 'uint16' },
  GET_3D_LUT_DATA: { suffix: '3D_LUT_DATA', bytes: 215622, count: 107811, type: 'uint16' }
};

function tableFailure(text) {
  return { returnValue: false, errorText: text };
}

/**
 * Answers getExternalPqData for one command from the stored slot file:
 * { returnValue, data (base64 little-endian uint16), dataCount, dataType,
 * source: 'stored' }. It is the file, never the live picture state, and a
 * write sent with dataOpt 0 is not in it. Anything else, or a missing or
 * wrongly sized file, gets the failure reply the C1 itself gives.
 */
function readTable(command, picMode, profileNo, cb) {
  var table = TABLES.hasOwnProperty(command) ? TABLES[command] : null;
  if (!table) return cb(tableFailure('unsupported command'));
  var profile = 'profile' + (profileNo === undefined || profileNo === null ? 0 : profileNo);
  if (!/^[A-Za-z0-9_]+$/.test(String(picMode || '')) || !/^profile[0-9]+$/.test(profile)) {
    return cb(tableFailure('no file path from tvservice'));
  }
  fs.readdir(dir, function (err, names) {
    var prefix = picMode + '_' + profile + '_';
    var found = null;
    for (var i = 0; !err && names && i < names.length; i++) {
      if (names[i].indexOf(prefix) === 0 && endsWith(names[i], table.suffix)) { found = names[i]; break; }
    }
    if (!found) return cb(tableFailure('no file path from tvservice'));
    fs.readFile(dir + '/' + found, function (e, data) {
      if (e || data.length !== table.bytes) return cb(tableFailure('no file path from tvservice'));
      cb({ returnValue: true, data: data.toString('base64'), dataCount: table.count, dataType: table.type, source: 'stored' });
    });
  });
}

function init(opts) {
  if (opts && opts.dir) dir = opts.dir;
}

module.exports = { init: init, readSlots: readSlots, readTable: readTable, classify: classify };
