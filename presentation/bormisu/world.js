// World map slide: start zoomed in on Offenburg, zoom out to the world,
// light up every country with a Herrenknecht project, then drop one dot per machine.
// Data: window.WORLD (world-atlas 110m) and window.HK_PROJECTS (data/projects.js).
(function () {
  const W = 1920, H = 1080;
  const OFFENBURG = [7.94, 48.47];
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let token = 0;

  function build(svgEl) {
    const svg = d3.select(svgEl);
    const land = topojson.feature(WORLD, WORLD.objects.countries);
    land.features = land.features.filter((f) => f.id !== '010'); // no Antarctica
    const projection = d3.geoNaturalEarth1().fitExtent([[40, 60], [W - 40, H - 40]], land);
    const path = d3.geoPath(projection);
    const projects = HK_PROJECTS.projects;
    const hkIds = new Set(projects.map((p) => p.atlas_id).filter(Boolean));

    const zoom = svg.append('g').attr('class', 'zoom');
    zoom.selectAll('path').data(land.features).join('path')
      .attr('class', 'land').attr('d', path)
      .each(function (f) { this.dataset.hk = hkIds.has(f.id) ? '1' : ''; });

    // one dot per machine; several machines on one project sit in a small spiral around it
    const dots = [];
    projects.forEach((p) => {
      const [x, y] = projection([p.lon, p.lat]);
      for (let m = 0; m < p.machines; m++) {
        const a = m * 2.39996, r = m ? 4.6 * Math.sqrt(m) : 0;
        dots.push({ x: x + r * Math.cos(a), y: y + r * Math.sin(a) });
      }
    });
    const dotLayer = svg.append('g').attr('class', 'dots');
    const home = svg.append('g').attr('class', 'homeg');
    home.append('circle').attr('class', 'home').attr('r', 12);
    home.append('text').attr('class', 'home-label').attr('x', 22).attr('y', 8).text('Offenburg');

    const countries = new Set(projects.map((p) => p.country)).size;
    const label = svg.append('g').attr('class', 'counter').attr('transform', `translate(80, ${H - 80})`).style('opacity', 0);
    const num = label.append('text').attr('class', 'count');
    label.append('text').attr('class', 'count-sub').attr('y', 30)
      .text(`machines · ${projects.length} documented projects · ${countries} countries`);

    return { svg, zoom, dotLayer, home, label, num, dots, projection, total: dots.length };
  }

  function frame(m, cx, cy, k) {
    m.zoom.attr('transform', `translate(${W / 2 - cx * k},${H / 2 - cy * k}) scale(${k})`);
    const [hx, hy] = m.projection(OFFENBURG);
    m.home.attr('transform', `translate(${W / 2 + (hx - cx) * k},${H / 2 + (hy - cy) * k})`);
  }

  function finalState(m) {
    frame(m, W / 2, H / 2, 1);
    m.zoom.selectAll('.land').classed('hk', function () { return this.dataset.hk === '1'; });
    m.dotLayer.selectAll('circle').data(m.dots).join('circle').attr('class', 'dot')
      .attr('cx', (d) => d.x).attr('cy', (d) => d.y).attr('r', 4);
    m.num.text(m.total.toLocaleString('en-US'));
    m.label.style('opacity', 1);
    m.home.select('text').style('opacity', 0);
    m.home.select('circle').attr('r', 7);
  }

  window.playWorld = function (svgEl) {
    const m = svgEl.__world || (svgEl.__world = build(svgEl));
    const my = ++token;
    if (reduced) return finalState(m);

    // reset
    m.zoom.selectAll('.land').classed('hk', false);
    m.dotLayer.selectAll('*').remove();
    m.label.style('opacity', 0);
    m.home.select('text').style('opacity', 1);
    m.home.select('circle').interrupt().attr('r', 12);

    const [ox, oy] = m.projection(OFFENBURG);
    const zi = d3.interpolateZoom([ox, oy, W / 70], [W / 2, H / 2, W]);
    const dur = 2600, hold = 700, t0 = performance.now();
    frame(m, ox, oy, 70);

    const tick = (t) => {
      if (my !== token) return;
      const e = Math.min(1, Math.max(0, (t - t0 - hold) / dur));
      const [cx, cy, w] = zi(d3.easeCubicInOut(e));
      frame(m, cx, cy, W / w);
      m.home.select('text').style('opacity', 1 - Math.min(1, e * 4));
      if (e < 1) return requestAnimationFrame(tick);
      afterZoom(m, my);
    };
    requestAnimationFrame(tick);
  };

  function afterZoom(m, my) {
    // countries light up in a quick wave from west to east
    m.zoom.selectAll('.land').filter(function () { return this.dataset.hk === '1'; })
      .each(function (_, i, all) {
        const el = this;
        setTimeout(() => { if (my === token) d3.select(el).classed('hk', true); }, 40 + (i / all.length) * 500);
      });
    // dots pop in, then the counter runs
    const n = m.dots.length, spread = 1600;
    m.dotLayer.selectAll('circle').data(m.dots).join('circle').attr('class', 'dot')
      .attr('cx', (d) => d.x).attr('cy', (d) => d.y).attr('r', 0)
      .transition().delay((_, i) => 500 + (i / n) * spread).duration(350).ease(d3.easeBackOut).attr('r', 4);
    m.home.select('circle').transition().duration(400).attr('r', 7);
    m.label.transition().delay(500).duration(400).style('opacity', 1);
    m.num.transition().delay(500).duration(spread + 350)
      .tween('text', function () {
        const f = d3.interpolateRound(0, m.total);
        return (t) => { this.textContent = f(t).toLocaleString('en-US'); };
      });
  }
})();
