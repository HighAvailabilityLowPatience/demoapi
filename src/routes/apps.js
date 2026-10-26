import { Router } from 'express';
import { decodeLogs } from '../services/docker.js';


/** Routes for registered apps. No caller can supply an arbitrary Docker API path. */
export function appRoutes(apps, services, docker, withAppLock) {
  const router = Router();
  router.get('/', function listApps(req, res) {
    res.reply(200, { apps: Object.entries(apps).map(([id, app]) => ({ id, container: app.container })) });
  });
  // Resolve a trusted app record once, before any per-app handler accesses Docker.
  router.param('id', function resolveApp(req, res, next, id) {
    if (!Object.hasOwn(apps, id)) return res.reply(404, { error: 'Route or app not found' });
    req.demoApp = apps[id];
    next();
  });
  /** Fetch metadata or finish the request if its registered container is absent. */
  async function detail(req, res) {
    const value = await services.inspect(req.demoApp);
    if (!value) res.reply(404, { error: 'Configured container does not exist' });
    return value;
  }
  router.get('/:id/status', async function status(req, res) {
    const d = await detail(req, res);
    if (!d) return;
    res.reply(200, { id: req.params.id, container: req.demoApp.container, status: d.State.Status,
      running: d.State.Running, exitCode: d.State.ExitCode, restartPolicy: d.HostConfig.RestartPolicy.Name,
      networks: Object.keys(d.NetworkSettings.Networks) });
  });
  router.get('/:id/health', async function appHealth(req, res) {
    res.reply(200, await services.health(req.params.id, req.demoApp));
  });
  router.get('/:id/logs', async function logs(req, res) {
    const tail = req.query.tail ?? '100';
    if (typeof tail !== 'string' || !/^\d+$/.test(tail) || Number(tail) < 1 || Number(tail) > 500) return res.reply(400, { error: 'tail must be between 1 and 500' });
    const d = await detail(req, res);
    if (!d) return;
    const result = await docker('GET', `/containers/${encodeURIComponent(req.demoApp.container)}/logs?stdout=1&stderr=1&tail=${Number(tail)}`);
    if (result.status !== 200) throw new Error('Docker logs failed');
    res.reply(200, { id: req.params.id, logs: decodeLogs(result.body, d.Config.Tty) });
  });
  /** Create one explicit lifecycle handler; serialize changes to each app. */
  function lifecycle(operation) {
  return async function changeContainer(req, res) {
    const id = req.params.id;
    const containerName = req.demoApp.container;

    return withAppLock(containerName, async function operate() {
      // Confirm the configured container exists.
      if (!await detail(req, res)) return;

      // Ask Docker to perform the requested operation.
      const result = await docker(
        'POST',
        `/containers/${encodeURIComponent(containerName)}/${operation}?t=10`
      );

      if (![204, 304].includes(result.status)) {
        return res.reply(502, {
          error: 'Docker rejected operation',
          dockerStatus: result.status
        });
      }

      return res.reply(200, {
        id,
        operation,
        changed: result.status !== 304
      });
    });
  };
}
  router.post('/:id/start', lifecycle('start'));
  router.post('/:id/stop', lifecycle('stop'));
  router.post('/:id/restart', lifecycle('restart'));
  // Explicit method fallbacks keep incorrect verbs from looking like missing apps.
  for (const operation of ['status', 'health', 'logs', 'start', 'stop', 'restart']) {
    router.all(`/:id/${operation}`, function methodNotAllowed(req, res) {
      res.set('Allow', ['status', 'health', 'logs'].includes(operation) ? 'GET' : 'POST');
      res.reply(405, { error: 'Method not allowed' });
    });
  }
  return router;
}
