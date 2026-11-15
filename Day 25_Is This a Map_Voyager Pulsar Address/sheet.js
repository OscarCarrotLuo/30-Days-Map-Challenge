(() => {
  'use strict';

  const svgNS = 'http://www.w3.org/2000/svg';
  const $ = id => document.getElementById(id);
  const map = $('map');
  const sheet = document.querySelector('.sheet');
  const notes = document.querySelector('.note-space');
  const {origin, baselineEnd, rays} = ENGRAVING;
  const scaleUnit = (baselineEnd[0] - origin[0]) / 100;
  const featured = rays.find(ray => ray.name === 'B0833−45');
  const hydrogenHz = 1420405752;
  const periodMs = count => count * 1000 / hydrogenHz;
  const binary = featured.count.toString(2);
  const finalGroup = binary.slice(-4);
  const candidates = [
    {id: 'B0531+21', label: 'Crab · B0531+21'},
    {id: 'B0833−45', label: 'Vela · B0833−45'},
    {id: 'B0950+08', label: 'B0950+08'},
  ];
  const labels = {
    'B1642−03': [9,-6,'start'], 'B1929+10': [9,-3,'start'],
    'B1933+16': [3,-11,'middle'], 'B2016+28': [5,-10,'start'],
    'B2217+47': [-7,-9,'end'], 'B0329+54': [-6,-9,'end'],
    'B0525+21': [3,-13,'start'], 'B0531+21': [2,20,'start'],
    'B0823+26': [-4,18,'end'], 'B0950+08': [-5,15,'end'],
    'B1240−64': [5,16,'start'], 'B1451−68': [4,15,'start'],
    'B1727−47': [9,4,'start'],
  };
  const view = {x: 0, y: 0, size: 1000};
  let state = 'read';
  let resolution = 1;
  let labelSize = 12;
  let resizeFrame = 0;
  const workedDigits = [];
  const candidateRows = new Map();

  function svg(tag, attributes = {}, content) {
    const node = document.createElementNS(svgNS, tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    if (content !== undefined) node.textContent = content;
    return node;
  }

  function leader(points, attributes = {}) {
    return svg('path', {d: `M${points.map(point => point.join(',')).join(' ')}`, ...attributes});
  }

  function label(content, x, y, anchor = 'start') {
    return svg('text', {x, y, 'text-anchor': anchor, class: 'map-label'}, content);
  }

  function buildEngraving() {
    $('baseline').append(leader([origin, baselineEnd]), leader([
      [baselineEnd[0], baselineEnd[1] - 3.2], [baselineEnd[0], baselineEnd[1] + 3.2],
    ]));
    for (const ray of rays) {
      const isFeature = ray === featured;
      const group = svg('g', {class: isFeature ? 'ray featured' : 'ray', 'data-pulsar': ray.name});
      group.append(svg('title', {}, isFeature ? 'Detail A, the example ray' : `PSR ${ray.name}`));
      if (isFeature) group.append(svg('path', {class: 'underprint', d: ray.structure + ray.word}));
      group.append(svg('path', {class: 'structure', d: ray.structure}), svg('path', {class: 'word-path', d: ray.word}));
      $('rays').append(group);
    }
    $('return-line').setAttribute('d', `M${featured.tip} L${origin}`);
  }

  function buildReader() {
    const groups = [binary.slice(0, binary.length % 4), ...binary.slice(binary.length % 4).match(/.{4}/g)];
    for (const [index, bits] of groups.entries()) {
      const group = document.createElement('div');
      group.className = 'bit-group';
      for (const bit of bits) {
        const cell = document.createElement('span');
        cell.className = 'bit'; cell.dataset.value = bit;
        const digit = document.createElement('span');
        const isQuestion = index === groups.length - 1;
        digit.textContent = isQuestion ? '·' : bit;
        if (isQuestion) workedDigits.push(digit);
        cell.append(document.createElement('i'), digit);
        group.append(cell);
      }
      $('word').append(group);
    }
    for (const candidate of candidates) {
      const ray = rays.find(r => r.name === candidate.id);
      const row = document.createElement('tr');
      const name = document.createElement('td');
      const period = document.createElement('td');
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = candidate.label;
      const value = periodMs(ray.count).toFixed(4);
      button.setAttribute('aria-label', `Match ${candidate.label}, ${value} milliseconds`);
      period.textContent = value;
      name.append(button); row.append(name, period);
      row.addEventListener('click', () => chooseCandidate(candidate.id));
      $('candidates').append(row); candidateRows.set(candidate.id, row);
    }
    $('calculation').textContent = `${featured.count.toLocaleString('en-US')} cycles × 0.704024 ns ≈ ${periodMs(featured.count).toFixed(4)} ms`;
  }

  function drawAnnotations() {
    const layer = $('annotations');
    layer.replaceChildren();
    const k = labelSize / 13;
    for (const ray of rays) {
      if (ray === featured) continue;
      const [dx, dy, anchor] = labels[ray.name];
      layer.append(label(ray.name, ray.tip[0] + dx*k, ray.tip[1] + dy*k, anchor));
    }
    layer.append(label('Galactic centre', baselineEnd[0] - 3*k, origin[1] - 10*k, 'end'));
    // At a small print scale the names can be wider than the gap between two rays.
    // Stack just the colliding lettering and keep a fine leader to its own endpoint.
    if (labelSize > 14) {
      const texts = Array.from(layer.querySelectorAll('text'));
      const points = [...rays.filter(ray => ray !== featured).map(ray => ray.tip), baselineEnd];
      const entries = texts.map((text, i) => ({text, point: points[i], bounds: text.getBBox()}));
      entries.sort((a, b) => a.bounds.y - b.bounds.y);
      const placed = [];
      const gap = labelSize * .2;
      for (const {text, point, bounds} of entries) {
        const left = Math.min(1000 - bounds.width - gap, Math.max(gap, bounds.x));
        const xShift = left - bounds.x;
        let top = bounds.y;
        for (const other of placed) {
          if (left < other.right + gap && left + bounds.width > other.left - gap &&
              top < other.bottom + gap && top + bounds.height > other.top - gap) top = other.bottom + gap;
        }
        const dy = top - bounds.y;
        if (xShift || dy) text.setAttribute('transform', `translate(${xShift} ${dy})`);
        placed.push({left, right: left + bounds.width, top, bottom: top + bounds.height});
        if (dy > labelSize*.55) {
          const x = Math.max(left + gap, Math.min(left + bounds.width - gap, point[0]));
          layer.insertBefore(leader([point, [x, top - gap*.25]]), layer.firstChild);
        }
      }
    }
    const [ex, ey] = featured.tip;
    const detail = $('detail-target');
    const identified = state === 'found' || state === 'match';
    const detailName = identified ? 'Vela · B0833−45' : 'Detail A';
    const note = label(detailName, 0, 0);
    detail.replaceChildren(note);
    const placeRight = ex - 32*k - note.getComputedTextLength() < labelSize*.5;
    const direction = placeRight ? 1 : -1;
    const end = [ex + direction*28*k, ey + 25*k];
    const points = [[ex + direction*3*k, ey + 3*k], [ex + direction*17*k, end[1]], end];
    note.setAttribute('x', end[0] + direction*4*k);
    note.setAttribute('y', end[1] + 3.6*k);
    note.setAttribute('text-anchor', placeRight ? 'start' : 'end');
    detail.prepend(leader(points, {class: 'detail-leader'}), leader([featured.tip, origin], {class: 'hit'}));
    const centre = $('origin-target');
    const active = state === 'match' || state === 'found';
    centre.setAttribute('aria-hidden', String(!active));
    centre.setAttribute('tabindex', state === 'match' ? '0' : '-1');
    centre.setAttribute('class', `map-action ${state === 'match' ? 'ready' : state === 'found' ? 'found' : ''}`);
    const [cx, cy] = origin;
    centre.replaceChildren(svg('circle', {cx, cy, r: 13*k, class: 'hit-disc'}),
      svg('circle', {cx, cy, r: 6.3*k, class: 'target-ring'}), svg('circle', {cx, cy, r: 1.4*k, class: 'sun-dot'}));
    if (state === 'found') {
      const placed = [[cx + 5*k, cy + 5*k], [cx + 20*k, cy + 24*k], [cx + 39*k, cy + 24*k]];
      centre.append(leader(placed), label('Sun', cx + 43*k, cy + 27*k));
    }
  }

  function renderView() {
    map.setAttribute('viewBox', `${view.x} ${view.y} ${view.size} ${view.size}`);
    map.classList.toggle('zoomed', view.size < 999.9);
    const size = map.getBoundingClientRect().width;
    if (!size) return;
    resolution = view.size / size;
    const letter = parseFloat(getComputedStyle(document.body).fontSize);
    labelSize = letter * resolution;
    map.style.setProperty('--map-letter', `${labelSize}px`);
    const axes = $('axes');
    axes.setAttribute('viewBox', `0 0 ${size} ${size}`);
    axes.replaceChildren();
    const step = view.size > 740 ? 20 : view.size > 330 ? 10 : view.size > 155 ? 5 : 2;
    const grid = [];
    const format = value => value === 0 ? '0' : `${value < 0 ? '−' : '+'}${Math.abs(value)}%`;
    for (let v = -100; v <= 160; v += step) {
      const x = origin[0] + v * scaleUnit, y = origin[1] - v * scaleUnit;
      const sx = (x - view.x) / resolution, sy = (y - view.y) / resolution;
      if (sx > 2 && sx < size - 2) {
        grid.push(`M${x},0v1000`);
        axes.append(svg('line', {x1: sx, y1: size, x2: sx, y2: size + 3}));
        if (sx > letter*1.1 && sx < size - letter*1.1) axes.append(svg('text', {x: sx, y: size + letter*1.34, 'text-anchor': 'middle'}, format(v)));
      }
      if (sy > 2 && sy < size - 2) {
        grid.push(`M0,${y}h1000`);
        axes.append(svg('line', {x1: -3, y1: sy, x2: 0, y2: sy}));
        if (sy > letter*1.2 && sy < size - letter*1.2) axes.append(svg('text', {transform: `translate(${-letter*.68} ${sy}) rotate(-90)`, 'text-anchor': 'middle'}, format(v)));
      }
    }
    $('grid').replaceChildren(svg('path', {d: grid.join('')}));
    drawAnnotations();
  }

  function fitSheet() {
    const css = getComputedStyle(sheet);
    const width = sheet.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
    const height = sheet.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom);
    const horizontal = css.flexDirection === 'row';
    sheet.toggleAttribute('data-foot', !horizontal);
    let side;
    if (horizontal) {
      side = Math.min(height, width - notes.getBoundingClientRect().width - parseFloat(css.columnGap), 1340);
    } else {
      const room = height - parseFloat(css.rowGap);
      const minFoot = Math.min(width, width >= 550 ? 620 : 310);
      let footer = Math.min(width, 1340);
      for (let pass = 0; pass < 4; pass++) {
        notes.style.setProperty('--foot-width', `${footer}px`);
        side = Math.min(width, room - notes.getBoundingClientRect().height, 1340);
        const next = Math.max(minFoot, Math.floor(side));
        if (next >= footer - 1) break;
        footer = next;
      }
    }
    // A very short or highly magnified window may scroll the sheet vertically.
    side = Math.max(Math.min(width, 212), Math.floor(side));
    sheet.style.setProperty('--side', `${side}px`);
    sheet.classList.toggle('over-height', !horizontal && side + notes.offsetHeight + parseFloat(css.rowGap) > height + 2);
    renderView();
  }

  function scheduleFit() {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(fitSheet);
  }

  function home() {
    Object.assign(view, {x: 0, y: 0, size: 1000});
    renderView();
  }

  function announce(message, error = false) {
    $('message').textContent = message;
    $('message').classList.toggle('error', error);
    scheduleFit();
  }

  function updateState(next) {
    state = next;
    const read = state === 'read';
    document.documentElement.dataset.stage = state;
    $('decode').hidden = !read;
    $('calculation').hidden = read;
    $('trace').hidden = state !== 'match';
    $('again').hidden = state !== 'found';
    workedDigits.forEach((span, i) => { span.textContent = read ? '·' : finalGroup[i]; });
    const groups = binary.slice(0,-4).replace(/(\d)(?=(\d{4})+$)/g, '$1 ');
    const last = read ? 'The last four marks run along, across, across and across the ray.' : `The full count is ${featured.count.toLocaleString('en-US')} hydrogen cycles.`;
    $('word').setAttribute('aria-label', `Detail A, read outward. First 23 bits: ${groups}. ${last}`);
    const identified = state === 'match' || state === 'found';
    for (const [id, row] of candidateRows) {
      const selected = identified && id === featured.name;
      row.classList.toggle('selected', selected);
      if (selected) row.setAttribute('aria-current', 'true');
      else row.removeAttribute('aria-current');
    }
    map.classList.toggle('traced', state === 'found');
    drawAnnotations();
    scheduleFit();
  }

  function checkBits(event) {
    event.preventDefault();
    if (state !== 'read') return;
    const input = $('last-bits');
    if (input.value !== finalGroup) {
      input.setAttribute('aria-invalid', 'true');
      const shape = /^[01]{4}$/.test(input.value);
      announce(shape ? 'Try again. The first mark lies along the ray.' : 'Enter four digits using 0 and 1.', true);
      input.focus({preventScroll: true}); input.select();
      return;
    }
    input.removeAttribute('aria-invalid');
    updateState('period');
    announce('Which pulsar has this period? Select its table row.');
    candidateRows.values().next().value.querySelector('button').focus({preventScroll: true});
  }

  function chooseCandidate(id) {
    if (state === 'read') {
      announce('Read the four marks in red first.');
      $('last-bits').focus({preventScroll: true});
      return;
    }
    if (state === 'found') return;
    if (id !== featured.name) {
      updateState('period');
      const other = candidates.find(c => c.id === id);
      announce(`Check ${other.label.split(' · ')[0]}’s period against ${periodMs(featured.count).toFixed(4)} ms.`, true);
      return;
    }
    updateState('match');
    announce('Vela matches. Follow its ray back to the junction.');
    home();
    $('trace').focus({preventScroll: true});
  }

  function traceOrigin() {
    if (state !== 'match') return;
    home(); updateState('found');
    announce('The fourteen rays meet at the Sun.');
    $('again').focus({preventScroll: true});
  }

  function restart() {
    $('last-bits').value = '';
    $('last-bits').removeAttribute('aria-invalid');
    updateState('read'); home();
    announce('Read outward from the centre.');
    $('last-bits').focus({preventScroll: true});
  }

  function focusReader() {
    if (state === 'read') $('last-bits').focus();
    else if (state === 'period') candidateRows.values().next().value.querySelector('button').focus();
    else (state === 'match' ? $('trace') : $('again')).focus();
  }

  function bindMapButton(element, action) {
    element.addEventListener('click', event => { if (!wasDragged) action(event); });
    element.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); action(); }
    });
  }

  function applyView(x, y, size) {
    view.size = Math.min(1000, Math.max(125, size));
    view.x = Math.max(0, Math.min(1000-view.size, x));
    view.y = Math.max(0, Math.min(1000-view.size, y));
    renderView();
  }

  function fractions(clientX, clientY) {
    const box = map.getBoundingClientRect();
    return [(clientX-box.left)/box.width, (clientY-box.top)/box.height];
  }

  function zoom(factor, fx, fy) {
    const nextSize = Math.max(125, Math.min(1000, view.size*factor));
    applyView(view.x + fx*(view.size-nextSize), view.y + fy*(view.size-nextSize), nextSize);
  }

  // Preserve SVG click targets during a tap. Capture only a real drag or pinch.
  const pointers = new Map();
  let gesture = null;
  let wasDragged = false;
  function gestureStart() {
    const p = [...pointers.values()];
    if (!p.length) { gesture = null; return; }
    const a = p[0], b = p[1] || a;
    gesture = {x: (a.x+b.x)/2, y: (a.y+b.y)/2, distance: Math.hypot(a.x-b.x, a.y-b.y), view: {...view}};
  }
  map.addEventListener('pointerdown', event => {
    if (event.button !== 0 || pointers.size >= 2) return;
    if (!pointers.size) wasDragged = false;
    pointers.set(event.pointerId, {x: event.clientX, y: event.clientY});
    gestureStart();
    if (pointers.size === 2) {
      wasDragged = true;
      for (const key of pointers.keys()) map.setPointerCapture(key);
    }
  });
  map.addEventListener('pointermove', event => {
    if (!gesture || !pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, {x: event.clientX, y: event.clientY});
    const p = [...pointers.values()], a = p[0], b = p[1] || a;
    const mx = (a.x+b.x)/2, my = (a.y+b.y)/2;
    if (p.length === 1 && Math.hypot(mx-gesture.x, my-gesture.y) < 4 && !wasDragged) return;
    wasDragged = true;
    map.setPointerCapture(event.pointerId);
    map.classList.add('dragging');
    const [fx, fy] = fractions(gesture.x, gesture.y), [tx, ty] = fractions(mx, my);
    const distance = Math.max(1, Math.hypot(a.x-b.x, a.y-b.y));
    const newSize = p.length === 1 ? gesture.view.size : Math.min(1000, Math.max(125, gesture.view.size*gesture.distance/distance));
    applyView(gesture.view.x + gesture.view.size*fx - newSize*tx, gesture.view.y + gesture.view.size*fy - newSize*ty, newSize);
  });
  function endPointer(event) {
    if (!pointers.delete(event.pointerId)) return;
    gestureStart();
    if (!pointers.size) map.classList.remove('dragging');
  }
  window.addEventListener('pointerup', endPointer);
  window.addEventListener('pointercancel', endPointer);
  map.addEventListener('wheel', event => {
    event.preventDefault();
    const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? map.clientHeight : 1;
    zoom(Math.exp(Math.max(-1, Math.min(1, event.deltaY*units*.002))), ...fractions(event.clientX,event.clientY));
  }, {passive:false});
  map.addEventListener('dblclick', event => { if (!event.target.closest('.map-action')) home(); });
  map.addEventListener('keydown', event => {
    const moves = {ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};
    if (event.key in moves) {
      const [dx,dy] = moves[event.key];
      applyView(view.x + dx*view.size*.13, view.y + dy*view.size*.13, view.size);
    } else if (event.key === '+' || event.key === '=') zoom(.75,.5,.5);
    else if (event.key === '-' || event.key === '_') zoom(1/.75,.5,.5);
    else if (event.key === 'Home') home();
    else return;
    event.preventDefault();
  });

  buildEngraving(); buildReader();
  bindMapButton($('detail-target'), focusReader);
  bindMapButton($('origin-target'), traceOrigin);
  $('decode').addEventListener('submit', checkBits);
  $('trace').addEventListener('click', traceOrigin);
  $('again').addEventListener('click', restart);
  $('last-bits').addEventListener('input', () => $('last-bits').removeAttribute('aria-invalid'));
  let beforePrint = null;
  function showPaperSolution() {
    updateState('found'); home();
    announce('Vela’s ray leads to the Sun, where all fourteen meet.');
  }
  window.addEventListener('beforeprint', () => {
    beforePrint = {state, view: {...view}, message: $('message').textContent, error: $('message').classList.contains('error')};
    showPaperSolution(); fitSheet();
  });
  window.addEventListener('afterprint', () => {
    if (!beforePrint) return;
    updateState(beforePrint.state); Object.assign(view, beforePrint.view);
    announce(beforePrint.message, beforePrint.error); beforePrint = null;
    fitSheet();
  });
  if (new URLSearchParams(location.search).get('edition') === 'print') {
    document.documentElement.dataset.edition = 'print'; showPaperSolution();
  } else updateState('read');
  new ResizeObserver(scheduleFit).observe(sheet);
  new ResizeObserver(scheduleFit).observe(notes);
  document.fonts.ready.then(scheduleFit);
  window.addEventListener('resize', scheduleFit);
  fitSheet();
})();
