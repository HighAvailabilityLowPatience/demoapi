import express from 'express';
import { createAppServices } from './services/apps.js';
import { requestContext, cors, authenticate, rateLimit, backendError } from './middleware/common.js';
import { livenessRoutes, healthRoutes } from './routes/health.js';
import { appRoutes } from './routes/apps.js';
import deploymentRoutes from './routes/deployments.js';
import { createAppLock } from './services/locks.js';
import deployed from './config/deployed.js';
import { createDeploymentDocker } from './services/deployment-docker.js';
import {
  createDeploymentService,
  validateDeployments
} from './services/deployment.js';

/** Compose the Express application without listening, for use by startup or tests.
 * apps is trusted configuration; docker and fetchHealth are injectable backend clients.
 * Middleware order intentionally keeps liveness public and all management authenticated.
 */
export function createApi({ apps, token, docker, fetchHealth = fetch, origins = [], logger = console.log }) {
  if (!token || token.length < 32) throw new Error('API_TOKEN must contain at least 32 characters');
  for (const [id, app] of Object.entries(apps)) {
    if (!/^[a-z0-9-]+$/.test(id) || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(app.container)) throw new Error('Invalid app registry');
    if (!['http:', 'https:'].includes(new URL(app.healthUrl).protocol)) throw new Error('Invalid health URL');
  // Create one lock shared by every operation that changes containers.
const withAppLock = createAppLock();

// Check that deployment settings match the registered applications.
validateDeployments(deployed, apps);

// Build the individual Docker deployment operations.
const deploymentDocker = createDeploymentDocker(docker, fetchHealth);

// Build the deployment workflow using those operations and our shared lock.
// This function returns the redeploy handler.
const redeploy = createDeploymentService({
  docker: deploymentDocker,
  withAppLock
});

// Existing status and health services.
const services = createAppServices({ docker, fetchHealth });
  
  }
  const services = createAppServices({ docker, fetchHealth });
  const withAppLock = createAppLock();
  const app = express();
  app.disable('x-powered-by');
  app.enable('strict routing');
  app.enable('case sensitive routing');
  app.use(requestContext(logger));
  app.use(cors(origins));
  app.use(livenessRoutes());
  app.use(authenticate(token));
  app.use(rateLimit());
  //ROUTES
  app.use(healthRoutes(apps, services));
  app.use('/v1/apps', appRoutes(apps, services, docker, withAppLock));
  app.use('/v1/deployments', deploymentRoutes(deployed, redeploy));
  app.use(function notFound(req, res) { res.reply(404, { error: 'Route or app not found' }); });
  // Express 5 forwards rejected async route promises to this four-argument handler.
  app.use(backendError);
  return app;
}
