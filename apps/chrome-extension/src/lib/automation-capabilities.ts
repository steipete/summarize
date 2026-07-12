export function hasDebuggerCapability() {
  const permissions = globalThis.chrome?.runtime?.getManifest?.().permissions ?? [];
  return permissions.includes("debugger");
}
