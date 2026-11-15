  // Subtitle parser (WebVTT / SRT / ASS / Bilibili JSON)
export function parseSubtitleText(content) {
    const list = [];
    if (!content) return list;
    const clean = content.replace(/\r/g, '').trim();
    const map = clean.match(/X-TIMESTAMP-MAP\s*=\s*LOCAL:([^,\s]+)\s*,\s*MPEGTS:(\d+)/i);
    const mapOffset = map ? Number(map[2]) / 90000 - parseTimestamp(map[1]) : 0;
    const finish = () => list
      .map((cue) => ({ ...cue, start: cue.start + mapOffset, end: cue.end + mapOffset }))
      .filter((cue) => Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.end >= cue.start)
      .sort((a, b) => a.start - b.start || a.end - b.end);

    // Check if Bilibili JSON format
    if (clean.startsWith('{')) {
      try {
        const json = JSON.parse(clean);
        if (Array.isArray(json.body)) {
          for (const item of json.body) {
            const start = parseFloat(item.from || 0);
            const end = parseFloat(item.to || 0);
            const text = (item.content || '').trim();
            if (text && !isNaN(start) && !isNaN(end)) {
              list.push({ start, end, text });
            }
          }
          if (list.length > 0) return finish();
        }
      } catch {}
    }

    // Check if ASS / SSA format (Bstation format)
    if (clean.includes('[Events]') || clean.includes('Dialogue:')) {
      const lines = clean.split('\n');
      for (const line of lines) {
        if (line.startsWith('Dialogue:')) {
          const parts = line.substring(9).split(',');
          if (parts.length >= 9) {
            const start = parseTimestamp(parts[1].trim());
            const end = parseTimestamp(parts[2].trim());
            const text = parts.slice(9).join(',').replace(/\{[^}]+\}/g, '').replace(/\\N/g, '\n').trim();
            if (text && !isNaN(start) && !isNaN(end)) {
              list.push({ start, end, text });
            }
          }
        }
      }
      if (list.length > 0) return finish();
    }

    // Standard WebVTT / SRT parser
    const blocks = clean.split(/\n\n+/);

    for (const b of blocks) {
      const lines = b.trim().split('\n');
      if (lines.length < 2) continue;

      let timeLineIdx = lines.findIndex(l => l.includes('-->'));
      if (timeLineIdx === -1) continue;

      const [startStr, endStr] = lines[timeLineIdx].split('-->');
      if (!startStr || !endStr) continue;

      const start = parseTimestamp(startStr.trim());
      const end = parseTimestamp(endStr.trim().split(' ')[0]);

      const text = lines
        .slice(timeLineIdx + 1)
        .join('\n')
        .replace(/<[^>]+>/g, '')
        .trim();

      if (text && !isNaN(start) && !isNaN(end)) {
        list.push({ start, end, text });
      }
    }
    return finish();
  }

// Positive delay intentionally shows a cue later. playbackTime is always the
// absolute movie timeline, including a fragmented-transcode seek offset.
export function subtitleTextAt(cues, playbackTime, delaySeconds = 0) {
  if (!Array.isArray(cues) || !Number.isFinite(playbackTime)) return '';
  const cueTime = playbackTime - (Number.isFinite(delaySeconds) ? delaySeconds : 0);
  let low = 0;
  let high = cues.length - 1;
  let candidate = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (cues[mid].start <= cueTime) { candidate = mid; low = mid + 1; }
    else high = mid - 1;
  }
  // A few subtitle files contain overlapping cues; prefer the newest active one.
  for (let index = candidate; index >= 0 && cues[index].start <= cueTime; index--) {
    if (cueTime <= cues[index].end) return cues[index].text || '';
    if (candidate - index > 8) break;
  }
  return '';
}

  function parseTimestamp(t) {
    const parts = t.replace(',', '.').split(':');
    if (parts.length === 3) {
      return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
    } else if (parts.length === 2) {
      return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
    }
    return 0;
  }

