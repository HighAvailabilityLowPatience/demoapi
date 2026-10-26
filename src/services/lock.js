export function createAppLock() {
  const activeContainers = new Set();

  return async function withAppLock(containerName, operation) {
    if (activeContainers.has(containerName)) {
      const error = new Error(
        'Another operation is already running for this container'
      );

      error.status = 409;
      throw error;
    }

    activeContainers.add(containerName);

    try {
      return await operation();
    } finally {
      activeContainers.delete(containerName);
    }
  };
}