
const RESET_TIME_REGEX = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?/i;
const RELATIVE_TIME_REGEX = /(?:try again|wait|resets?\s+in)[:\s]\s*(?:for\s+)?(?:in\s+)?(\d+)\s*(hours?|minutes?|mins?|h|m)\b/i;

export function parseResetTime(text) {
  const absMatch = text.match(RESET_TIME_REGEX);
  if (absMatch) {
    let hour = parseInt(absMatch[1], 10);
    const minute = absMatch[2] ? parseInt(absMatch[2], 10) : 0;
    const ampm = absMatch[3]?.toLowerCase() || null;
    const timezone = absMatch[4] || null;

    if (ampm === 'pm' && hour !== 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;

    const ambiguous = !ampm && hour >= 1 && hour <= 12;
    return { hour, minute, timezone, ambiguous };
  }

  const relMatch = text.match(RELATIVE_TIME_REGEX);
  if (relMatch) {
    const amount = parseInt(relMatch[1], 10);
    const unit = relMatch[2].toLowerCase();
    const isMinutes = unit.startsWith('m');
    const ms = amount * (isMinutes ? 60_000 : 3_600_000);
    return { relative: true, waitMs: ms };
  }

  return null;
}

function tzOffsetMs(tz, date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parseInt(parts.find((p) => p.type === type).value, 10);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return asUtc - date.getTime();
}

function zonedWallToUtc(y, mo, d, h, mi, tz) {
  const naive = Date.UTC(y, mo - 1, d, h, mi, 0);
  const off1 = tzOffsetMs(tz, new Date(naive));
  let utc = naive - off1;
  const off2 = tzOffsetMs(tz, new Date(utc));
  if (off2 !== off1) utc = naive - off2;
  return utc;
}

function dateParts(tz, date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parseInt(parts.find((p) => p.type === type).value, 10);
  return { y: get('year'), mo: get('month'), d: get('day') };
}

function nextOccurrence(h, mi, tz, now) {
  const today = dateParts(tz, now);
  let t = zonedWallToUtc(today.y, today.mo, today.d, h, mi, tz);
  if (t > now.getTime()) return t;
  const tomorrow = dateParts(tz, new Date(now.getTime() + 86_400_000));
  return zonedWallToUtc(tomorrow.y, tomorrow.mo, tomorrow.d, h, mi, tz);
}

export function calculateWaitMs(parsed, marginSeconds = 60, fallbackHours = 5, now = new Date()) {
  if (!parsed) return (fallbackHours * 3600 + marginSeconds) * 1000;

  if (parsed.relative) {
    return parsed.waitMs + marginSeconds * 1000;
  }

  let tz;
  try {
    tz = parsed.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    return (fallbackHours * 3600 + marginSeconds) * 1000;
  }

  let target;
  if (parsed.ambiguous) {
    const t1 = nextOccurrence(parsed.hour, parsed.minute, tz, now);
    const t2 = nextOccurrence((parsed.hour + 12) % 24, parsed.minute, tz, now);
    target = Math.min(t1, t2);
  } else {
    target = nextOccurrence(parsed.hour, parsed.minute, tz, now);
  }

  const diff = Math.max(0, target - now.getTime());
  return diff + marginSeconds * 1000;
}
