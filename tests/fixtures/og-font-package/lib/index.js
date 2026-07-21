export function loadOgFont() {
  return fetch(new URL("./noto-sans.ttf", import.meta.url)).then((response) =>
    response.arrayBuffer(),
  );
}
