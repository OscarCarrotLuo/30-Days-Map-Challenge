(() => {
  "use strict";
  const WIDTH = 1000, HEIGHT = 1000, KM_PER_UNIT = 14.4;
  const NS = "http://www.w3.org/2000/svg";
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const states = [];
  const scale = document.querySelector(".scale");
  const links = Array.from(document.querySelectorAll(".chooser a"));
  let activeId = "";
  const status = document.getElementById("status");

  function svgNode(tag, attrs, label) {
    const el = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
    if (label !== undefined) el.textContent = label;
    return el;
  }

  // The geographic grid is drawn in projected coordinates. Intersect the same
  // polylines with the CURRENT frame so its printed degree labels stay attached.
  function readGrid(map) {
    return Array.from(map.querySelectorAll(".graticule path"), path => {
      const values = path.getAttribute("d").match(/-?[\d.]+/g).map(Number);
      const vertices = [];
      for (let i = 0; i < values.length; i += 2) vertices.push([values[i], values[i + 1]]);
      return { axis: path.dataset.axis, name: path.dataset.value, vertices };
    });
  }

  function drawAxes(state, unit) {
    const { k, x, y, grid, axes } = state;
    const bottom = (HEIGHT - y) / k, left = -x / k;
    const lon = [], lat = [];
    for (const line of grid) {
      const pts = line.vertices;
      for (let i = 1; i < pts.length; i++) {
        const [a, b] = pts[i - 1], [c, d] = pts[i];
        if (line.axis === "lon" && (b < bottom) !== (d < bottom)) {
          const pos = (a + (c - a) * (bottom - b) / (d - b)) * k + x;
          if (pos > 15 * unit && pos < WIDTH - 15 * unit) lon.push([pos, line.name]);
        }
        if (line.axis === "lat" && (a < left) !== (c < left)) {
          const pos = (b + (d - b) * (left - a) / (c - a)) * k + y;
          if (pos > 10 * unit && pos < HEIGHT - 10 * unit) lat.push([pos, line.name]);
        }
      }
    }
    const layer = document.createDocumentFragment();
    function fit(ticks, gap, horizontal) {
      let previous = -Infinity;
      for (const [p, label] of ticks.sort((a, b) => a[0] - b[0])) {
        if (p - previous < gap * unit) continue;
        previous = p;
        if (horizontal) {
          layer.append(svgNode("path", { d: "M" + p + "," + HEIGHT + "v" + 3 * unit }));
          layer.append(svgNode("text", { x: p, y: HEIGHT + state.letter * unit + 3 * unit, "text-anchor": "middle" }, label));
        } else {
          layer.append(svgNode("path", { d: "M0," + p + "h" + -3 * unit }));
          layer.append(svgNode("text", { transform: "translate(" + -5 * unit + "," + p + ") rotate(-90)", "text-anchor": "middle" }, label));
        }
      }
    }
    fit(lon, Math.max(46, state.width / 9), true);
    fit(lat, 39, false);
    axes.replaceChildren(layer);
  }

  function drawScale(state) {
    const svg = state.scale;
    const width = svg.clientWidth, height = svg.clientHeight;
    if (!width || !height) return;
    svg.setAttribute("viewBox", "0 0 " + width + " " + height);
    const kmPerPixel = KM_PER_UNIT * WIDTH / (state.k * state.width);
    // Five equal major divisions, the first subdivided into fifths to the left of zero.
    const proposed = kmPerPixel * Math.max(40, width - 38) / 5;
    const decade = 10 ** Math.floor(Math.log10(proposed));
    const step = ([5, 2, 1].find(v => v * decade <= proposed) || 1) * decade;
    const pixels = step / kmPerPixel;
    const x0 = (width - 5 * pixels) / 2;
    const y0 = height - 4, lineHeight = 2;
    const fragment = document.createDocumentFragment();
    fragment.append(svgNode("rect", { x: x0, y: y0 - lineHeight, width: pixels * 5,
      height: lineHeight, fill: "white", stroke: "#232321", "stroke-width": .65 }));
    for (let j = 0; j < 5; j += 2) {
      fragment.append(svgNode("rect", { x: x0 + j * pixels / 5, y: y0 - lineHeight,
        width: pixels / 5, height: lineHeight, fill: "#232321" }));
    }
    for (let j = 1; j < 5; j += 2) {
      fragment.append(svgNode("rect", { x: x0 + j * pixels, y: y0 - lineHeight,
        width: pixels, height: lineHeight, fill: "#232321" }));
    }
    for (let j = 0; j <= 5; j++) {
      const x = x0 + pixels * j;
      fragment.append(svgNode("path", { d: "M" + x + "," + y0 + "v-4", stroke: "#232321", "stroke-width": .65 }));
      if ([1, 3, 5].includes(j)) {
        fragment.append(svgNode("text", { x, y: y0 - 6, "font-size": state.letter,
          "text-anchor": "middle" }, String((j - 1) * step)));
      }
    }
    svg.replaceChildren(fragment);
    state.scale.parentElement.setAttribute("aria-label", "Scale at projection centre, " + step + " kilometres per division");
  }

  function drawMap(state) {
    const { k, x, y, width, selected } = state;
    if (!width) return;
    const unit = WIDTH / width;
    const letter = state.letter * unit;
    state.map.style.setProperty("--map-letter", letter + "px");
    state.map.toggleAttribute("data-zoomed", k > 1.001);
    state.geography.setAttribute("transform", "translate(" + x + " " + y + ") scale(" + k + ")");
    state.annotations.forEach((annotation, i) => {
      const { el, label, leader, place } = annotation;
      const px = place.x * k + x, py = place.y * k + y;
      const ax = place.ax * k + x, ay = place.ay * k + y;
      const onScreen = px >= 0 && px <= WIDTH && py >= 0 && py <= HEIGHT;
      el.style.display = onScreen ? "" : "none";
      el.classList.toggle("active", selected === i);
      if (!onScreen) return;
      const align = place.align;
      label.setAttribute("text-anchor", align);
      // Leader ends use screen-space offsets, so magnification never pulls the
      // type away from its place. Keep the end inside the frame on a close-up.
      let lx = px + (place.lx - place.x);
      let ly = py + (place.ly - place.y);
      const len = label.getComputedTextLength();
      const pad = 5 * unit;
      const leftSpace = align === "start" ? 0 : align === "end" ? len : len / 2;
      lx = clamp(lx, pad + leftSpace, WIDTH - pad - len + leftSpace);
      ly = clamp(ly, letter + pad, HEIGHT - pad);
      label.setAttribute("x", lx);
      label.setAttribute("y", ly);
      const tx = lx + (align === "end" ? 3 * unit : align === "start" ? -3 * unit : 0);
      const ty = ly - .32 * letter;
      const elbow = tx + Math.sign(ax - tx) * Math.min(9 * unit, Math.abs(ax - tx) * .45);
      leader.setAttribute("d", "M" + ax + "," + ay + "L" + elbow + "," + ty + "H" + tx);
    });
    for (const mark of state.marks) {
      const i = Number(mark.dataset.index);
      mark.classList.toggle("active", i === selected);
      if (mark.classList.contains("city-mark")) {
        const radius = (i === selected ? 3.9 : 3.2) * unit / k;
        mark.querySelector(".point-case").setAttribute("r", radius);
        mark.querySelector(".point-core").setAttribute("r", radius * .64);
      }
    }
    state.rows.forEach((row, i) => {
      const active = i === selected;
      row.setAttribute("aria-current", String(active));
      row.querySelector("button").setAttribute("aria-pressed", String(active));
    });
    drawAxes(state, unit);
    if (state.id === activeId) drawScale(state);
  }

  function viewport(state, k, x, y) {
    state.k = clamp(k, 1, 6);
    state.x = clamp(x, WIDTH * (1 - state.k), 0);
    state.y = clamp(y, HEIGHT * (1 - state.k), 0);
    if (state.k === 1) state.selected = -1;
    drawMap(state);
  }

  function wholeMap(state, announce = true) {
    state.selected = -1;
    viewport(state, 1, 0, 0);
    if (announce) status.textContent = state.name + "’s whole map.";
  }

  function locate(state, index) {
    if (state.selected === index) { wholeMap(state); return; }
    const { place, longName } = state.annotations[index];
    const k = place.kind === "country" ? 2.3 : 3.1;
    state.selected = index;
    viewport(state, k, WIDTH / 2 - place.x * k, HEIGHT / 2 - place.y * k);
    status.textContent = state.name + "’s map, " + longName.textContent + ", " + place.kind + ".";
  }

  function magnify(state, factor, mx, my) {
    const k = clamp(state.k * factor, 1, 6);
    if (k === state.k) return;
    const ratio = k / state.k;
    state.selected = -1;
    viewport(state, k, mx - (mx - state.x) * ratio, my - (my - state.y) * ratio);
  }

  function position(state, event) {
    const rect = state.map.getBoundingClientRect();
    return [(event.clientX - rect.left) * WIDTH / rect.width, (event.clientY - rect.top) * HEIGHT / rect.height];
  }

  function attach(state) {
    const { map } = state;
    let drag = null, consumed = false;
    function pan(dx, dy) {
      state.selected = -1;
      viewport(state, state.k, state.x + dx, state.y + dy);
    }
    map.addEventListener("keydown", e => {
      const change = { ArrowLeft: [60, 0], ArrowRight: [-60, 0], ArrowUp: [0, 36], ArrowDown: [0, -36] }[e.key];
      if (change && state.k > 1) pan(...change);
      else if (["+", "="].includes(e.key)) magnify(state, 1.5, WIDTH / 2, HEIGHT / 2);
      else if (["-", "_"].includes(e.key)) magnify(state, 1 / 1.5, WIDTH / 2, HEIGHT / 2);
      else if (["Home", "Escape", "0"].includes(e.key)) wholeMap(state);
      else return;
      e.preventDefault();
    });
    map.addEventListener("wheel", e => {
      // A normal scroll must still reach the other two stories on a phone or tablet.
      if (!(e.ctrlKey || e.metaKey || document.activeElement === map)) return;
      e.preventDefault();
      magnify(state, Math.exp(-Math.sign(e.deltaY) * .18), ...position(state, e));
    }, { passive: false });
    map.addEventListener("pointerdown", e => {
      consumed = false;
      if (e.button !== 0 || !e.isPrimary || state.k <= 1) return;
      drag = { id: e.pointerId, clientX: e.clientX, clientY: e.clientY, x: state.x, y: state.y };
    });
    map.addEventListener("pointermove", e => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.clientX, dy = e.clientY - drag.clientY;
      if (!consumed && Math.hypot(dx, dy) < 4) return;
      consumed = true;
      map.setAttribute("data-dragging", "");
      if (!map.hasPointerCapture(e.pointerId)) map.setPointerCapture(e.pointerId);
      state.selected = -1;
      viewport(state, state.k, drag.x + dx * WIDTH / state.width, drag.y + dy * WIDTH / state.width);
    });
    function endDrag(e) {
      if (!drag || e.pointerId !== drag.id) return;
      if (map.hasPointerCapture(e.pointerId)) map.releasePointerCapture(e.pointerId);
      drag = null;
      map.removeAttribute("data-dragging");
    }
    map.addEventListener("pointerup", endDrag);
    map.addEventListener("pointercancel", endDrag);
    map.addEventListener("pointerleave", e => {
      if (drag && !map.hasPointerCapture(e.pointerId)) endDrag(e);
    });
    map.addEventListener("click", e => {
      if (consumed) { consumed = false; return; }
      const target = e.target.closest("[data-index]");
      if (target) locate(state, Number(target.dataset.index));
      else if (state.k > 1) wholeMap(state);
    });
    for (const row of state.rows) {
      row.addEventListener("click", () => locate(state, Number(row.dataset.index)));
    }
  }

  function measure(state) {
    state.width = state.map.getBoundingClientRect().width;
    state.letter = parseFloat(getComputedStyle(state.article).fontSize);
    drawMap(state);
  }

  for (const article of document.querySelectorAll(".account")) {
    const map = article.querySelector(".map");
    const id = article.dataset.id;
    const notes = document.querySelector('.story-notes[data-id="' + id + '"]');
    const state = {
      article, map, id, notes, name: article.dataset.name,
      geography: map.querySelector(".geography"), axes: map.querySelector(".axes"), grid: readGrid(map),
      scale, marks: Array.from(map.querySelector(".marks").children),
      rows: Array.from(notes.querySelectorAll("tbody tr")), k: 1, x: 0, y: 0, selected: -1,
      annotations: Array.from(map.querySelectorAll(".annotation"), el => {
        const d = el.dataset;
        return { el, label: el.querySelector("text"), leader: el.querySelector(".leader"),
          longName: el.querySelector(".long-name"),
          place: { x: +d.x, y: +d.y, ax: +d.ax, ay: +d.ay, lx: +d.lx, ly: +d.ly, align: d.align, kind: d.kind } };
      })
    };
    states.push(state);
    attach(state);
  }
  function choose() {
    const match = states.find(s => "#" + s.id === location.hash) || states[0];
    activeId = match.id;
    for (const s of states) {
      s.article.hidden = s.notes.hidden = s !== match;
      if (s !== match) s.notes.querySelector("details").open = false;
    }
    for (const link of links) {
      if (link.hash === "#" + activeId) link.setAttribute("aria-current", "true");
      else link.removeAttribute("aria-current");
    }
    measure(match);
    status.textContent = match.name + "’s map.";
  }
  choose();
  for (const link of links) {
    link.closest("tr").addEventListener("click", e => {
      if (!e.target.closest("a")) link.click();
    });
  }
  window.addEventListener("hashchange", choose);
  const rail = document.querySelector(".rail");
  const composition = document.querySelector(".composition");
  function fit() {
    rail.closest(".sheet").style.setProperty("--notes-height", rail.getBoundingClientRect().height + "px");
    states.forEach(measure);
  }
  const observer = new ResizeObserver(fit);
  states.forEach(s => observer.observe(s.map));
  observer.observe(rail);
  observer.observe(composition);
  observer.observe(scale);
  document.fonts.ready.then(() => { fit(); document.documentElement.dataset.ready = "true"; });
  function overview(enabled) {
    document.documentElement.classList.toggle("overview", enabled);
    if (enabled) {
      for (const state of states) { state.article.hidden = false; wholeMap(state, false); measure(state); }
    } else choose();
  }
  if (new URLSearchParams(location.search).has("poster")) overview(true);
  window.addEventListener("beforeprint", () => overview(true));
  window.addEventListener("afterprint", () => overview(new URLSearchParams(location.search).has("poster")));
})();
