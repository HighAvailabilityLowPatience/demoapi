import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Build the Docker operations used by the deployment service.
 *
 * request is the existing Docker connection passed from app.js.
 * fetchHealth checks whether an application responds over HTTP.
 */
export function createDeploymentDocker(request, fetchHealth = fetch) {
  /**
   * Send a Docker request and check its HTTP status.
   *
   * Individual helpers specify which status codes count as success.
   * Return the response so the helper can read its body if needed.
   */
  async function call(method, path, body, allowedStatuses = [200]) {
    const result = await request(method, path, body);

    if (!allowedStatuses.includes(result.status)) {
      throw new Error(
        `Docker request failed: ${method} ${path} (${result.status})`
      );
    }

    return result;
  }

  /**
   * Build a container address safely.
   * Accepts either a container ID or a container name.
   */
  function containerPath(idOrName) {
    return `/containers/${encodeURIComponent(idOrName)}`;
  }

  /**
   * Confirm the configured network exists before changing containers.
   * Failure throws an error and stops the deployment workflow.
   */
  async function requireNetwork(networkName) {
    await call(
      'GET',
      `/networks/${encodeURIComponent(networkName)}`
    );
  }

  /**
   * Find a container and return its Docker metadata.
   * Return null when it does not exist.
   */
  async function inspectOptional(idOrName) {
    const result = await call(
      'GET',
      `${containerPath(idOrName)}/json`,
      undefined,
      [200, 404]
    );

    if (result.status === 404) return null;

    return JSON.parse(result.body.toString('utf8'));
  }

  /**
   * Download the configured image.
   *
   * Docker returns newline-separated JSON progress messages.
   * A successful HTTP status can still contain a pull error,
   * so check each message before continuing.
   *
   * Finally, resolve the downloaded image to its exact local ID.
   */
  async function pullImage(image) {
    const result = await call(
      'POST',
      `/images/create?fromImage=${encodeURIComponent(image)}`
    );

    const messages = result.body
      .toString('utf8')
      .split('\n')
      .filter(line => line.trim() !== '');

    for (const message of messages) {
      const progress = JSON.parse(message);

      if (progress.error || progress.errorDetail) {
        throw new Error('Docker could not pull the requested image');
      }
    }

    const inspection = await call(
      'GET',
      `/images/${encodeURIComponent(image)}/json`
    );

    return JSON.parse(inspection.body.toString('utf8')).Id;
  }

  /**
   * Stop a container gracefully.
   * Docker forcefully terminates it if the grace period expires.
   * HTTP 304 means it was already stopped.
   */
  async function stopContainer(id, timeoutSeconds = 10) {
    await call(
      'POST',
      `${containerPath(id)}/stop?t=${timeoutSeconds}`,
      undefined,
      [204, 304]
    );
  }

  /**
   * Rename the old container so it can remain available for rollback
   * while the replacement uses the original name.
   */
  async function renameContainer(id, newName) {
    await call(
      'POST',
      `${containerPath(id)}/rename?name=${encodeURIComponent(newName)}`,
      undefined,
      [204]
    );
  }

  /**
   * Remove one specific container.
   *
   * force is used for a failed replacement that may still be running.
   * v=0 preserves volumes; this never runs a broad Docker cleanup.
   */
  async function removeContainer(id, force = false) {
    await call(
      'DELETE',
      `${containerPath(id)}?force=${force ? 1 : 0}&v=0`,
      undefined,
      [204, 404]
    );
  }

  /**
   * Create the replacement from trusted application settings.
   *
   * imageId is the exact image resolved by pullImage.
   * The stable name keeps the Cloudflare destination unchanged.
   * Automatic restarts are explicitly disabled.
   */
  async function createContainer(definition, imageId) {
    const port = `${definition.containerPort}/tcp`;

    const settings = {
      Image: imageId,

      Env: definition.env || [],

      ExposedPorts: {
        [port]: {}
      },

      Labels: {
        'demo-api.managed': 'true',
        'demo-api.deployment': definition.deploymentId
      },

      HostConfig: {
        NetworkMode: definition.network,

        RestartPolicy: {
          Name: 'no'
        },

        Binds: definition.binds || [],

        PortBindings: definition.hostPort
          ? {
              [port]: [{
                HostIp: '0.0.0.0',
                HostPort: String(definition.hostPort)
              }]
            }
          : {}
      },

      NetworkingConfig: {
        EndpointsConfig: {
          [definition.network]: {}
        }
      }
    };

    const result = await call(
      'POST',
      `/containers/create?name=${
        encodeURIComponent(definition.containerName)
      }`,
      settings,
      [201]
    );

    return JSON.parse(result.body.toString('utf8'));
  }

  /**
   * Start the container that was just created.
   * HTTP 304 means it was already running.
   */
  async function startContainer(id) {
    await call(
      'POST',
      `${containerPath(id)}/start`,
      undefined,
      [204, 304]
    );
  }

  /**
   * Wait for the application to respond successfully.
   *
   * Retry for approximately 30 seconds.
   * Each HTTP attempt has a maximum duration of three seconds.
   * Accept HTTP 200–399 without following redirects.
   */
  async function waitForHealthy(healthUrl) {
    const deadline = Date.now() + 30_000;

    while (Date.now() < deadline) {
      let response;

      try {
        response = await fetchHealth(healthUrl, {
          signal: AbortSignal.timeout(3_000),
          redirect: 'manual'
        });

        if (response.status >= 200 && response.status < 400) {
          return;
        }
      } catch {
        // The app may still be starting. Retry until the deadline.
      } finally {
        // We only need the status, so discard the response body.
        await response?.body?.cancel();
      }

      await sleep(500);
    }

    throw new Error('Application did not become healthy in time');
  }

  // These are the operations available to the deployment service.
  return {
    requireNetwork,
    inspectOptional,
    pullImage,
    stopContainer,
    renameContainer,
    removeContainer,
    createContainer,
    startContainer,
    waitForHealthy
  };
}