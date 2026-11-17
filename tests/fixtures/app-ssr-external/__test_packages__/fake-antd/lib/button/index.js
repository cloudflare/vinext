"use strict";
const omit = require("rc-util/lib/omit").default;
const { createElement } = require("react");
exports.default = function Button({ id }) {
  return createElement("b", { "data-testid": id }, omit("antd-button"));
};
