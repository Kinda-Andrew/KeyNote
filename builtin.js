const BUILTIN_SONGS = [
  // No "map": the game generates the usual seeded beatmap, which is the same every time.
  { title: 'Hotline Bling', bpm: 136, src: 'songs/HotLine Bling - Drake.mp3' },

  // With a fixed "map" (see step 4 for how to get this)
  { title: 'Slow Burn', bpm: 90, src: 'songs/slow-burn.mp3',
    map: { src: 'osu', notes: [ /* pasted notes go here */ ] } },
];