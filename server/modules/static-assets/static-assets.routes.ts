import path from 'node:path';

import { Router } from 'express';

/** Used by server/index.ts to serve the built worker before public development assets. */
export function createStaticAssetsRouter(applicationRoot: string) {
  const router = Router();
  router.get('/sw.js', (_request, response, next) => {
    response.sendFile(path.join(applicationRoot, 'dist', 'sw.js'), {
      headers: { 'Cache-Control': 'no-cache' },
    }, (error) => {
      if (!error) return;
      // Source-only development has no built worker; let public/sw.js handle it.
      if ('status' in error && error.status === 404) next();
      else next(error);
    });
  });
  return router;
}
