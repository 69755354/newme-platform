// Shared in-memory task store for KNX design pipelines
// Both route.ts and status/route.ts import this singleton

const store = new Map<string, any>();

export function getStore() {
  return store;
}
