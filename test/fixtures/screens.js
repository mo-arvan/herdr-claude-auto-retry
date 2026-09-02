// A real rate-limited pane: the error is the newest output; everything below is chrome.
export function limitScreen(counter) {
  return [
    '⏺ Bash(git push origin main)',
    '  ⎿  main -> main',
    '',
    "⏺ You've hit your session limit · resets 8:50pm (Asia/Omsk)",
    '',
    `✻ Cooking… (${counter}m 14s · ↓ 8.1k tokens)`,
    '─────────────────────────────────────────',
    '❯',
    '─────────────────────────────────────────',
    `  proj git:(main) | Opus 5 (1M context) | ctx: ${counter}%`,
    `  5h: 30% (resets in ${counter}m) | 7d: 29% (resets in 5d8h)`,
    '  -- INSERT -- ⏵⏵ bypass permissions on (shift+tab to cycle)',
  ].join('\n');
}
