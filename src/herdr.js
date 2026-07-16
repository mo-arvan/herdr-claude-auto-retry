
import { execFile } from 'node:child_process';

function herdrBin() {
  return process.env.HERDR_BIN_PATH || 'herdr';
}

function run(args, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    execFile(herdrBin(), args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
        stdout: stdout || '',
        stderr: stderr || '',
      });
    });
  });
}

export function parseEnvelope({ stdout, stderr }) {
  const tryParse = (s) => {
    s = (s || '').trim();
    if (!s) return null;
    try {
      return JSON.parse(s);
    } catch {
      const line = s.split('\n').reverse().find((l) => l.trim().startsWith('{'));
      if (!line) return null;
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }
  };
  return tryParse(stdout) || tryParse(stderr) || null;
}

export function createHerdr() {
  async function paneList() {
    const res = await run(['pane', 'list']);
    const env = parseEnvelope(res);
    return env?.result?.panes || [];
  }

  async function paneGet(paneId) {
    const res = await run(['pane', 'get', paneId]);
    const env = parseEnvelope(res);
    if (!env || env.error) return null;
    return env.result?.pane || null;
  }

  async function paneRead(paneId, { source = 'recent', lines = 25 } = {}) {
    const res = await run(['pane', 'read', paneId, '--source', source, '--lines', String(lines)]);
    if (res.code !== 0) return null;
    return res.stdout;
  }

  async function sendText(paneId, text) {
    return run(['pane', 'send-text', paneId, text]);
  }

  async function sendKeys(paneId, ...keys) {
    return run(['pane', 'send-keys', paneId, ...keys]);
  }

  async function reportMetadata(paneId, { customStatus, clear = false, agent, ttlMs } = {}) {
    const args = ['pane', 'report-metadata', paneId, '--source', 'claude-auto-retry'];
    if (agent) args.push('--agent', agent);
    if (clear) {
      args.push('--clear-custom-status');
    } else {
      if (customStatus != null) args.push('--custom-status', customStatus);
      if (ttlMs != null) args.push('--ttl-ms', String(ttlMs));
    }
    return run(args);
  }

  async function listClaudePanes() {
    return (await paneList()).filter(isClaudeAgent);
  }

  async function findByTerminalId(terminalId) {
    return (await paneList()).find((p) => p.terminal_id === terminalId) || null;
  }

  return { paneList, paneGet, paneRead, sendText, sendKeys, reportMetadata, listClaudePanes, findByTerminalId };
}

export function isClaudeAgent(pane) {
  return !!(pane && typeof pane.agent === 'string' && /claude/i.test(pane.agent));
}
