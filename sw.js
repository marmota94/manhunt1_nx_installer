// SPDX-License-Identifier: LGPL-2.1-only
// Streams a finished SD package from OPFS to the browser's downloads. It
// handles only download/<session id>/<file name>; every other request goes to
// the network as usual.

import { isSessionId, stagingDirName, downloadLock } from './js/staging.js';

const NAME = /^manhunt1-nx-v\d+\.\d+\.\d+-sd\.zip$/;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (ev) => ev.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (ev) => {
  const url = new URL(ev.request.url);
  const base = new URL('download/', self.registration.scope);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return;
  const [id, name, ...rest] = url.pathname.slice(base.pathname.length).split('/');
  if (rest.length || !isSessionId(id) || !NAME.test(name ?? '') || ev.request.method !== 'GET') {
    ev.respondWith(new Response('Not found', { status: 404 }));
    return;
  }
  ev.respondWith(serve(ev, id, name));
});

async function serve(ev, id, name) {
  let file;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(stagingDirName(id));
    file = await (await dir.getFileHandle(name)).getFile();
  } catch {
    return new Response('This package is no longer staged. Build it again.', {
      status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
  // Hold the download lock while streaming so another tab cannot reclaim the
  // staging directory under us.
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const locked = new Promise((resolve) => {
    navigator.locks.request(downloadLock(id), { mode: 'shared' }, () => { resolve(); return held; });
  });
  await locked;
  const { readable, writable } = new TransformStream();
  ev.waitUntil(file.stream().pipeTo(writable).catch(() => {}).finally(release));
  return new Response(readable, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Length': String(file.size),
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
