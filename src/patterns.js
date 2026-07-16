
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

const OUTPUT_LINE = /^\s*[⏺⎿]/u;
const NON_OUTPUT_LINE = /^\s*[⏺⎿❯>]/u;
const THINKING_LINE = /^\s*\S{0,2}\s*\w+\s+for\s+\d+m?\s?\d*s\b/i;

export function latestOutputBlock(text) {
  const lines = Array.isArray(text) ? text : stripAnsi(text).split('\n');
  let start = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (OUTPUT_LINE.test(lines[k])) { start = k; break; }
  }
  if (start < 0) return null;
  const block = [lines[start]];
  for (let k = start + 1; k < lines.length; k++) {
    const ln = lines[k];
    if (ln.trim() === '' || NON_OUTPUT_LINE.test(ln) || THINKING_LINE.test(ln)) break;
    block.push(ln);
  }
  return block.join('\n');
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
    if (LIMIT_PATTERNS.some((p) => p.test(lines[i]))) {
      if (hasNearbyMatch(lines, i, RESET_PATTERNS)) return true;
    }
  }

  return false;
}

export function classifyLimit(text, tailLines = 0, customPatterns = [], customTransientPatterns = []) {
  if (isRateLimited(text, customPatterns, tailLines)) return 'reset';
  let lines = stripAnsi(text).split('\n');
  if (tailLines > 0) lines = lines.slice(-tailLines);
  const block = latestOutputBlock(lines);
  const blob = block != null ? block : lines.join('\n');
  const transient = TRANSIENT_PATTERNS.concat(compile(customTransientPatterns));
  if (transient.some((p) => p.test(blob))) return 'transient';
  return null;
}

export function findRateLimitMessage(text, tailLines = 0) {
  let lines = stripAnsi(text).split('\n');
  if (tailLines > 0) lines = lines.slice(-tailLines);

  let limitIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (USAGE_WARNING.test(lines[i])) continue;
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
      if (RESET_PATTERNS.some((p) => p.test(lines[j]))) {
        if (best === -1 || Math.abs(j - limitIdx) < Math.abs(best - limitIdx)) best = j;
      }
    }
    if (best >= 0) return lines[best].trim();
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    if (RESET_PATTERNS.some((p) => p.test(lines[i]))) return lines[i].trim();
  }
  if (limitIdx >= 0) return lines[limitIdx].trim();
  for (let i = lines.length - 1; i >= 0; i--) {
    if (TRANSIENT_PATTERNS.some((p) => p.test(lines[i]))) return lines[i].trim();
  }

  return null;
}
