import { app } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';

app.listen(env.PORT, () => {
  logger.info({ message: 'API listening', port: env.PORT, nodeEnv: env.NODE_ENV });
});
