// SPDX-License-Identifier: LGPL-2.1-only
// OPFS staging directories. Each tab owns one, named after its session id, and
// holds a Web Lock with the same id while it is open. The service worker holds
// a second lock while it streams a download. A directory whose locks are both
// free belongs to a tab that is gone, so it can be reclaimed.

const PREFIX = 'staging-';
const ID = /^[0-9a-f]{32}$/;

export function newSessionId() {
  return crypto.randomUUID().replace(/-/g, '');
}
export function isSessionId(id) {
  return ID.test(id);
}
export function stagingDirName(id) {
  if (!isSessionId(id)) throw new Error('bad session id');
  return PREFIX + id;
}
export function sessionLock(id) {
  return `manhunt1-nx-session-${id}`;
}
export function downloadLock(id) {
  return `manhunt1-nx-download-${id}`;
}

// Holds the session lock until the tab closes.
export function holdSession(id) {
  return new Promise((resolve) => {
    navigator.locks.request(sessionLock(id), () => {
      resolve();
      return new Promise(() => {});
    });
  });
}

// Removes staging directories left by earlier sessions. Returns their names.
export async function reclaimStaging(ownId) {
  const root = await navigator.storage.getDirectory();
  const stale = [];
  for await (const [name, handle] of root.entries()) {
    if (handle.kind !== 'directory' || !name.startsWith(PREFIX)) continue;
    const id = name.slice(PREFIX.length);
    if (id === ownId) continue;
    if (!isSessionId(id)) { stale.push(name); continue; }
    const free = await navigator.locks.request(sessionLock(id), { ifAvailable: true }, (l1) =>
      l1 && navigator.locks.request(downloadLock(id), { ifAvailable: true }, (l2) => !!l2));
    if (free) stale.push(name);
  }
  const removed = [];
  for (const name of stale) {
    try {
      await root.removeEntry(name, { recursive: true });
      removed.push(name);
    } catch { /* in use; try again next time */ }
  }
  return removed;
}

export async function removeOwnStaging(id) {
  const root = await navigator.storage.getDirectory();
  try { await root.removeEntry(stagingDirName(id), { recursive: true }); } catch { /* not there */ }
}
