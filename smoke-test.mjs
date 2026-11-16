// Quick API smoke test
const BASE = 'http://localhost:3000';

async function main() {
  // 1. health
  const h = await fetch(`${BASE}/api/health`);
  console.log('health:', h.status, await h.text());

  // 2. analyze (watch URL)
  let r = await fetch(`${BASE}/api/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&pp=abc' })
  });
  const analysis = await r.json();
  console.log('analyze:', r.status, JSON.stringify(analysis).slice(0, 600));

  if (!analysis.error) {
    // 3. transcript for first track
    const t0 = analysis.captions.tracks[0];
    r = await fetch(`${BASE}/api/transcript`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId: analysis.video.videoId, languageCode: t0.languageCode, kind: t0.kind })
    });
    const tr = await r.json();
    console.log('transcript:', r.status, tr.error ? JSON.stringify(tr.error) : `segments=${tr.segments.length} words=${tr.stats.words} first="${tr.segments[0].text}"`);

    // 4. translation (if supported)
    if (analysis.captions.translationLanguages.length) {
      const r2 = await fetch(`${BASE}/api/transcript`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId: analysis.video.videoId, languageCode: t0.languageCode, kind: t0.kind, translateTo: 'es' })
      });
      const tr2 = await r2.json();
      console.log('translate->es:', r2.status, tr2.error ? JSON.stringify(tr2.error) : `first="${tr2.segments[0].text}"`);
    }
  }

  // 5. thumbnails
  r = await fetch(`${BASE}/api/thumbnails?videoId=dQw4w9WgXcQ`);
  const thumbs = await r.json();
  console.log('thumbnails:', r.status, thumbs.items ? thumbs.items.map((i) => i.quality).join(',') : JSON.stringify(thumbs));

  // 6. thumbnail proxy download
  r = await fetch(`${BASE}/api/thumbnail?videoId=dQw4w9WgXcQ&quality=hqdefault&download=1`);
  const cd = r.headers.get('content-disposition');
  console.log('thumbnail proxy:', r.status, r.headers.get('content-type'), cd);

  // 7. error cases
  r = await fetch(`${BASE}/api/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'not a url' }) });
  console.log('bad url:', r.status, (await r.json()).error.message);

  r = await fetch(`${BASE}/api/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=AAAAAAAAAAA' }) });
  console.log('missing video:', r.status, (await r.json()).error.message);

  // 8. shorts URL
  r = await fetch(`${BASE}/api/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://www.youtube.com/shorts/9bZkp7q19f0' }) });
  const shorts = await r.json();
  console.log('shorts:', r.status, shorts.error ? JSON.stringify(shorts.error) : shorts.video.title);
}

main().catch((e) => {
  console.error('TEST FAILED:', e);
  process.exit(1);
});
