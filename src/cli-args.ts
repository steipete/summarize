export function readCliOptionValue(argv: readonly string[], name: string): string | null {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(`${name}=`.length).trim() || null;
  const index = argv.indexOf(name);
  if (index === -1) return null;
  const next = argv[index + 1];
  if (!next || next.startsWith("-")) return null;
  return next.trim() || null;
}
