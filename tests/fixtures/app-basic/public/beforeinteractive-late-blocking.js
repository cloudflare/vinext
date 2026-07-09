const blockingStartedAt = performance.now();
while (performance.now() - blockingStartedAt < 500) {}
