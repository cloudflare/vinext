self.onmessage = (event: MessageEvent<string>) => {
  self.postMessage(`echo: ${event.data}`);
};
