import { config } from './config.js';
import { store } from './repository.js';
import { startServer } from './server.js';
import { startScheduler } from './scheduler.js';

process.env.TZ = config.TZ;
store.recoverInterrupted();
startServer();
startScheduler();
