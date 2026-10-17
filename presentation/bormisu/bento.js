// Key features slide: step n grows key tile n to 3×2 and hides the tiles marked data-out;
// every other tile slides to its new place (FLIP), so the big tile seems to push them aside.
(function () {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  window.bentoStep = function (grid, step) {
    const tiles = [...grid.children];
    const before = new Map(tiles.map((t) => [t, t.getBoundingClientRect()]));
    tiles.forEach((t) => {
      if (t.dataset.key) t.classList.toggle('big', +t.dataset.key === step);
      if ('out' in t.dataset) t.classList.toggle('out', step > 0);
    });
    if (reduced) return;
    // the deck scales its 1920×1080 canvas; FLIP offsets must be in canvas pixels
    const scale = grid.getBoundingClientRect().width / grid.offsetWidth || 1;
    tiles.forEach((t) => {
      if (t.classList.contains('out')) return;
      const a = before.get(t), b = t.getBoundingClientRect();
      const fresh = !a.width;                                  // was hidden: fade in at its new place
      if (fresh) return t.animate([{ opacity: 0, transform: 'scale(.8)' }, { opacity: 1, transform: 'none' }], { duration: 450, easing: 'cubic-bezier(.22,1,.36,1)' });
      const dx = (a.left - b.left) / scale, dy = (a.top - b.top) / scale;
      const sx = a.width / b.width, sy = a.height / b.height;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) return;
      t.style.transformOrigin = '0 0';
      t.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` }, { transform: 'none' }],
        { duration: 550, easing: 'cubic-bezier(.22,1,.36,1)' });
    });
  };
})();
