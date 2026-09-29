import { existsSync } from 'node:fs';
/** .env carga los comandos CLI; variables ya definidas en el host tienen prioridad. */
if (existsSync('.env')) process.loadEnvFile('.env');
