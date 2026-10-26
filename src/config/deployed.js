//per-app image, name network, ports, mounts

// Trusted administrator configuration. Requests select an ID, never an image,
// mount, host port or network. Use image digests for reproducible releases.
export default {
  astro: {
    containerName: 'astro_calc',
    image: 'grout2026/astro-weight-calculator:latest',
    network: 'demo-network', healthUrl: 'http://astro_calc:8888/',
    containerPort: 8888, hostPort: '2134', stopTimeoutSeconds: 10,
    env: [], binds: []
  },
  change: {
    containerName: 'change-calculator',
    image: 'grout2026/web102-change-calculator:latest',
    network: 'demo-network', healthUrl: 'http://change-calculator:8888/',
    containerPort: 8888, hostPort: '80', stopTimeoutSeconds: 10,
    env: [], binds: []
  }
};
