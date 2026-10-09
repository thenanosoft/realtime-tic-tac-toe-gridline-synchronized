'use client';

import { useEffect } from 'react';

/**
 * Registers the service worker, and only in a build that has one (P11-08).
 *
 * Registration is relative to the page, so it picks up the GitHub Pages base
 * path without being told what it is - and registering at a path the worker
 * does not actually sit at is the usual way this feature ships broken.
 *
 * Development is excluded on purpose: a worker caching a dev server is a
 * confusing way to spend an afternoon.
 */
export function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const base = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
    navigator.serviceWorker
      .register(`${base}/sw.js`, { scope: `${base}/` })
      .catch(() => {
        // An unregisterable worker is not a reason to break the page. The app
        // works without it; it simply will not be installable.
      });
  }, []);

  return null;
}
