
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
];

const USAGE_WARNING = /\b\d{1,3}%\s+of your\b/i;
const NOT_A_STOP = /\bfast[- ](?:mode|limit)\b|\bspend limit\b/i;

const RESET_PATTERNS = [
  /resets?\s+(?:at\s+)?(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?/i,
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
  /unable to connect to api/i,
  /experiencing high load/i,
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

function toLines(text) {
  return Array.isArray(text) ? text : stripAnsi(text).split('\n');
}

export function latestOutputBlock(text) {
  const lines = toLines(text);
  const bounds = outputBlockBounds(lines);
  return bounds ? lines.slice(bounds.start, bounds.end + 1).join('\n') : null;
}

function detectionRegion(lines) {
  const bounds = outputBlockBounds(lines);
  return lines.slice(bounds ? bounds.start : 0).filter((l) => !PROMPT_LINE.test(l));
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

function limitedIn(lines, customPatterns) {
  const custom = compile(customPatterns);
  if (custom.length > 0 && custom.some((p) => p.test(lines.join('\n')))) return true;
  for (let i = 0; i < lines.length; i++) {
    if (USAGE_WARNING.test(lines[i]) || NOT_A_STOP.test(lines[i])) continue;
    if (isTableRow(lines[i])) continue;
    if (LIMIT_PATTERNS.some((p) => p.test(lines[i])) && hasNearbyMatch(lines, i, RESET_PATTERNS)) return true;
  }
  return false;
}

export function isRateLimited(text, customPatterns = []) {
  return limitedIn(detectionRegion(toLines(text)), customPatterns);
}

export function limitInLatestBlock(text, customPatterns = []) {
  const lines = toLines(text);
  const bounds = outputBlockBounds(lines);
  return bounds != null && limitedIn(lines.slice(bounds.start, bounds.end + 1), customPatterns);
}

export function classifyLimit(text, customPatterns = [], customTransientPatterns = []) {
  const region = detectionRegion(toLines(text));
  if (limitedIn(region, customPatterns)) return 'reset';
  const blob = region.filter((l) => !isTableRow(l) && !NOT_A_STOP.test(l)).join('\n');
  const transient = TRANSIENT_PATTERNS.concat(compile(customTransientPatterns));
  return transient.some((p) => p.test(blob)) ? 'transient' : null;
}

export function findRateLimitMessage(text) {
  const lines = detectionRegion(toLines(text));

  let limitIdx = -1;
  let lastTransient = -1;
  const resets = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (isTableRow(ln)) continue;
    if (RESET_PATTERNS.some((p) => p.test(ln))) resets.push(i);
    if (TRANSIENT_PATTERNS.some((p) => p.test(ln))) lastTransient = i;
    if (!USAGE_WARNING.test(ln) && !NOT_A_STOP.test(ln) && LIMIT_PATTERNS.some((p) => p.test(ln))) limitIdx = i;
  }

  if (limitIdx >= 0) {
    let best = -1;
    for (const j of resets) {
      if (Math.abs(j - limitIdx) > WINDOW) continue;
      if (best === -1 || Math.abs(j - limitIdx) < Math.abs(best - limitIdx)) best = j;
    }
    if (best >= 0) return lines[best].trim();
  }
  if (resets.length > 0) return lines[resets[resets.length - 1]].trim();
  if (limitIdx >= 0) return lines[limitIdx].trim();
  if (lastTransient >= 0) return lines[lastTransient].trim();
  return null;
}
