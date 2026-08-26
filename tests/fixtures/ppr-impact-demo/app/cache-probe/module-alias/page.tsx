export const revalidate = 60;

// Capturing this alias during module evaluation used to bypass wrappers that
// were installed from the generated entry body after static imports ran.
const currentTime = Date.now;

export default function ModuleAliasPage() {
  return <main>module alias time: {currentTime()}</main>;
}
