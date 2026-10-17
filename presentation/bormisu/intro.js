// Profile slide intro: the globe turns, a wedge opens to show the Earth's layers,
// the camera dives into the crust onto a construction site, a rig drills a core,
// and the core grows into a drawn, explained borehole profile.
// Uses d3 + window.WORLD (already loaded for the world map slide).
(function () {
  const W = 1920, H = 1080, R = 380, CX = W / 2, CY = H / 2;
  const SURFACE = 430;                       // ground line of the site scene
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  // BK-01, top to bottom: [word, colour, texture, thickness in m]
  const LAYERS = [['Topsoil', '#A66B3E', 'in-tx-soil', 0.4], ['Rubble', '#E9E1D3', 'in-tx-rubble', 0.8],
                  ['Clay', '#6A4F80', 'in-tx-clay', 2.3], ['Gravel', '#D9A800', 'in-tx-gravel', 3.2],
                  ['Sandstone', '#C9502E', 'in-tx-sand', 3.3]];
  const DEPTH = 10, WATER = 4.6;             // final depth and groundwater, in m
  const GROUND_PX = 650;                     // how deep the site scene's layers go on screen
  let token = 0;

  const ease = d3.easeCubicInOut;
  const seg = (t, a, b) => Math.max(0, Math.min(1, (t - a) / (b - a)));   // 0..1 progress of t inside [a, b]
  const FONT = '-apple-system, "SF Pro Display", system-ui, sans-serif';

  function textures(defs) {
    const pat = (id, w, h, draw) => draw(defs.append('pattern').attr('id', id).attr('width', w).attr('height', h).attr('patternUnits', 'userSpaceOnUse'));
    pat('in-tx-soil', 18, 10, (p) => p.append('path').attr('d', 'M2 8 q3 -6 6 0 M10 8 q3 -6 6 0').attr('stroke', 'rgba(255,255,255,.35)').attr('fill', 'none'));
    pat('in-tx-rubble', 26, 20, (p) => { p.append('path').attr('d', 'M3 6 l5 -3 l4 4 l-5 3z M15 14 l6 -2 l2 5 l-6 1z').attr('fill', 'rgba(59,36,24,.28)'); });
    pat('in-tx-clay', 30, 12, (p) => p.append('path').attr('d', 'M2 4 h12 M17 9 h11').attr('stroke', 'rgba(255,255,255,.35)').attr('stroke-width', 1.6));
    pat('in-tx-gravel', 26, 22, (p) => { [[6, 6, 4], [18, 8, 3], [10, 16, 3.5], [21, 18, 2.5]].forEach(([x, y, r]) =>
      p.append('circle').attr('cx', x).attr('cy', y).attr('r', r).attr('fill', 'none').attr('stroke', 'rgba(59,36,24,.45)').attr('stroke-width', 1.4)); });
    pat('in-tx-sand', 12, 12, (p) => { p.append('circle').attr('cx', 3).attr('cy', 3).attr('r', 1.4).attr('fill', 'rgba(59,36,24,.45)');
                                       p.append('circle').attr('cx', 9).attr('cy', 9).attr('r', 1.4).attr('fill', 'rgba(59,36,24,.45)'); });
  }

  function build(svgEl) {
    const svg = d3.select(svgEl);
    const defs = svg.append('defs');
    textures(defs);
    const sky = defs.append('linearGradient').attr('id', 'in-sky').attr('x1', 0).attr('y1', 0).attr('x2', 0).attr('y2', 1);
    sky.append('stop').attr('offset', 0).attr('stop-color', '#CFE3EC');
    sky.append('stop').attr('offset', 1).attr('stop-color', '#FBF6EF');
    const auger = defs.append('pattern').attr('id', 'in-auger').attr('width', 20).attr('height', 16).attr('patternUnits', 'userSpaceOnUse');
    auger.append('rect').attr('width', 20).attr('height', 16).attr('fill', '#7A7A7A');
    auger.append('path').attr('d', 'M0 12 L20 4').attr('stroke', '#3B3B3B').attr('stroke-width', 3);
    defs.append('filter').attr('id', 'in-shadow').attr('x', '-30%').attr('y', '-10%').attr('width', '160%').attr('height', '120%')
      .append('feDropShadow').attr('dx', 0).attr('dy', 18).attr('stdDeviation', 22).attr('flood-color', '#3B2418').attr('flood-opacity', 0.22);
    const clip = defs.append('clipPath').attr('id', 'in-wedge').append('path').attr('clip-rule', 'evenodd');

    // ---- the Earth ------------------------------------------------------------------------
    const earth = svg.append('g').attr('class', 'in-earth');
    [[1, '#8B5A3C'], [0.965, '#C8643B'], [0.55, '#E39B3B'], [0.28, '#F5D27A']].forEach(([k, c]) =>
      earth.append('circle').attr('cx', CX).attr('cy', CY).attr('r', R * k).attr('fill', c));
    const proj = d3.geoOrthographic().scale(R).translate([CX, CY]).rotate([-8, -38]).clipAngle(90);
    const path = d3.geoPath(proj);
    const land = topojson.feature(WORLD, WORLD.objects.countries);
    const globe = earth.append('g').attr('clip-path', 'url(#in-wedge)');
    const sphere = globe.append('path').datum({ type: 'Sphere' }).attr('fill', '#9FC3D3');
    const grat = globe.append('path').datum(d3.geoGraticule10()).attr('fill', 'none').attr('stroke', 'rgba(255,255,255,0.35)').attr('stroke-width', 0.8);
    const lands = globe.append('path').datum(land).attr('fill', '#7DB713').attr('stroke', '#5E8E0E').attr('stroke-width', 0.5);
    earth.append('circle').attr('cx', CX).attr('cy', CY).attr('r', R).attr('fill', 'none').attr('stroke', 'rgba(42,29,22,0.35)').attr('stroke-width', 2);

    // ---- the construction site ------------------------------------------------------------
    const site = svg.append('g').attr('class', 'in-site').style('opacity', 0);
    site.append('rect').attr('width', W).attr('height', SURFACE).attr('fill', 'url(#in-sky)');
    const px = GROUND_PX / DEPTH;
    let y = SURFACE;
    LAYERS.forEach(([, c, tx, m]) => {
      const h = m * px;
      site.append('rect').attr('y', y).attr('width', W).attr('height', h + 1).attr('fill', c);
      site.append('rect').attr('y', y).attr('width', W).attr('height', h + 1).attr('fill', `url(#${tx})`);
      y += h;
    });
    site.append('rect').attr('y', y).attr('width', W).attr('height', H - y).attr('fill', '#B4462A');
    site.append('rect').attr('y', SURFACE - 8).attr('width', W).attr('height', 10).attr('fill', '#7DB713');
    for (let x = 120; x < 760; x += 46) site.append('rect').attr('x', x).attr('y', SURFACE - 70).attr('width', 6).attr('height', 64).attr('fill', '#9A9A9A');
    site.append('rect').attr('x', 116).attr('y', SURFACE - 66).attr('width', 650).attr('height', 4).attr('fill', '#9A9A9A');
    site.append('rect').attr('x', 116).attr('y', SURFACE - 30).attr('width', 650).attr('height', 4).attr('fill', '#9A9A9A');
    site.append('rect').attr('x', 1380).attr('y', SURFACE - 120).attr('width', 260).attr('height', 112).attr('rx', 6).attr('fill', '#E6BE78');
    site.append('rect').attr('x', 1410).attr('y', SURFACE - 92).attr('width', 60).attr('height', 40).attr('fill', '#FFF8EC');
    site.append('rect').attr('x', 1500).attr('y', SURFACE - 92).attr('width', 60).attr('height', 40).attr('fill', '#FFF8EC');
    [1220, 1290, 650].forEach((x) => site.append('path').attr('d', `M${x} ${SURFACE - 6} l14 -40 l14 40 z`).attr('fill', '#E5643B'));
    const RX = 960;
    site.append('rect').attr('x', RX - 120).attr('y', SURFACE - 34).attr('width', 240).attr('height', 28).attr('rx', 14).attr('fill', '#2A1D16');
    site.append('rect').attr('x', RX - 105).attr('y', SURFACE - 92).attr('width', 210).attr('height', 60).attr('rx', 6).attr('fill', '#8B5A3C');
    site.append('rect').attr('x', RX + 30).attr('y', SURFACE - 140).attr('width', 70).attr('height', 52).attr('rx', 6).attr('fill', '#8B5A3C');
    site.append('rect').attr('x', RX + 42).attr('y', SURFACE - 130).attr('width', 46).attr('height', 26).attr('fill', '#CFE3EC');
    site.append('rect').attr('x', RX - 24).attr('y', 70).attr('width', 20).attr('height', SURFACE - 160).attr('fill', '#3B2418');
    site.append('rect').attr('x', RX - 34).attr('y', 70).attr('width', 40).attr('height', 26).attr('fill', '#3B2418');
    const rod = site.append('rect').attr('x', RX - 12).attr('y', 96).attr('width', 24).attr('fill', 'url(#in-auger)');
    const head = site.append('rect').attr('x', RX - 20).attr('width', 40).attr('height', 18).attr('rx', 4).attr('fill', '#3B3B3B');
    const bottom = SURFACE + GROUND_PX;        // the rod reaches the final depth

    // ---- the core, which grows into the explained profile ---------------------------------
    // drawn once at its final size; while it is still the core it is scaled down onto the hole
    const COL = { x: 700, y: 150, w: 200, h: 780 };
    const prof = svg.append('g').attr('class', 'in-profile').style('opacity', 0);
    const col = prof.append('g').attr('filter', 'url(#in-shadow)');
    const cpx = COL.h / DEPTH;
    let cy = COL.y;
    const mids = [];
    LAYERS.forEach(([word, c, tx, m]) => {
      const h = m * cpx;
      col.append('rect').attr('x', COL.x).attr('y', cy).attr('width', COL.w).attr('height', h).attr('fill', c);
      col.append('rect').attr('x', COL.x).attr('y', cy).attr('width', COL.w).attr('height', h).attr('fill', `url(#${tx})`);
      mids.push({ word, mid: cy + h / 2, bottom: cy + h });
      cy += h;
    });
    col.append('rect').attr('x', COL.x).attr('y', COL.y).attr('width', COL.w).attr('height', COL.h).attr('rx', 2)
      .attr('fill', 'none').attr('stroke', '#2A1D16').attr('stroke-width', 2);
    // everything around the column fades in after it has grown
    const notes = svg.append('g').attr('class', 'in-notes').style('opacity', 0);
    // depth scale on the left
    for (let d = 0; d <= DEPTH; d += 2) {
      const yy = COL.y + d * cpx;
      notes.append('line').attr('x1', COL.x - 34).attr('x2', COL.x - 14).attr('y1', yy).attr('y2', yy).attr('stroke', '#8B7B6E').attr('stroke-width', 2);
      notes.append('text').attr('x', COL.x - 44).attr('y', yy + 9).attr('text-anchor', 'end').attr('font', '').style('font', `600 26px ${FONT}`).attr('fill', '#8B7B6E').text(`${d} m`);
    }
    // groundwater
    const wy = COL.y + WATER * cpx;
    notes.append('line').attr('x1', COL.x - 10).attr('x2', COL.x + COL.w + 10).attr('y1', wy).attr('y2', wy)
      .attr('stroke', '#2F7FBF').attr('stroke-width', 3).attr('stroke-dasharray', '10 7');
    notes.append('path').attr('d', `M${COL.x - 32} ${wy - 26} h24 l-12 18z`).attr('fill', '#2F7FBF');
    // big words on the right, pushed apart where layers are thin
    const LX = COL.x + COL.w + 110;
    let prev = -Infinity;
    mids.forEach(({ word, mid, bottom: b }) => {
      notes.append('line').attr('x1', COL.x + COL.w).attr('x2', COL.x + COL.w + 46).attr('y1', b).attr('y2', b).attr('stroke', '#2A1D16').attr('stroke-width', 1.5);
      const ly = Math.max(mid, prev + 62); prev = ly;
      notes.append('path').attr('d', `M${COL.x + COL.w + 8} ${mid} C${LX - 50} ${mid} ${LX - 60} ${ly} ${LX - 16} ${ly}`)
        .attr('fill', 'none').attr('stroke', '#C7B49C').attr('stroke-width', 2);
      notes.append('circle').attr('cx', COL.x + COL.w + 8).attr('cy', mid).attr('r', 5).attr('fill', '#2A1D16');
      notes.append('text').attr('x', LX).attr('y', ly + 18).style('font', `700 54px ${FONT}`).attr('fill', '#2A1D16').text(word);
    });

    // the core's box on the site: under the rod, from the surface to the bottom of the hole
    const coreBox = { x: RX - 10, y: SURFACE, w: 20, h: GROUND_PX };
    return { svg, earth, clip, proj, sphere, grat, lands, path, site, rod, head, bottom, auger, prof, notes, COL, coreBox };
  }

  function wedge(m, deg) {
    // full disc minus a sector from 12 o'clock clockwise by `deg`
    const disc = `M${CX - R - 2} ${CY} a${R + 2} ${R + 2} 0 1 0 ${2 * R + 4} 0 a${R + 2} ${R + 2} 0 1 0 ${-2 * R - 4} 0z`;
    if (deg <= 0) return m.clip.attr('d', disc);
    const a0 = -Math.PI / 2, a1 = a0 + deg * Math.PI / 180, r = R + 4;
    const sector = `M${CX} ${CY} L${CX + r * Math.cos(a0)} ${CY + r * Math.sin(a0)} A${r} ${r} 0 ${deg > 180 ? 1 : 0} 1 ${CX + r * Math.cos(a1)} ${CY + r * Math.sin(a1)}z`;
    m.clip.attr('d', disc + sector);
  }

  // transform that maps the profile column onto box b, mixed by k (0 = on b, 1 = at its own place)
  function grow(m, b, k) {
    const sx = b.w / m.COL.w, sy = b.h / m.COL.h;
    const s1 = sx + (1 - sx) * k, s2 = sy + (1 - sy) * k;
    const tx = (b.x - m.COL.x * sx) * (1 - k), ty = (b.y - m.COL.y * sy) * (1 - k);
    return `translate(${tx},${ty}) scale(${s1},${s2})`;
  }

  const END = 10400;
  function frame(m, t) {
    // 0–2.6 s the globe turns; 1.2–2.6 s the wedge opens
    m.proj.rotate([-8 - 40 * seg(t, 0, 2600), -38]);
    m.sphere.attr('d', m.path); m.grat.attr('d', m.path); m.lands.attr('d', m.path);
    wedge(m, 100 * ease(seg(t, 1200, 2600)));
    // 2.6–4.0 s dive into the crust at the top of the cut; the site fades in over the dive
    const z = ease(seg(t, 2600, 3900)), k = 1 + 140 * z * z * z;
    // aim inside the brown crust ring, in the middle of the open wedge, so the screen fills with crust
    const za = (-90 + 50) * Math.PI / 180, zr = R * 0.982;
    const zx = CX + zr * Math.cos(za), zy = CY + zr * Math.sin(za);
    m.earth.attr('transform', `translate(${CX},${CY + (SURFACE + 200 - CY) * z}) scale(${k}) translate(${-zx},${-zy})`)
      .style('opacity', 1 - seg(t, 3500, 3950));
    // 4.2–6.4 s drill down; 6.4–7.4 s the rod comes back up
    const down = ease(seg(t, 4200, 6400)), up = ease(seg(t, 6400, 7400));
    const tip = SURFACE + (m.bottom - SURFACE) * down * (1 - up);
    m.rod.attr('height', Math.max(0, tip - 96));
    m.head.attr('y', Math.max(96, tip - 18));
    m.auger.attr('patternTransform', `translate(0, ${(t / 30) % 16})`);    // the auger turns
    // 7.0 s the core shows in the hole; 7.6–9.0 s it lifts out and grows into the profile
    const g = ease(seg(t, 7600, 9000));
    m.site.style('opacity', seg(t, 3500, 3950) * (1 - seg(t, 7800, 8600)));
    m.prof.style('opacity', seg(t, 6800, 7200)).attr('transform', grow(m, m.coreBox, g));
    m.notes.style('opacity', seg(t, 9000, 9800));
  }

  window.playIntro = function (svgEl) {
    const m = svgEl.__intro || (svgEl.__intro = build(svgEl));
    const my = ++token;
    if (reduced) return frame(m, END);
    const t0 = performance.now();
    const tick = (now) => {
      if (my !== token) return;
      const t = Math.min(now - t0, END);
      frame(m, t);
      if (t < END) requestAnimationFrame(tick);
    };
    frame(m, 0);
    requestAnimationFrame(tick);
  };
})();
