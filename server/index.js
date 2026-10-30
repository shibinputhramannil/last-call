import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { createNarrator } from './narrator.js';

const config = loadConfig();
const narrator = createNarrator(config.narrator);
const { server, close } = createApp(config, { narrator });

server.listen(config.port, config.host, () => {
  const { port } = server.address();
  console.log(`Last Call is listening on http://localhost:${port}`);
  console.log(`Exchange narrator: ${narrator.enabled ? `Claude (${config.narrator.model})` : 'built-in lines'}`);
});

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (closing) process.exit(1);
    closing = true;
    console.log('Closing the exchange...');
    await close();
    process.exit(0);
  });
}
