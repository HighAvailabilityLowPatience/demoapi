import { Router } from 'express';

/**
 * Receive trusted settings and the deployment handler from app.js.
 */
export default function deploymentRoutes(definitions, redeploy) {
  const router = Router();

  router.post('/:appId', async function deployApp(req, res) {
    const { appId } = req.params;

    // Only deploy applications listed in our trusted configuration.
    if (!Object.hasOwn(definitions, appId)) {
      return res.reply(404, {
        error: 'Application is not configured for deployment'
      });
    }

    // Run the deployment and wait for its result.
    const result = await redeploy(appId, definitions[appId]);

    return res.reply(200, result);
  });

  return router;
}