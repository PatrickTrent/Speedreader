export const MIN_NODE_MAJOR = 22;
export const MIN_NODE_MINOR = 13;

/** Null when the version can load node:sqlite. Otherwise a message for stderr. */
export function nodeVersionError(version = process.versions.node) {
  const [major, minor] = String(version).split('.').map(Number);
  if (major > MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR)) return null;
  return `Node.js ${version} is too old. Speedreader needs Node.js ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} or newer.`;
}
