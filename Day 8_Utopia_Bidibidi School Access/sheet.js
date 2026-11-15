(() => {
  "use strict";
  const NS = "http://www.w3.org/2000/svg";
  const RED = "#983b35", INK = "#232321", PAPER = "#fff", WATER = "#657e82";
  const LAND = "#ebeae2", CLOSER = "#f0ddd4", HATCH = "#c09587";
  const [west, north, east, south] = PLAN.bbox;
  const fullWidth = east - west, fullHeight = south - north;
  const midpoint = [(west + east) / 2, (north + south) / 2];
  const camera = { x: midpoint[0], y: midpoint[1], zoom: 1 };
  const byId = new Map(PLAN.villages.map(v => [v.id, v]));
  const schools = new Map(PLAN.schools.map(s => [s.id, s]));
  const field = document.getElementById("school-map");
  const defs = el("defs", {}, field);
  const world = el("g", {id:"plan-linework"}, field);
  const grid = el("g", {id:"graticule","pointer-events":"none"}, field);
  const mapInk = el("g", {id:"map-annotations"}, field);
  const xAxis = document.getElementById("longitude"), yAxis = document.getElementById("latitude");
  let selected = null, queued = false;
  const id = n => "V" + String(n).padStart(2, "0");
  const limit = (value, min, max) => Math.max(min, Math.min(max, value));
  const rounded = metres => Math.round(metres / 50) * 50;
  const display = metres => rounded(metres).toLocaleString("en-US");
  const saving = v => rounded(v.before) - rounded(v.after);

  function el(tag, attrs = {}, parent, content) {
    const node = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    if (content !== undefined) node.textContent = content;
    if (parent) parent.append(node);
    return node;
  }
  function linesPath(lines, closed = false) {
    return lines.map(line => "M" + line.map(p => p.join(",")).join("L") + (closed ? "Z" : "")).join("");
  }
  function symbol(parent, kind, size, x = 0, y = 0) {
    const group = el("g", {transform: `translate(${x} ${y})`}, parent);
    if (kind === "village" || kind === "shorter") {
      el("circle", { r: size * .28, fill: kind === "shorter" ? RED : PAPER,
        stroke: kind === "shorter" ? RED : INK, "stroke-width": size * .12 }, group);
    } else if (kind === "school" || kind === "proposal") {
      const dashed = kind === "proposal";
      el("path", { d: "M0,-6 L5.4,-2.1 V4.8 H-5.4 V-2.1 Z", transform: `scale(${size / 11})`,
        fill: dashed ? PAPER : INK, stroke: dashed ? RED : INK,
        "stroke-width": dashed ? 1.45 : .85, "stroke-dasharray": dashed ? "3.1 1.8" : "none",
        "stroke-linejoin": "round" }, group);
      el("path", { d: "M-1.05,1.2 h2.1 v3.6 h-2.1 z", transform: `scale(${size / 11})`,
        fill: dashed ? RED : PAPER }, group);
    }
    return group;
  }
  function landPattern(name, fill, stroke, angle, spacing) {
    const pattern = el("pattern", {id:name, width:spacing, height:spacing,
      patternUnits:"userSpaceOnUse", patternTransform:`rotate(${angle})`}, defs);
    el("rect", {width:spacing, height:spacing, fill}, pattern);
    el("path", {d:`M0 0 V${spacing}`,stroke,"stroke-width":.24,fill:"none"}, pattern);
  }
  function planBackground() {
    landPattern("residential-hatch", LAND, "#c6c4b8", 40, 2.75);
    landPattern("nearer-hatch", CLOSER, HATCH, -40, 2.55);
    el("path", {d:linesPath(PLAN.housing,true),fill:"url(#residential-hatch)","fill-rule":"evenodd"}, world);
    const improvement = el("path", {id:"closer-land",d:linesPath(PLAN.closerLand,true),
      fill:"url(#nearer-hatch)","fill-rule":"evenodd"}, world);
    el("title", {}, improvement, "Residential land where the proposed school would be closer than the nearest 2018 school");
    const pens = {
      contours: ["#aba99c", .64], blocks: ["#494c43", .82],
      roads: ["#777468", .71], streams: [WATER, .88],
    };
    for (const [key, [color, width]] of Object.entries(pens)) {
      el("path", {"data-layer":key, d:linesPath(PLAN.layers[key]),fill:"none",stroke:color,
        "stroke-width":width,"vector-effect":"non-scaling-stroke","stroke-linecap":"round","stroke-linejoin":"round"}, world);
    }
    el("path",{id:"equidistance-line",d:linesPath(PLAN.equidistance),fill:"none",stroke:"#ab7063",
      "stroke-width":.85,"vector-effect":"non-scaling-stroke"},world);
  }
  function bounds() {
    const width = fullWidth / camera.zoom, height = fullHeight / camera.zoom;
    return [camera.x - width / 2, camera.y - height / 2, width, height];
  }
  function setView(x, y, zoom) {
    camera.zoom = limit(zoom, 1, 6);
    const halfWidth = fullWidth / (2 * camera.zoom), halfHeight = fullHeight / (2 * camera.zoom);
    camera.x = limit(x, west + halfWidth, east - halfWidth);
    camera.y = limit(y, north + halfHeight, south - halfHeight);
    requestRender();
  }
  function resetView() { setView(...midpoint, 1); }
  function requestRender() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; render(); });
  }
  function ticks(min, max, step) {
    const values = [];
    for (let n = Math.ceil((min - 1e-8) / step); n * step <= max + 1e-8; n++) values.push(n * step);
    return values;
  }
  function axes(width, height, fontSize, toScreen) {
    const [left, top, worldWidth, worldHeight] = bounds();
    const [gx, gy, pointsPerDeg] = PLAN.grid;
    grid.replaceChildren(); xAxis.replaceChildren();
    yAxis.replaceChildren();
    const divisions = width < 245 ? 2 : 4;
    const step = [.0005, .001, .002, .005, .01, .02, .05].find(s => s >= worldWidth / pointsPerDeg / divisions);
    const decimals = step < .01 ? 3 : 2;
    const leftLon = 31.30 + (left - gx) / pointsPerDeg;
    const topLat = 3.35 - (top - gy) / pointsPerDeg;
    const textSize = fontSize;
    const h = xAxis.getBoundingClientRect().height;
    const w = yAxis.getBoundingClientRect().width;
    xAxis.setAttribute("viewBox", `0 0 ${width} ${h}`);
    yAxis.setAttribute("viewBox", `0 0 ${w} ${height}`);
    const gridPen = { stroke: "#b6b4aa", "stroke-width": .52, "stroke-dasharray": "2 5" };
    for (const lon of ticks(leftLon, leftLon + worldWidth / pointsPerDeg, step)) {
      const x = toScreen([gx + (lon - 31.30) * pointsPerDeg, top])[0];
      el("line", {x1:x, x2:x, y1:0, y2:height, ...gridPen}, grid);
      el("line", {x1:x, x2:x, y1:0, y2:3, stroke:INK, "stroke-width":.7}, xAxis);
      if (x < 16 || x > width - 16) continue;
      el("text", {x, y:4 + textSize, "text-anchor":"middle", "font-size":textSize}, xAxis,
        lon.toFixed(decimals) + "°E");
    }
    for (const lat of ticks(topLat - worldHeight / pointsPerDeg, topLat, step)) {
      const y = toScreen([left, gy - (lat - 3.35) * pointsPerDeg])[1];
      el("line", {x1:0, x2:width, y1:y, y2:y, ...gridPen}, grid);
      el("line", {x1:w - 3, x2:w, y1:y, y2:y, stroke:INK, "stroke-width":.7}, yAxis);
      if (y < 15 || y > height - 15) continue;
      el("text", {transform:`translate(${w - 5} ${y}) rotate(-90)`, "text-anchor":"middle",
        "font-size":textSize}, yAxis, lat.toFixed(decimals) + "°N");
    }
  }
  function villageMarker(parent, v, p, affected, fontSize, small) {
    const group = el("g", { class: "village" + (affected ? " affected" : "") + (selected === v.id ? " selected" : ""),
      "data-village": v.id, transform: `translate(${p[0]} ${p[1]})` }, parent);
    el("title", {}, group, `${id(v.id)} · 2018 plan ${display(v.before)} m · With proposal ${display(v.after)} m`);
    const size = small ? 8 : fontSize;
    el("circle", { r: size * .67, class:"selection-ring", fill:"none", stroke:affected ? RED : INK, "stroke-width":1 }, group);
    symbol(group, affected ? "shorter" : "village", size).classList.add("village-point");
    const offsets = {1:[.60,-.55], 2:[-.55,-.58], 3:[-.55,.98], 4:[.6,.88], 5:[.6,-.55], 6:[-.57,.98],
      7:[.59,-.6], 8:[-.58,-.55], 9:[-.58,.98], 10:[.58,-.55], 11:[-.58,1.02], 12:[.57,1.02]};
    if (small) {
      offsets[2] = [-.83, -.42];
      offsets[3] = [.53, .52];
      offsets[4] = [-.68, .52];
    } else offsets[3] = [.55, .92];
    const [dx,dy] = offsets[v.id];
    el("text", { x:dx*size, y:dy*size, "text-anchor":dx < 0 ? "end" : "start", "font-size":size,
      class:"label village-id"}, group, small ? "V" + v.id : id(v.id));
    el("circle", {r: small ? 7 : size * .88, fill:"transparent"}, group);
  }
  function schoolMark(parent, xy, title, hypothetical, size, height, fontSize, toScreen) {
    const [x,y] = toScreen(xy);
    const k = size < 245 ? 8 : fontSize;
    if (x < -9 || y < -9 || x > size+9 || y > height+9) return;
    const d = hypothetical ? RED : INK;
    const top = size < 245 ? -3.1 : -2.1;
    const leader = hypothetical ? [-1.4, top, -2.6, top] : [.9, 1.7, 2.1, 1.7];
    const a = leader.map(v => v*k);
    const group = el("g", {transform:`translate(${x} ${y})`, class:hypothetical ? "school proposed" : "school existing"}, parent);
    el("title", {}, group, title);
    const path = el("path", {d:`M0,0 L${a[0]},${a[1]} H${a[2]}`,
      fill:"none", stroke:d, "stroke-width":.8}, group);
    if (hypothetical) path.setAttribute("stroke-dasharray", "3 2");
    const glyph = symbol(group, hypothetical ? "proposal" : "school", k * (hypothetical ? 1.55 : 1.36));
    glyph.classList.add("school-symbol");
    if (hypothetical) glyph.classList.add("hypothetical-symbol");
    const left = hypothetical;
    const textY = left ? a[3] - .44*k : a[3] + 1.05*k;
    const label = el("text", {y:textY, "font-size":k, class:"label" + (hypothetical ? " proposed" : ""),
      "text-anchor":"middle"}, group, title);
    const halfLabel = label.getComputedTextLength() / 2 + 2;
    label.setAttribute("x", limit(x + a[2], halfLabel, size - halfLabel) - x);
  }
  function distanceLine(parent, a, b, proposed) {
    const d = `M${a[0]},${a[1]} L${b[0]},${b[1]}`;
    el("path", {d, fill:"none", stroke:PAPER, "stroke-width":3.3, opacity:.86, class:"survey-link"}, parent);
    el("path", {d, fill:"none", stroke:proposed ? RED : INK, "stroke-width":1.35,
      "stroke-dasharray":proposed ? "none" : "4 2.5", class:"survey-link measurement-line",
      "data-scenario":proposed ? "proposed" : "2018"}, parent);
  }
  function facilityMark(item, x, y, fontSize) {
    const g = el("g", {class:"facility", "data-kind":item.kind,
      transform:`translate(${x} ${y}) scale(${fontSize/10})`}, mapInk);
    el("title", {}, g, item.label);
    if (item.kind === "health") {
      el("rect", {x:-3.3,y:-3.3,width:6.6,height:6.6,fill:PAPER,stroke:"#61635b","stroke-width":.75},g);
      el("path", {d:"M-2.2 0H2.2 M0 -2.2V2.2",stroke:"#50564e","stroke-width":1.15},g);
    } else {
      el("path", {d:item.kind === "cfs" ? "M-2.2 -2.2H2.2V2.2H-2.2Z" : "M0 -3L3 0 0 3 -3 0Z",
        fill:PAPER,stroke:"#686a5e","stroke-width":1},g);
    }
  }
  function overlay(width, height, fontSize, toScreen) {
    mapInk.replaceChildren();
    const detailWidth = width * camera.zoom;
    const chosen = byId.get(selected);
    const measures = [];
    if (chosen) {
      const origin = toScreen(chosen.xy);
      const before = toScreen(schools.get(chosen.school).xy);
      distanceLine(mapInk,origin,before,false);
      measures.push([origin,before,chosen.gain ? "2018" : "Nearest school",display(chosen.before),false]);
      if (chosen.gain > 0) {
        const after = toScreen(PLAN.site);
        distanceLine(mapInk,origin,after,true);
        measures.push([origin,after,"Proposed",display(chosen.after),true]);
      }
    }
    const facilities = PLAN.details.filter(d => ["health","cfs","recreation"].includes(d.kind));
    for (const item of facilities) facilityMark(item,...toScreen(item.xy),fontSize);
    for (const v of PLAN.villages) villageMarker(mapInk, v, toScreen(v.xy), v.gain > 0, fontSize, width < 245);
    for (const s of PLAN.schools) schoolMark(mapInk, s.xy, s.id === "yangani" ? "2018 primary school" : s.label,
      false,width,height,fontSize,toScreen);
    schoolMark(mapInk,PLAN.site,"Proposed school",true,width,height,fontSize,toScreen);
    const nx = width - 15, ny = 22;
    el("text", {x:nx,y:ny-5,class:"label","text-anchor":"middle","font-size":fontSize},mapInk,"N");
    el("path", {d:`M${nx},${ny-2} l-2.6,7.5 2.6,-1 2.6,1 Z`,fill:INK},mapInk);

    // Reserve the school and village ink first. At smaller scales, a source
    // feature remains at its surveyed position even when its text must wait.
    const frame = field.getBoundingClientRect();
    const occupied = [...mapInk.querySelectorAll(".label,.village-point,.school-symbol,.facility")]
      .map(n => n.getBoundingClientRect());
    const nearPoint = [[.8,-.5],[.8,1.05],[-.8,-.5],[-.8,1.05]];
    function annotate(label, point, positions, style, angle = 0) {
      const [x,y] = point;
      if (x < 0 || y < 0 || x > width || y > height) return;
      const node = el("text", {class:"label map-detail "+style, "font-size":fontSize}, mapInk, label);
      for (const [dx,dy] of positions) {
        node.setAttribute("text-anchor", dx > 0 ? "start" : dx < 0 ? "end" : "middle");
        node.setAttribute("transform",`translate(${x+dx*fontSize} ${y+dy*fontSize}) rotate(${angle})`);
        const b = node.getBoundingClientRect();
        if (b.left<frame.left+3 || b.right>frame.right-3 || b.top<frame.top+3 || b.bottom>frame.bottom-3) continue;
        if (occupied.some(r => b.left<r.right+2 && b.right>r.left-2 && b.top<r.bottom+1.5 && b.bottom>r.top-1.5)) continue;
        occupied.push(b);
        return;
      }
      node.remove();
    }
    for (const [a,b,name,metres,proposed] of measures) {
      const mid = [(a[0]+b[0])/2,(a[1]+b[1])/2];
      annotate(`${name} · ${metres} m`,mid,[[0,-.6],[0,1.4],[.8,-.6],[-.8,1.4]],
        proposed ? "measure-label proposed" : "measure-label");
    }
    if (detailWidth >= 480) {
      for (const v of PLAN.villages.filter(v => v.gain > 0)) {
        if (chosen && chosen.id !== v.id) continue;
        annotate(`${saving(v).toLocaleString("en-US")} m closer`,toScreen(v.xy),
          [[.85,1.15],[-.85,1.15],[.85,-1.85],[-.85,-1.85]],"gain-label");
      }
    }
    for (const item of PLAN.details.filter(d => d.kind === "place")) {
      annotate(item.label.toUpperCase(),toScreen(item.xy),[[0,0],[0,1.4],[0,-1.4]],"place-name");
    }
    for (const item of facilities) {
      if (item.kind !== "health" && detailWidth < 370) continue;
      annotate(item.label,toScreen(item.xy),nearPoint,"facility-label");
    }
    for (const item of PLAN.details.filter(d => d.kind === "road" || d.kind === "elevation")) {
      if (item.kind === "elevation" && detailWidth < 390) continue;
      annotate(item.label,toScreen(item.xy),[[0,-.42],[0,.95]],item.kind+"-label",item.angle);
    }
  }
  function scaleBar(mapWidth, fontSize) {
    const svg = document.getElementById("scale"), box = svg.getBoundingClientRect();
    svg.replaceChildren();
    if (!box.width) return;
    svg.setAttribute("viewBox", `0 0 ${box.width} ${box.height}`);
    const pxPerMetre = mapWidth * camera.zoom / (fullWidth * PLAN.metresPerPoint);
    const available = Math.min(box.width - 4 * fontSize, mapWidth * .9);
    if (available <= 0) return;
    // On a narrow footer, preserve room for metre labels on the shorter bar.
    const targetUnits = limit(Math.floor(available / (3.4 * fontSize)), 2, 5);
    const maxStep = available / (targetUnits * pxPerMetre);
    const power = 10 ** Math.floor(Math.log10(maxStep));
    const step = [1, 2, 2.5, 5, 10].filter(n => n * power <= maxStep).at(-1) * power;
    const segment = step * pxPerMetre;
    const divisions = Math.min(6, Math.floor(available / segment + 1e-8) - 1);
    const length = (divisions + 1) * segment;
    const start = (box.width - length) / 2, zero = start + segment, y = box.height - 4;
    el("rect", {x:start, y:y-1.5, width:length, height:1.5, fill:PAPER, stroke:INK, "stroke-width":.65}, svg);
    for (let i=0; i<5; i+=2) el("rect", {x:start+i*segment/5, y:y-1.5, width:segment/5, height:1.5, fill:INK}, svg);
    for (let i=0; i<divisions; i+=2) el("rect", {x:zero+i*segment, y:y-1.5, width:segment, height:1.5, fill:INK}, svg);
    for (let i=-1; i<=divisions; i++) {
      const x=zero+i*segment;
      el("line",{x1:x,x2:x,y1:y+.6,y2:y-4,stroke:INK,"stroke-width":.65},svg);
      el("text",{x,y:y-5,"text-anchor":"middle","font-size":fontSize},svg,String(Math.abs(i)*step));
    }
    svg.setAttribute("aria-label", `Graphic scale, ${step} metres per major division`);
  }

  // As on the Day 2 sheet, size the field after measuring its marginalia.
  function fitSheet() {
    const sheet = document.querySelector(".sheet"), notes = document.querySelector(".note-space");
    const css = getComputedStyle(sheet);
    const width = sheet.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
    const height = sheet.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom);
    const horizontal = css.flexDirection === "row";
    sheet.toggleAttribute("data-foot", !horizontal);
    const scroller = document.querySelector(".register-scroll");
    const head = scroller.querySelector("thead"), rows = scroller.querySelectorAll("tbody tr");
    if (rows.length) {
      const rowHeight = rows[Math.min(7, rows.length) - 1].getBoundingClientRect().bottom - rows[0].getBoundingClientRect().top;
      scroller.style.maxHeight = Math.floor(head.getBoundingClientRect().height + rowHeight) + "px";
    }
    let side;
    if (horizontal) {
      side = Math.min(height, width - notes.getBoundingClientRect().width - parseFloat(css.columnGap), 1340);
    } else {
      const room = height - parseFloat(css.rowGap);
      // The extra symbol key uses the available paper width on a narrow
      // screen. Keeping the notes wider avoids shrinking the map to fit text.
      const minFooter = width < 550 ? width : Math.min(width, 64 * parseFloat(css.fontSize));
      let footer = Math.min(width,1340);
      for (let pass=0; pass<4; pass++) {
        notes.style.setProperty("--foot-width", footer + "px");
        side = Math.min(width, room - notes.getBoundingClientRect().height, 1340);
        const next = Math.max(minFooter, Math.floor(side));
        if (next >= footer-1) break;
        footer = next;
      }
    }
    sheet.style.setProperty("--side", Math.max(1,Math.floor(side)) + "px");
    requestRender();
  }

  function render() {
    const fontSize = parseFloat(getComputedStyle(document.body).fontSize);
    const {width, height} = field.getBoundingClientRect();
    if (width <= 0 || height <= 0) return;
    const [left,top,worldWidth] = bounds();
    const k = width / worldWidth;
    const toScreen = ([x,y]) => [(x-left)*k,(y-top)*k];
    field.setAttribute("viewBox", `0 0 ${width} ${height}`);
    field.classList.toggle("zoomed", camera.zoom > 1);
    world.setAttribute("transform", `matrix(${k} 0 0 ${k} ${-left*k} ${-top*k})`);
    axes(width,height,fontSize,toScreen);
    overlay(width,height,fontSize,toScreen);
    scaleBar(width,fontSize);
  }
  function selectVillage(next) {
    selected = next === selected ? null : next;
    for (const row of document.querySelectorAll("#village-rows tr")) {
      const active = Number(row.dataset.id) === selected;
      row.classList.toggle("selected", active);
      row.querySelector("button").setAttribute("aria-pressed", String(active));
      if (active) {
        const scroll = row.closest(".register-scroll");
        const visible = scroll.getBoundingClientRect(), rowBox = row.getBoundingClientRect();
        const top = visible.top + scroll.querySelector("thead").getBoundingClientRect().height;
        if (rowBox.top < top) scroll.scrollTop += rowBox.top-top;
        else if (rowBox.bottom > visible.bottom) scroll.scrollTop += rowBox.bottom-visible.bottom;
      }
    }
    const status = document.getElementById("selection-status");
    if (selected === null) {
      status.textContent = "Village selection cleared.";
    } else {
      const v = byId.get(selected);
      status.textContent = `${id(v.id)}. Before, about ${display(v.before)} metres. After, about ${display(v.after)} metres. Distance saved, about ${saving(v).toLocaleString("en-US")} metres.`;
      if (camera.zoom > 1) {
        const [left,top,width,height] = bounds();
        if (v.xy[0]<left+.09*width || v.xy[0]>left+.91*width || v.xy[1]<top+.09*height || v.xy[1]>top+.91*height)
          setView(...v.xy,camera.zoom);
      }
    }
    requestRender();
  }
  function table() {
    const body = document.getElementById("village-rows");
    for (const v of PLAN.villages) {
      const row = body.insertRow();
      row.dataset.id = v.id;
      const btn = document.createElement("button");
      btn.type = "button"; btn.textContent = id(v.id);
      btn.setAttribute("aria-label", `Trace school distance for ${id(v.id)}`);
      btn.setAttribute("aria-pressed","false");
      row.insertCell().append(btn);
      row.insertCell().textContent = display(v.before);
      row.insertCell().textContent = display(v.after);
      const last = row.insertCell();
      last.textContent = saving(v).toLocaleString("en-US");
      if (v.gain > 0) last.className = "positive";
      row.addEventListener("click", () => selectVillage(v.id));
    }
    const count = PLAN.villages.filter(v => v.gain > 0).length;
    document.getElementById("register-total").textContent = `Shorter distance in ${count} of ${PLAN.villages.length} villages`;
  }
  function drawKey() {
    for (const svg of document.querySelectorAll(".key")) {
      svg.setAttribute("viewBox","0 0 24 15");
      const kind = svg.dataset.key;
      if (kind === "land" || kind === "nearer") {
        const nearer = kind === "nearer";
        el("rect",{x:3,y:2.5,width:18,height:10,fill:nearer ? CLOSER : LAND,
          stroke:nearer ? RED : "#79786e","stroke-width":.7},svg);
        el("path",{d:"M3,8 l5.5,-5.5 M4.5,12.5 l10,-10 M10.5,12.5 l10,-10 M16.5,12.5 l4.5,-4.5",
          transform:nearer ? "translate(24 0) scale(-1 1)" : "",fill:"none",stroke:nearer ? RED : "#98978a","stroke-width":.7},svg);
      } else if (kind === "water") {
        el("path",{d:"M2,10 C6,10 7,5 11,7 S17,10 22,4",stroke:WATER,fill:"none","stroke-width":1.1},svg);
      } else symbol(svg,kind,10.5,12,7.5);
    }
    const locator = document.getElementById("locator");
    const project = ([lon,lat]) => [(lon - 29.3)*12+6, (4.45-lat)*12+6];
    el("path",{d:linesPath([PLAN.uganda.map(project)],true),fill:"#e8e8e3",stroke:"#696961","stroke-width":.95},locator);
    const [gx,gy,pointsPerDeg] = PLAN.grid;
    const spot = project([31.30+(midpoint[0]-gx)/pointsPerDeg,3.35-(midpoint[1]-gy)/pointsPerDeg]);
    el("circle",{cx:spot[0],cy:spot[1],r:3,fill:RED,stroke:PAPER,"stroke-width":.8},locator);
  }
  function gestures(field) {
    const pointers = new Map();
    let gesture = null, moved = false;
    function local(clientX,clientY) {
      const r = field.getBoundingClientRect();
      return [(clientX-r.left)/r.width,(clientY-r.top)/r.height];
    }
    function pagePoint(fraction) {
      const [left,top,width,height] = bounds();
      return [left+fraction[0]*width,top+fraction[1]*height];
    }
    function anchor(anchorPoint,fraction,zoom) {
      const z = limit(zoom,1,6);
      setView(anchorPoint[0]-(fraction[0]-.5)*fullWidth/z,anchorPoint[1]-(fraction[1]-.5)*fullHeight/z,z);
    }
    function pointerState() {
      const [a,b] = [...pointers.values()];
      if (!b) return {at:a, gap:0};
      return {at:[(a[0]+b[0])/2,(a[1]+b[1])/2],gap:Math.hypot((a[0]-b[0])*field.clientWidth,(a[1]-b[1])*field.clientHeight)};
    }
    function start() {
      const {at,gap} = pointerState();
      gesture = {origin:pagePoint(at),at,gap,zoom:camera.zoom};
    }
    field.addEventListener("pointerdown", e => {
      if (e.button !== 0 || pointers.size >= 2) return;
      if (!pointers.size) moved = false;
      pointers.set(e.pointerId,local(e.clientX,e.clientY));
      field.setPointerCapture(e.pointerId);
      if (pointers.size === 2) moved = true;
      start();
    });
    field.addEventListener("pointermove", e => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId,local(e.clientX,e.clientY));
      const {at,gap} = pointerState();
      const change = Math.hypot((at[0]-gesture.at[0])*field.clientWidth,(at[1]-gesture.at[1])*field.clientHeight);
      if (change > 4) moved = true;
      if (!moved) return;
      if (camera.zoom > 1) field.classList.add("dragging");
      anchor(gesture.origin,at,gap && gesture.gap ? gesture.zoom*gap/gesture.gap : gesture.zoom);
    });
    function end(e) {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      if (pointers.size) { start(); return; }
      field.classList.remove("dragging");
      if (!moved && e.type === "pointerup") {
        const hit = document.elementFromPoint(e.clientX,e.clientY)?.closest("[data-village]");
        if (hit && field.contains(hit)) selectVillage(Number(hit.dataset.village));
      }
      gesture = null;
    }
    for (const type of ["pointerup","pointercancel","lostpointercapture"]) field.addEventListener(type,end);
    field.addEventListener("wheel", e => {
      e.preventDefault();
      const f=local(e.clientX,e.clientY);
      const delta=e.deltaY*(e.deltaMode===1 ? 16 : e.deltaMode===2 ? field.clientHeight : 1);
      anchor(pagePoint(f),f,camera.zoom*Math.exp(-limit(delta,-400,400)*.003));
    },{passive:false});
    field.addEventListener("dblclick", e => {
      e.preventDefault();
      if (e.target.closest("[data-village]")) return;
      const f=local(e.clientX,e.clientY);
      if (camera.zoom >= 3.9) resetView();
      else anchor(pagePoint(f),f,camera.zoom*2);
    });
    field.addEventListener("keydown", e => {
      const step = fullWidth/camera.zoom*.12;
      switch(e.key) {
        case "+": case "=": setView(camera.x,camera.y,camera.zoom*1.5); break;
        case "-": case "_": setView(camera.x,camera.y,camera.zoom/1.5); break;
        case "ArrowLeft": setView(camera.x-step,camera.y,camera.zoom); break;
        case "ArrowRight": setView(camera.x+step,camera.y,camera.zoom); break;
        case "ArrowUp": setView(camera.x,camera.y-step,camera.zoom); break;
        case "ArrowDown": setView(camera.x,camera.y+step,camera.zoom); break;
        case "Home": resetView(); break;
        default: return;
      }
      e.preventDefault();
    });
  }
  document.addEventListener("keydown",e => { if (e.key === "Escape" && selected !== null) selectVillage(null); });
  planBackground(); table(); drawKey(); gestures(field); fitSheet();
  const observer = new ResizeObserver(fitSheet);
  observer.observe(document.querySelector(".sheet"));
  window.addEventListener("beforeprint", fitSheet);
  window.addEventListener("afterprint", fitSheet);
  document.fonts.ready.then(fitSheet);
})();
