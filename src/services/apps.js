/** Build app services with injected Docker/HTTP clients for independent tests. */
export function createAppServices({ docker, fetchHealth = fetch }) {
  /**
   * Retrieve the registered container's full Docker metadata for internal use.
   * Return null when it does not exist; throw on other Docker failures.
   * Routes select safe fields instead of exposing this full object to clients.
   */
  async function inspect(app) {
    const result = await docker('GET', `/containers/${encodeURIComponent(app.container)}/json`);
    if (result.status === 404) return null;
    if (result.status !== 200) throw new Error('Docker inspect failed');
    return JSON.parse(result.body.toString());
  }
  /**
   * Probe an app's configured HTTP URL with a four-second deadline.
   * Return { id, healthy, httpStatus }; HTTP 200–399 counts as available.
   * Redirects are not followed. Connection errors/timeouts produce false/null.
   * This tests HTTP availability, not container state or calculator correctness.
   */
  async function health(id, app) {
    let response;
    try {
      response = await fetchHealth(app.healthUrl, { signal: AbortSignal.timeout(4000), redirect: 'manual' });
      return { id, healthy: response.status >= 200 && response.status < 400, httpStatus: response.status };
    } catch { return { id, healthy: false, httpStatus: null }; }
    // Only the status is needed; cancel the body instead of downloading the page.
    finally { await response?.body?.cancel(); }
  }
  return { inspect, health };
}
