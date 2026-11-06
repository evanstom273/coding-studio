#!/usr/bin/env node
import { COMPANION_DEFAULT_PORT, startCompanion } from './service';

const port = Number(process.env.CODING_STUDIO_COMPANION_PORT) || COMPANION_DEFAULT_PORT;
startCompanion(port)
  .then(() => console.log(`Coding Studio companion listening on http://127.0.0.1:${port} (Ctrl+C to stop)`))
  .catch((e: NodeJS.ErrnoException) => {
    console.error(e.code === 'EADDRINUSE' ? `Port ${port} is in use — is the companion already running?` : e.message);
    process.exit(1);
  });
