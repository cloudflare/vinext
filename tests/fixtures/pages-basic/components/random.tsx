function random() {
  return 4;
}

function Random() {
  return <div data-testid="cjs-basic">Random: {random()}</div>;
}

module.exports = { Random };