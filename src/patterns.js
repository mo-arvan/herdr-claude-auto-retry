
const CSI_REGEX = /\x1b\[[\x20-\x3f]*[\x40-\x7e]/g;
const OSC_REGEX = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
const DCS_REGEX = /\x1bP[\s\S]*?(?:\x07|\x1b\\)/g;
const OTHER_ESC_REGEX = /\x1b[_X^][\s\S]*?(?:\x07|\x1b\\)/g;

export function stripAnsi(text) {
  return String(text)
    .replace(OSC_REGEX, '')
    .replace(DCS_REGEX, '')
    .replace(OTHER_ESC_REGEX, '')
    .replace(CSI_REGEX, '');
}

const LIMIT_PATTERNS = [
  /(?:hit|exceeded|reached).*(?:your|the)\s*(?:[\w-]+\s+){0,3}limit/i,
  /\d+-hour limit/i,
  /session limit/i,
  /weekly limit/i,
  /limit reached/i,
  /usage limit/i,
  /out of.*usage/i,
  /rate limit/i,
  /try again in/i,
];

const USAGE_WARNING = /\b\d{1,3}%\s+of your\b/i;

const RESET_PATTERNS = [
  /resets?\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?/i,
  /resets?\s+in[:\s]\s*\d/i,
  /try again in \d+\s*(?:hours?|minutes?|h|m)/i,
];

const TRANSIENT_PATTERNS = [
  /temporarily limiting requests/i,
  /\brate limited\b/i,
  /\boverloaded\b/i,
  /api error:?\s*(?:5\d\d|429)\b/i,
  /internal server error/i,
  /server[-\s]side issue/i,
  /api error:?\s*connection\b/i,
];

const WINDOW = 6;

const TABLE_ROW_SEPARATORS = /[│┃|]/g;
const TABLE_ROW_START = /^\s*[│┃|]/;

function isTableRow(line) {
  if (!TABLE_ROW_START.test(line)) return false;
  return (line.match(TABLE_ROW_SEPARATORS) || []).length >= 3;
}

const OUTPUT_LINE = /^\s*[⏺⎿]/u;
const AGENT_LINE = /^\s*⏺/u;
const NON_OUTPUT_LINE = /^\s*[⏺⎿❯>]/u;
const PROMPT_LINE = /^\s*[❯>]/u;
const THINKING_LINE = /^\s*\S{0,2}\s*\w+\s+for\s+\d+m?\s?\d*s\b/i;

function outputBlockBounds(lines) {
  let start = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (OUTPUT_LINE.test(lines[k])) { start = k; break; }
  }
  if (start < 0) return null;
  let end = start;
  for (let k = start + 1; k < lines.length; k++) {
    const ln = lines[k];
    if (ln.trim() === '' || NON_OUTPUT_LINE.test(ln) || THINKING_LINE.test(ln)) break;
    end = k;
  }
  return { start, end };
}

export function agentErrorBlock(text) {
  const block = latestOutputBlock(text);
  if (block == null) return null;
  const first = block.split('\n')[0];
  if (!AGENT_LINE.test(first)) return null;
  return TRANSIENT_PATTERNS.some((p) => p.test(first)) ? block : null;
}

export function latestOutputBlock(text) {
  const lines = Array.isArray(text) ? text : stripAnsi(text).split('\n');
  const bounds = outputBlockBounds(lines);
  return bounds ? lines.slice(bounds.start, bounds.end + 1).join('\n') : null;
}

function compile(customPatterns) {
  return (customPatterns || [])
    .map((p) => {
      if (p instanceof RegExp) return p;
      if (typeof p !== 'string') return null;
      try {
        return new RegExp(p, 'i');
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function hasNearbyMatch(lines, idx, patterns) {
  const start = Math.max(0, idx - WINDOW);
  const end = Math.min(lines.length, idx + WINDOW + 1);
  for (let j = start; j < end; j++) {
    if (isTableRow(lines[j])) continue;
    if (patterns.some((p) => p.test(lines[j]))) return true;
  }
  return false;
}

export function isRateLimited(text, customPatterns = [], tailLines = 0) {
  let lines = stripAnsi(text).split('\n');
  if (tailLines > 0) lines = lines.slice(-tailLines);

  const custom = compile(customPatterns);
  if (custom.length > 0) {
    const full = lines.join('\n');
    if (custom.some((p) => p.test(full))) return true;
  }

  for (let i = 0; i < lines.length; i++) {
    if (USAGE_WARNING.test(lines[i])) continue;
    if (isTableRow(lines[i])) continue;
    if (LIMIT_PATTERNS.some((p) => p.test(lines[i]))) {
      if (hasNearbyMatch(lines, i, RESET_PATTERNS)) return true;
    }
  }

  return false;
}

export function limitInLatestBlock(text, tailLines = 0, customPatterns = []) {
  let lines = stripAnsi(text).split('\n');
  if (tailLines > 0) lines = lines.slice(-tailLines);
  const block = latestOutputBlock(lines);
  if (block == null) return false;
  return isRateLimited(block, customPatterns, 0);
}

export function classifyLimit(text, tailLines = 0, customPatterns = [], customTransientPatterns = []) {
  if (isRateLimited(text, customPatterns, tailLines)) return 'reset';
  const all = stripAnsi(text).split('\n');
  const bounds = outputBlockBounds(all);
  const block = bounds ? all.slice(bounds.start, bounds.end + 1).filter((l) => !isTableRow(l)).join('\n') : null;
  const below = bounds ? bounds.end + 1 : Math.max(0, all.length - (tailLines || all.length));
  const footer = all.slice(below).filter((l) => !PROMPT_LINE.test(l) && !isTableRow(l));
  const blob = [block, footer.join('\n')].filter((part) => part).join('\n');
  const transient = TRANSIENT_PATTERNS.concat(compile(customTransientPatterns));
  if (transient.some((p) => p.test(blob))) return 'transient';
  return null;
}

export function findRateLimitMessage(text, tailLines = 0) {
  const all = stripAnsi(text).split('\n');
  let lines = tailLines > 0 ? all.slice(-tailLines) : all;
  lines = lines.filter((l) => !PROMPT_LINE.test(l));

  let limitIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (USAGE_WARNING.test(lines[i])) continue;
    if (isTableRow(lines[i])) continue;
    if (LIMIT_PATTERNS.some((p) => p.test(lines[i]))) {
      limitIdx = i;
      break;
    }
  }

  if (limitIdx >= 0) {
    const start = Math.max(0, limitIdx - WINDOW);
    const end = Math.min(lines.length, limitIdx + WINDOW + 1);
    let best = -1;
    for (let j = start; j < end; j++) {
      if (isTableRow(lines[j])) continue;
      if (RESET_PATTERNS.some((p) => p.test(lines[j]))) {
        if (best === -1 || Math.abs(j - limitIdx) < Math.abs(best - limitIdx)) best = j;
      }
    }
    if (best >= 0) return lines[best].trim();
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    if (isTableRow(lines[i])) continue;
    if (RESET_PATTERNS.some((p) => p.test(lines[i]))) return lines[i].trim();
  }
  if (limitIdx >= 0) return lines[limitIdx].trim();
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isTableRow(lines[i])) continue;
    if (TRANSIENT_PATTERNS.some((p) => p.test(lines[i]))) return lines[i].trim();
  }

  const block = latestOutputBlock(all);
  if (block != null) {
    for (const line of block.split('\n')) {
      if (isTableRow(line)) continue;
      if (TRANSIENT_PATTERNS.some((p) => p.test(line))) return line.trim();
    }
  }

  return null;
}
