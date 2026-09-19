export function createPluginWithHome<T>(home: string, createPlugin: () => T): T {
  const originalHome = process.env.HOME;
  try {
    process.env.HOME = home;
    return createPlugin();
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
}
