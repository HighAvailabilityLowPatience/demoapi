import { Router } from 'express';

/** Public process liveness only; mounted before management authentication. */
export function livenessRoutes() {
  const router = Router();
  router.get('/livez', function live(req, res) { res.reply(200, { status: 'ok' }); });
  return router;
}

/** Authenticated aggregate application availability, independent of Docker state. */
export function healthRoutes(apps, services) {
  const router = Router();
  router.get('/health', async function aggregateHealth(req, res) {
    // Probe concurrently and return 503 when any registered app is unavailable.
    const results = await Promise.all(Object.entries(apps).map(([id, app]) => services.health(id, app)));
    const healthy = results.every(app => app.healthy);
    res.reply(healthy ? 200 : 503, { healthy, apps: results });
  });
  return router;
}
