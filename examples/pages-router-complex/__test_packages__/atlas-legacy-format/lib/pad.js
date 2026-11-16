"use strict";

exports.padStart = function padStart(value, length, fill) {
  var out = value;
  while (out.length < length) out = fill + out;
  return out;
};
