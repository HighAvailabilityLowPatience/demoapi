//reusable replacement workflow containers deployed inside the demo container

import { randomUUID } from 'node:crypto';

/** Validate trusted deployment definitions once, before accepting traffic. */
export function validateDeployments(definitions, apps) {
  const names = new Set();
  for (const [id, d] of Object.entries(definitions)) {
    if (!Object.hasOwn(apps, id) || apps[id].container !== d.containerName || names.has(d.containerName)) throw new Error('Deployment registry mismatch');
    names.add(d.containerName);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(d.containerName) || !d.image || !d.network ||
      !Number.isInteger(d.containerPort) || d.containerPort < 1 || d.containerPort > 65535 ||
      !Number.isInteger(d.stopTimeoutSeconds) || d.stopTimeoutSeconds < 0 || d.stopTimeoutSeconds > 30 ||
      !Array.isArray(d.env) || !Array.isArray(d.binds) ||
      (d.hostPort && (!/^\d+$/.test(d.hostPort) || Number(d.hostPort) < 1 || Number(d.hostPort) > 65535)) ||
      !['http:', 'https:'].includes(new URL(d.healthUrl).protocol)) throw new Error('Invalid deployment definition');
  }
}

/** Replace containers under the same shared lock as start/stop/restart. */
export function createDeploymentService({ docker, withAppLock }) {
  return async function redeploy(appId, definition) {
    return withAppLock(definition.containerName, async function replaceContainer() {
      const backupName = `${definition.containerName}-previous`;
      // A leftover backup signals interrupted work; never overwrite or blindly delete it.
      if (await docker.inspectOptional(backupName)) {
        const e = new Error('Previous deployment needs recovery'); e.status = 409; throw e;
      }
      await docker.requireNetwork(definition.network);
      const imageId = await docker.pullImage(definition.image);
      const previous = await docker.inspectOptional(definition.containerName);
      const deploymentId = randomUUID();
      let renamed = false;
      try {
        if (previous) {
          await docker.stopContainer(previous.Id, definition.stopTimeoutSeconds);
          await docker.renameContainer(previous.Id, backupName);
          renamed = true;
        }
        const replacement = await docker.createContainer({ ...definition, deploymentId }, imageId);
        await docker.startContainer(replacement.Id);
        await docker.waitForHealthy(definition.healthUrl);
      } catch {
        let recovery = 'not-needed';
        try {
          // Reconcile uncertain create/rename responses by inspecting Docker's actual state.
          const current = await docker.inspectOptional(definition.containerName);
          if (current && current.Id !== previous?.Id) {
            if (current.Config?.Labels?.['demo-api.deployment'] !== deploymentId) throw new Error('Unowned name conflict');
            await docker.removeContainer(current.Id, true);
          }
          if (previous) {
            const old = await docker.inspectOptional(previous.Id);
            if (!old) throw new Error('Previous container missing');
            if (old.Name !== `/${definition.containerName}`) await docker.renameContainer(previous.Id, definition.containerName);
            if (previous.State.Running) {
              await docker.startContainer(previous.Id);
              await docker.waitForHealthy(definition.healthUrl);
            }
            recovery = 'restored';
          } else recovery = 'cleaned';
        } catch { recovery = 'failed'; }
        const e = new Error('Deployment failed'); e.deployment = { appId, status: 'failed', recovery }; throw e;
      }
      // Cleanup failure must not tear down a healthy replacement. Report it explicitly.
      let cleanup = 'complete';
      if (renamed) {
        try { await docker.removeContainer(previous.Id); }
        catch { cleanup = 'pending'; }
      }
      return { appId, status: 'deployed', imageId, cleanup,
        ...(cleanup === 'pending' ? { retainedContainer: backupName } : {}) };
    });
  };
}