import path from "node:path";

function pathImplementation(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  if (/^[A-Za-z]:[\\/]/.test(value) || /^[/\\]{2}[^/\\]+[/\\][^/\\]+/.test(value)) {
    return path.win32;
  }
  if (path.posix.isAbsolute(value)) return path.posix;
  if (path.win32.isAbsolute(value)) return path.win32;
  return null;
}

export function isAbsolutePath(value) {
  return pathImplementation(value) !== null;
}

export function resolveInputPath(value, cwd) {
  if (isAbsolutePath(value)) return value;
  const implementation = pathImplementation(cwd) ?? path;
  return implementation.resolve(cwd, value);
}

export function pathContains(root, candidate) {
  const implementation = pathImplementation(root);
  if (!implementation || implementation !== pathImplementation(candidate)) return false;
  const relative = implementation.relative(
    implementation.normalize(root),
    implementation.normalize(candidate),
  );
  return relative === ""
    || (!relative.startsWith(`..${implementation.sep}`)
      && relative !== ".."
      && !implementation.isAbsolute(relative));
}
