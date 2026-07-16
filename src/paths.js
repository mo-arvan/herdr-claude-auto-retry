import { join } from 'node:path';
import { homedir } from 'node:os';

export function stateDir() {
  return process.env.HERDR_PLUGIN_STATE_DIR || join(homedir(), '.local', 'state', 'herdr', 'claude-auto-retry');
}

export function logsDir() {
  return join(stateDir(), 'logs');
}

export function monitorsDir() {
  return join(stateDir(), 'monitors');
}
