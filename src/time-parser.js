
const RESET_TIME_REGEX = /resets?\s+(?:at\s+)?(?:((?:mon|tue|wed|thu|fri|sat|sun))[a-z]*,?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?/i;
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const RELATIVE_TIME_REGEX = /(?:try again|wait|resets?\s+in)[:\s]\s*(?:for\s+)?(?:in\s+)?(\d+)\s*(hours?|minutes?|mins?|h|m)\b/i;

export function parseResetTime(text) {
  const absMatch = text.match(RESET_TIME_REGEX);
  if (absMatch) {
    const weekday = absMatch[1] ? WEEKDAYS.indexOf(absMatch[1].toLowerCase()) : null;
    let hour = parseInt(absMatch[2], 10);
    const minute = absMatch[3] ? parseInt(absMatch[3], 10) : 0;
    const ampm = absMatch[4]?.toLowerCase() || null;
    const timezone = absMatch[5] || null;

    if (ampm === 'pm' && hour !== 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;

    const ambiguous = !ampm && hour >= 1 && hour <= 12;
    return { hour, minute, timezone, ambiguous, weekday };
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

function weekdayIn(tz, date) {
  return WEEKDAYS.indexOf(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(date).toLowerCase());
}

function nextOccurrence(h, mi, tz, now, weekday = null) {
  for (let d = 0; d <= 7; d++) {
    const day = new Date(now.getTime() + d * 86_400_000);
    if (weekday != null && weekdayIn(tz, day) !== weekday) continue;
    const parts = dateParts(tz, day);
    const t = zonedWallToUtc(parts.y, parts.mo, parts.d, h, mi, tz);
    if (t > now.getTime()) return t;
  }
  return now.getTime();
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
    const t1 = nextOccurrence(parsed.hour, parsed.minute, tz, now, parsed.weekday);
    const t2 = nextOccurrence((parsed.hour + 12) % 24, parsed.minute, tz, now, parsed.weekday);
    target = Math.min(t1, t2);
  } else {
    target = nextOccurrence(parsed.hour, parsed.minute, tz, now, parsed.weekday);
  }

  const diff = Math.max(0, target - now.getTime());
  return diff + marginSeconds * 1000;
}
