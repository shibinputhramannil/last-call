// Ticks for the connection heartbeat. Timers in a worker keep running when the
// tab is in the background, where the page's own timers are slowed to as little
// as once a minute, so the server keeps hearing from players who switch tabs.

let timer = null;

self.onmessage = (event) => {
  clearInterval(timer);
  if (event.data && event.data.start) timer = setInterval(() => self.postMessage('tick'), event.data.everyMs);
};
