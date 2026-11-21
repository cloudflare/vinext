"use strict";

// A CommonJS-only formatting package, the kind older internal registries
// still publish.
var pad = require("./lib/pad");

exports.formatCount = function formatCount(value, unit) {
  var rounded = Math.round(value);
  var grouped = String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return unit ? grouped + " " + unit : grouped;
};

exports.formatCode = function formatCode(prefix, value) {
  return prefix + "-" + pad.padStart(String(value), 4, "0");
};
