(() => {
  'use strict';
  const atlas = window.ASYLUM_ATLAS;
  const $ = id => document.getElementById(id);
  const origin = atlas.origin;
  const hosts = atlas.hosts;
  const byCode = new Map(hosts.map(h => [h.code, h]));
  const fmt = new Intl.NumberFormat('en-US');
  const DEG = Math.PI / 180;
  const INK = '#232321', RED = '#923a35', PAPER = '#fff';
  const fullView = {lon: 0, lat: 0, span: 360};
  const detailView = {lon: 33.2, lat: 7.7, span: 52};
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const wrap = lon => ((lon + 180) % 360 + 360) % 360 - 180;
  const pct = n => {
    const p = 100 * n / atlas.total;
    return p < .01 ? '<0.01%' : p.toFixed(p >= 1 ? 1 : 2) + '%';
  };
  const linkWeight = n => .6 + 4.55 * (n / 1000000) ** .42;
  const radius = n => 1.85 + 2.6 * (n / 1000000) ** .38;
  const fonts = {px: 10, family: "'ChartBarlow', sans-serif"};
  const font = (weight = 500) => `${weight} ${fonts.px}px ${fonts.family}`;
  let selected = null, hover = null, scheduled = false, flight = 0;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');

  function panel(id, initial) {
    const el = $(id + '-panel');
    return {el, canvas: el.querySelector('.overlay'), xAxis: $(id + '-longitude'),
      yAxis: el.querySelector('.latitude'), view: {...initial}, hits: []};
  }
  const world = panel('world', fullView), region = panel('region', detailView);
  const photos = [[$('world-texture'), [-180,-90,180,90]], [$('region-texture'), atlas.regionRaster]];

  for (const h of hosts) {
    const tr = document.createElement('tr');
    tr.dataset.code = h.code;
    const name = document.createElement('button');
    name.type = 'button'; name.textContent = h.name;
    name.setAttribute('aria-label', `${h.name}, ${fmt.format(h.people)} refugees, ${pct(h.people)} of the global total`);
    tr.insertCell().append(name);
    tr.insertCell().textContent = fmt.format(h.people);
    tr.insertCell().textContent = pct(h.people);
    if (h.people === 5) tr.title = 'UNHCR rounds counts below five to the nearest multiple of five.';
    $('hosts').append(tr);
    h.row = tr;
  }
  $('register-heading').textContent = `Countries of asylum · ${hosts.length}`;
  $('summary-count').textContent = `${fmt.format(atlas.total)} refugees`;
  $('data-source').href = atlas.source;
  for (const [n, label] of [[100, '100'], [10000, '10,000'], [1000000, '1 million']]) {
    const sample = document.createElement('span'), line = document.createElement('i');
    sample.className = 'sample'; line.style.height = linkWeight(n) / 10 + 'em';
    sample.append(line, document.createTextNode(label)); $('samples').append(sample);
  }

  // Geometry stays in (longitude, -latitude) until it is drawn. Lines scale in screen pixels.
  function appendLine(path, coords, close = false) {
    if (!coords.length) return;
    path.moveTo(coords[0][0], -coords[0][1]);
    for (let i = 1; i < coords.length; i++) path.lineTo(coords[i][0], -coords[i][1]);
    if (close) path.closePath();
  }
  const boundaries = [new Path2D(), new Path2D()], rivers = new Path2D();
  for (const [kind, line] of atlas.boundaries) appendLine(boundaries[kind], line);
  for (const line of atlas.rivers) appendLine(rivers, line);
  const areas = new Map();
  for (const [code, polygons] of Object.entries(atlas.areas)) {
    const path = new Path2D();
    for (const polygon of polygons) for (const ring of polygon) appendLine(path, ring, true);
    areas.set(code, path);
  }

  // A great-circle connection joins representative country points. UNHCR provides no journey geometry.
  function unitVector(place) {
    const lon = place.lon * DEG, lat = place.lat * DEG, c = Math.cos(lat);
    return [c * Math.cos(lon), c * Math.sin(lon), Math.sin(lat)];
  }
  function connection(a, b) {
    const p = unitVector(a), q = unitVector(b);
    const angle = Math.acos(clamp(p.reduce((sum, v, i) => sum + v*q[i], 0), -1, 1));
    const sine = Math.sin(angle), samples = Math.max(10, Math.ceil(angle / DEG));
    const coords = [];
    for (let i = 0; i <= samples; i++) {
      const t = i / samples, s = Math.sin((1-t)*angle)/sine, u = Math.sin(t*angle)/sine;
      const [x,y,z] = p.map((v, j) => s*v + u*q[j]);
      const rawLon = Math.atan2(y, x)/DEG, previous = coords.length ? coords.at(-1)[0] : a.lon;
      coords.push([previous + wrap(rawLon-previous), Math.atan2(z, Math.hypot(x,y))/DEG]);
    }
    return coords;
  }
  for (const h of hosts) {
    h.route = connection(origin, h);
    h.path = new Path2D(); appendLine(h.path, h.route);
  }

  function setupCanvas(canvas) {
    const box = canvas.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 3);
    const w = box.width, h = box.height;
    const pw = Math.max(1, Math.round(w*dpr)), ph = Math.max(1, Math.round(h*dpr));
    if (canvas.width !== pw || canvas.height !== ph) {canvas.width = pw; canvas.height = ph;}
    const c = canvas.getContext('2d');
    c.setTransform(pw / (w || 1), 0, 0, ph / (h || 1), 0, 0);
    c.clearRect(0, 0, w, h);
    return {c, w, h};
  }
  function frame(p) {
    const {width: w, height: h} = p.canvas.getBoundingClientRect();
    const {lon, lat, span} = p.view, sx = w / span;
    const sy = sx, halfY = h / (2 * sy);
    const centerLat = clamp(lat, -90+halfY, 90-halfY);
    return {w, h, sx, sy, west: lon-span/2, east: lon+span/2, south: centerLat-halfY,
      north: centerLat+halfY, lat: centerLat, lon, span};
  }
  function projected(g, lon, lat) {
    return [g.w/2 + wrap(lon-g.lon)*g.sx, (g.north-lat)*g.sy];
  }
  function within(g, place) {
    const [x,y] = projected(g, place.lon, place.lat);
    return x >= 0 && x < g.w && y >= 0 && y < g.h;
  }
  function raster(c, g, image, bounds) {
    if (!image.complete || !image.naturalWidth) return;
    const [west,south,east,north] = bounds;
    const b = Math.max(south,g.south), t = Math.min(north,g.north);
    if (b >= t) return;
    for (let turn = Math.ceil((g.west-east)/360); turn <= Math.floor((g.east-west)/360); turn++) {
      const left = west + 360*turn, right = east + 360*turn;
      const l = Math.max(left,g.west), r = Math.min(right,g.east);
      if (r <= l) continue;
      const ix = image.naturalWidth/(east-west), iy = image.naturalHeight/(north-south);
      c.drawImage(image, (l-left)*ix, (north-t)*iy, (r-l)*ix, (t-b)*iy,
                  (l-g.west)*g.sx, (g.north-t)*g.sy, (r-l)*g.sx, (t-b)*g.sy);
    }
  }
  function geographic(c, g, draw) {
    const first = Math.floor((g.west+180)/360), last = Math.ceil((g.east+180)/360)-1;
    for (let turn = first; turn <= last; turn++) {
      c.save(); c.translate((360*turn-g.west)*g.sx, g.north*g.sy); c.scale(g.sx, g.sy);
      draw(1/g.sx); c.restore();
    }
  }
  function baseLines(c, g, active) {
    geographic(c, g, unit => {
      c.lineJoin = 'round'; c.lineCap = 'round';
      for (const code of [origin.code, active].filter(Boolean)) {
        c.fillStyle = code === origin.code ? 'rgba(148,55,47,.23)' : 'rgba(147,54,45,.19)';
        c.fill(areas.get(code), 'evenodd');
      }
      if (g.span < 100) {
        c.strokeStyle = 'rgba(241,244,241,.56)'; c.lineWidth = .6*unit;
        c.stroke(rivers);
      }
      for (let i=0; i<boundaries.length; i++) {
        if (i) c.setLineDash([2.4*unit, 1.7*unit]);
        c.strokeStyle = 'rgba(48,45,42,.52)'; c.lineWidth = (g.span<100 ? 1.6 : .85)*unit;
        c.stroke(boundaries[i]);
        c.strokeStyle = g.span<100 ? 'rgba(253,250,241,.87)' : 'rgba(252,251,242,.64)';
        c.lineWidth = (g.span<100 ? .85 : .45)*unit; c.stroke(boundaries[i]);
      }
      c.setLineDash([]);
      c.strokeStyle = 'rgba(255,248,238,.97)'; c.lineWidth = (g.span<100 ? 1.9 : 1.05)*unit;
      c.stroke(areas.get(origin.code));
      c.strokeStyle = RED; c.lineWidth = (g.span<100 ? .9 : .6)*unit; c.stroke(areas.get(origin.code));
    });
  }
  const STEPS = [.25,.5,1,2,5,10,15,30,45,60,90,180];
  function interval(raw) { return STEPS.find(n => n >= raw) || 180; }
  function degrees(v, lat) {
    const angle = lat ? v : wrap(v), n = Math.abs(Math.round(angle*10)/10);
    const sign = !n || (!lat && n===180) ? '' : lat ? (angle>0 ? 'N' : 'S') : (angle>0 ? 'E' : 'W');
    return n + '°' + sign;
  }
  function graticule(p, c, g) {
    const xStep = interval(fonts.px * 8.2 / g.sx), yStep = interval(fonts.px * 4.6 / g.sy);
    const xAxis = setupCanvas(p.xAxis), yAxis = setupCanvas(p.yAxis);
    const top = p === world;
    c.save(); c.lineWidth = .55; c.strokeStyle = 'rgba(255,255,255,.48)'; c.beginPath();
    for (const axis of [xAxis,yAxis]) {
      axis.c.font = font(); axis.c.fillStyle = INK; axis.c.strokeStyle = '#6e6a65'; axis.c.lineWidth = .55;
    }
    xAxis.c.beginPath(); xAxis.c.textBaseline = top ? 'bottom' : 'top'; xAxis.c.textAlign = 'center';
    for (let i=Math.ceil(4*g.west/xStep); i<=Math.floor(4*g.east/xStep); i++) {
      const lon = i*xStep/4, x = (lon-g.west)*g.sx, major = i%4===0;
      const tick = major ? 4 : 2, edge = top ? xAxis.h : 0, dir = top ? -1 : 1;
      xAxis.c.moveTo(x,edge); xAxis.c.lineTo(x,edge+dir*tick);
      if (!major) continue;
      c.moveTo(x,0); c.lineTo(x,g.h);
      if (x > 1.55*fonts.px && x < g.w-1.55*fonts.px) xAxis.c.fillText(degrees(lon,false), x, edge+dir*5);
    }
    xAxis.c.stroke();
    yAxis.c.beginPath(); yAxis.c.textBaseline = 'middle'; yAxis.c.textAlign = 'center';
    for (let i=Math.ceil(4*g.south/yStep); i<=Math.floor(4*g.north/yStep); i++) {
      const lat = i*yStep/4, y = (g.north-lat)*g.sy, major=i%4===0;
      yAxis.c.moveTo(yAxis.w,y); yAxis.c.lineTo(yAxis.w-(major ? 4 : 2),y);
      if (!major) continue;
      c.moveTo(0,y); c.lineTo(g.w,y);
      if (y < 1.5*fonts.px || y > g.h-1.5*fonts.px) continue;
      yAxis.c.save(); yAxis.c.translate(yAxis.w-6-fonts.px/2,y); yAxis.c.rotate(-Math.PI/2);
      yAxis.c.fillText(degrees(lat,true),0,0); yAxis.c.restore();
    }
    yAxis.c.stroke(); c.stroke(); c.restore();
  }
  function drawNetwork(c, g, links, active) {
    const factor = fonts.px/10;
    geographic(c, g, unit => {
      c.lineCap = 'round'; c.lineJoin = 'round';
      const draw = (h, focused) => {
        const width = (linkWeight(h.people) + (focused ? .8 : 0))*factor*unit;
        c.globalAlpha = active && !focused ? .25 : 1;
        c.strokeStyle = 'rgba(255,249,235,.86)'; c.lineWidth = width + 1.35*factor*unit; c.stroke(h.path);
        c.strokeStyle = focused ? '#762720' : RED; c.lineWidth = width; c.stroke(h.path);
      };
      for (let i=links.length-1; i>=0; i--) if (links[i].code!==active) draw(links[i],false);
      const selectedLink = links.find(h=>h.code===active);
      if (selectedLink) draw(selectedLink,true);
    });
  }
  function drawRegionBox(c, g) {
    if (g.span < 150) return;
    const detail = frame(region);
    geographic(c, g, unit => {
      const args = [detail.west, -detail.north, detail.east-detail.west, detail.north-detail.south];
      c.setLineDash([3.2*unit, 2.1*unit]); c.lineWidth = .8*unit; c.strokeStyle = 'rgba(255,255,255,.9)';
      c.strokeRect(...args);
    });
  }
  const preferred = {SSD:['nw','sw','ne'], UGA:['s','sw','w'], SDN:['ne','nw','e'], ETH:['e','ne'],
    KEN:['se','e'], COD:['w','nw'], CAF:['nw','w'], EGY:['e','ne'], FRA:['w','sw'], GBR:['nw','w'],
    SWE:['ne','e'], NOR:['nw','w'], RWA:['w'], BDI:['s'], ERI:['ne'], USA:['sw'], CAN:['w'], MYS:['se']};
  const directions = {e:[1,0], ne:[1,-1], n:[0,-1], nw:[-1,-1], w:[-1,0], sw:[-1,1], s:[0,1], se:[1,1]};
  const overlaps = (a,b) => a.x < b.x+b.w && a.x+a.w > b.x && a.y < b.y+b.h && a.y+a.h > b.y;
  const globalLabels = ['CAN','USA','MEX','ISL','SWE','FRA','EGY','IND','MYS','AUS','ZWE','GBR','MAR','NGA','LBR'];
  const detailLabels = ['SDN','ETH','UGA','KEN','COD','CAF','EGY','TCD','SOM','ERI','RWA','COG','BDI','CMR','NER'];
  function annotations(p, c, g, links, active) {
    const fs=fonts.px, factor=fs/10, isDetail=p===region || g.span<100;
    const nodes = [...links.filter(h=>within(g,h)).reverse(), ...(within(g,origin) ? [origin] : [])];
    const heading=p.el.querySelector('h2');
    const markerBoxes=[], occupied=[{x:0,y:0,w:heading.offsetLeft+heading.offsetWidth+4,h:heading.offsetTop+heading.offsetHeight+3}];
    p.hits=[]; c.save(); c.font=font(); c.lineJoin='round';
    for (const n of nodes) {
      const src=n===origin, focused=n.code===active, [x,y]=projected(g,n.lon,n.lat);
      const r=(src ? 4.3 : radius(n.people))*factor;
      c.globalAlpha = active && !src && !focused ? .58 : 1;
      if (focused && !src) {
        c.beginPath(); c.arc(x,y,r+2.7*factor,0,2*Math.PI);
        c.strokeStyle='#fff'; c.lineWidth=1.5; c.stroke(); c.strokeStyle=RED; c.lineWidth=.65; c.stroke();
      }
      c.beginPath();
      if (src) {c.moveTo(x,y-r*1.18); c.lineTo(x+r*1.18,y); c.lineTo(x,y+r*1.18); c.lineTo(x-r*1.18,y); c.closePath();}
      else c.arc(x,y,r,0,Math.PI*2);
      c.fillStyle=src ? RED : '#fffaf2'; c.fill();
      c.strokeStyle=src ? '#fff9f0' : RED; c.lineWidth=(src ? 1.4 : 1.05)*factor; c.stroke();
      markerBoxes.push({code:n.code,x:x-r-1,y:y-r-1,w:2*r+2,h:2*r+2});
      p.hits.push({code:n.code,x,y,r:Math.max(6,r+3)});
    }
    c.globalAlpha=1;
    const first = active ? [active,origin.code] : [origin.code];
    const candidateCodes=Array.from(new Set([...first, ...(isDetail ? detailLabels : globalLabels),
      ...(p===world && g.span<150 ? nodes.map(n=>n.code) : [])]));
    for (const code of candidateCodes) {
      const n=code===origin.code ? origin : byCode.get(code);
      if (!n || !nodes.includes(n)) continue;
      const focal=code===active, src=n===origin;
      const [x,y]=projected(g,n.lon,n.lat);
      const lines=[n.name];
      if (!src && (focal || (isDetail && n.people>=25000))) lines.push(fmt.format(n.people));
      const width=Math.max(...lines.map(s=>c.measureText(s).width)), lineH=fs*1.23, height=lines.length*lineH;
      const choices=Array.from(new Set([...(preferred[code] || ['e','w']), ...Object.keys(directions)]));
      let label;
      for (const gap of [1,2.35,3.7]) {
        const off=(src ? 4.6 : radius(n.people))*factor + gap*fs*.64;
        for (const d of choices) {
          const [dx,dy]=directions[d];
          const left=x+dx*off + (dx<0 ? -width : dx===0 ? -width/2 : 0);
          const top=y+dy*off + (dy<0 ? -height : dy===0 ? -height/2 : 0);
          const b={x:left-2, y:top-1, w:width+4, h:height+2};
          if (b.x<3 || b.y<3 || b.x+b.w>g.w-3 || b.y+b.h>g.h-3 || occupied.some(box=>overlaps(b,box))) continue;
          if (markerBoxes.some(m=>m.code!==code && overlaps(b,m))) continue;
          label={box:b,left,top,leader:gap>1}; break;
        }
        if (label) break;
      }
      // A selected European host can be surrounded on all sides. Reserve the
      // closest clear space along the paper's map edge and lead back to its node.
      if (!label && (focal || src)) {
        const xs=[5,clamp(x-width/2,5,g.w-width-5),g.w-width-5];
        const ys=[5,clamp(y-height/2,5,g.h-height-5),g.h-height-5];
        const choices=xs.flatMap(left=>ys.map(top=>({left,top,leader:true,
          box:{x:left-2,y:top-1,w:width+4,h:height+2},
          distance:Math.hypot(left+width/2-x,top+height/2-y)})));
        label=choices.filter(choice=>choice.distance>fs*1.4 && !occupied.some(b=>overlaps(b,choice.box)))
                     .sort((a,b)=>a.distance-b.distance)[0];
      }
      if (!label) continue;
      const {box,left,top,leader}=label;
      occupied.push(box); p.hits.push({code,box});
      if (leader) {
        c.beginPath(); c.moveTo(x,y); c.lineTo(clamp(x,left,left+width),clamp(y,top,top+height));
        c.strokeStyle='rgba(255,255,248,.86)'; c.lineWidth=.65; c.stroke();
      }
      c.globalAlpha=active && !focal && !src ? .67 : 1;
      c.textAlign='left'; c.textBaseline='middle'; c.strokeStyle='rgba(39,36,33,.85)'; c.lineWidth=2.2*factor;
      c.fillStyle=PAPER;
      lines.forEach((line,i)=>{const ly=top+(i+.5)*lineH; c.strokeText(line,left,ly); c.fillText(line,left,ly);});
      c.globalAlpha=1;
    }
    const water=isDetail ? [['Red Sea',40.7,16.6],['Indian Ocean',53,-1.2],['Lake Victoria',32.9,-1.1]] :
      [['Pacific Ocean',-135,-8],['Atlantic Ocean',-32,-17],['Indian Ocean',80,-22]];
    c.textAlign='center'; c.textBaseline='middle'; c.fillStyle='rgba(255,255,251,.83)';
    for (const [s,lon,lat] of water) {
      const [x,y]=projected(g,lon,lat), w=c.measureText(s).width+4, b={x:x-w/2,y:y-fs*.65,w,h:fs*1.3};
      if (b.x<3 || b.y<3 || b.x+b.w>g.w-3 || b.y+b.h>g.h-3 || [...occupied,...markerBoxes].some(o=>overlaps(b,o))) continue;
      c.fillText(s,x,y);
    }
    c.restore();
  }
  function drawPanel(p) {
    const g=frame(p), {c,w,h}=setupCanvas(p.canvas);
    if (!w || !h) return;
    const active=hover || selected;
    c.fillStyle='#464646'; c.fillRect(0,0,w,h);
    raster(c,g,...photos[0]);
    if (p===region || g.span<=105) raster(c,g,...photos[1]);
    baseLines(c,g,active); graticule(p,c,g);
    const links=p===world ? hosts : hosts.filter(n=>within(g,n));
    drawNetwork(c,g,links,active);
    if (p===world) drawRegionBox(c,g);
    annotations(p,c,g,links,active);
  }
  function drawScale() {
    const g=frame(region), {c,w,h}=setupCanvas($('scale'));
    const kmPx=6371.0088*DEG*Math.cos(g.lat*DEG)/g.sx;
    const room=w-4*fonts.px, raw=room*kmPx/5;
    if (raw<=0) return;
    const power=10**Math.floor(Math.log10(raw));
    const step=[1,2,2.5,5,10].filter(v=>v*power<=raw).at(-1)*power;
    const unit=step/kmPx, count=Math.min(6,Math.floor(room/unit+1e-8)-1), length=(count+1)*unit;
    const start=(w-length)/2, zero=start+unit, base=h-4;
    c.strokeStyle=INK; c.fillStyle=INK; c.lineWidth=.65; c.strokeRect(start,base-1.5,length,1.5);
    for (let j=0;j<5;j+=2) c.fillRect(start+unit*j/5,base-1.5,unit/5,1.5);
    for (let j=0;j<count;j+=2) c.fillRect(zero+unit*j,base-1.5,unit,1.5);
    c.font=font(); c.textAlign='center'; c.textBaseline='bottom'; c.beginPath();
    for (let j=-1;j<=count;j++) {
      const x=zero+j*unit; c.moveTo(x,base+.6); c.lineTo(x,base-4);
      c.fillText(String(Math.abs(j)*step),x,base-4);
    }
    c.stroke(); $('scale').setAttribute('aria-label',`East Africa inset scale at the central parallel, ${step} kilometres per major division`);
  }
  function drawLocators() {
    const main=frame(world), inset=frame(region);
    for (const [id,lon0,lat0] of [['world-home',-55,20],['region-home',32,9]]) {
      const {c,w,h}=setupCanvas($(id).querySelector('canvas'));
      const r=w/2, phi=lat0*DEG;
      function ortho(lon,lat) {
        const l=(lon-lon0)*DEG, b=lat*DEG, depth=Math.sin(phi)*Math.sin(b)+Math.cos(phi)*Math.cos(b)*Math.cos(l);
        return depth < 0 ? null : [r+r*Math.cos(b)*Math.sin(l),h/2-r*(Math.cos(phi)*Math.sin(b)-Math.sin(phi)*Math.cos(b)*Math.cos(l))];
      }
      function outline(g,color) {
        c.beginPath(); let pen=false;
        for (const [l0,b0,l1,b1] of [[g.west,g.north,g.east,g.north],[g.east,g.north,g.east,g.south],[g.east,g.south,g.west,g.south],[g.west,g.south,g.west,g.north]]) {
          const steps=Math.max(2,Math.ceil(Math.max(Math.abs(l0-l1),Math.abs(b0-b1))/3));
          for (let i=0;i<=steps;i++) {
            const a=ortho(l0+(l1-l0)*i/steps,b0+(b1-b0)*i/steps);
            if (a) {if (pen) c.lineTo(...a); else c.moveTo(...a);}
            pen=Boolean(a);
          }
        }
        c.strokeStyle=color; c.lineWidth=.85; c.stroke();
      }
      if (main.span<340) outline(main,'#fff8f1');
      if (id==='region-home') outline(inset,'#ffd6cc');
      const n=byCode.get(hover||selected) || origin, pt=ortho(n.lon,n.lat);
      if (pt) {c.beginPath(); c.arc(...pt,1.5,0,Math.PI*2); c.fillStyle=RED; c.fill(); c.strokeStyle=PAPER; c.lineWidth=.65; c.stroke();}
    }
  }
  function redraw() {
    if (scheduled) return;
    scheduled=true;
    requestAnimationFrame(()=>{
      scheduled=false;
      $('world-heading').textContent=world.view.span>=345 ? 'Global asylum network' : 'Asylum network';
      drawPanel(world); drawPanel(region); drawScale(); drawLocators();
    });
  }
  function fitSheet() {
    const sheet=document.querySelector('.sheet'), notes=document.querySelector('.note-space'), css=getComputedStyle(sheet);
    const width=sheet.clientWidth-parseFloat(css.paddingLeft)-parseFloat(css.paddingRight);
    const height=sheet.clientHeight-parseFloat(css.paddingTop)-parseFloat(css.paddingBottom);
    const sideBySide=css.flexDirection==='row'; sheet.toggleAttribute('data-foot',!sideBySide);
    fonts.px=parseFloat(css.fontSize); fonts.family=css.fontFamily;
    // English country names can wrap. End the printed index at a complete row.
    function fitIndex() {
      const scroller=$('hosts').closest('.register-scroll');
      const tableTop=scroller.querySelector('table').getBoundingClientRect().top;
      const rowBottom=$('hosts').rows[6].getBoundingClientRect().bottom;
      scroller.style.blockSize=Math.ceil(rowBottom-tableTop)+'px';
    }
    let side;
    fitIndex();
    if (sideBySide) side=Math.min(height,width-notes.getBoundingClientRect().width-parseFloat(css.columnGap),1340);
    else {
      const room=height-parseFloat(css.rowGap), minFooter=Math.min(width,(width>=550 ? 64 : 31)*fonts.px);
      let footer=Math.min(width,1340);
      for (let pass=0;pass<4;pass++) {
        notes.style.setProperty('--foot-width',footer+'px');
        fitIndex();
        side=Math.min(width,room-notes.getBoundingClientRect().height,1340);
        const next=Math.max(minFooter,Math.floor(side));
        if (next>=footer-1) break;
        footer=next;
      }
    }
    sheet.style.setProperty('--side',Math.max(1,Math.floor(side))+'px'); redraw();
  }
  function setView(v) {
    const span=clamp(v.span,12,360), ratio=world.canvas.clientHeight/(world.canvas.clientWidth||1);
    const halfY=Math.min(90,span*ratio/2);
    world.view={span,lon:wrap(v.lon),lat:clamp(v.lat,-90+halfY,90-halfY)}; redraw();
  }
  function stopFlight() { if (flight) cancelAnimationFrame(flight); flight=0; }
  function fly(v) {
    stopFlight();
    if (reduced.matches) {setView(v); return;}
    const from={...world.view}, start=performance.now(), delta=wrap(v.lon-from.lon);
    function step(now) {
      const t=clamp((now-start)/430,0,1), u=t*t*(3-2*t);
      setView({lon:from.lon+u*delta,lat:from.lat+u*(v.lat-from.lat),span:from.span*(v.span/from.span)**u});
      flight=t<1 ? requestAnimationFrame(step) : 0;
    }
    flight=requestAnimationFrame(step);
  }
  function focusRoute(h) {
    const xs=h.route.map(q=>q[0]), ys=h.route.map(q=>q[1]);
    const l=Math.min(...xs), r=Math.max(...xs), b=Math.min(...ys), t=Math.max(...ys);
    const ratio=world.canvas.clientWidth/(world.canvas.clientHeight||1);
    fly({lon:(l+r)/2, lat:(b+t)/2, span:clamp(1.55*Math.max(r-l,(t-b)*ratio),21,360)});
  }
  function select(code,{focus=false,reveal=false}={}) {
    const previous=byCode.get(selected);
    if (previous) previous.row.removeAttribute('aria-current');
    selected=code===origin.code ? null : code; hover=null;
    const h=byCode.get(selected);
    if (h) {
      h.row.setAttribute('aria-current','true');
      if (reveal) {
        const scroller=h.row.closest('.register-scroll'), row=h.row.getBoundingClientRect(), box=scroller.getBoundingClientRect();
        const header=scroller.querySelector('thead').getBoundingClientRect().height;
        if (row.top<box.top+header || row.bottom>box.bottom) scroller.scrollTop+=row.top-box.top-box.height/2;
      }
      if (focus) focusRoute(h);
      $('announcement').textContent=`${h.name}, ${fmt.format(h.people)} refugees, ${pct(h.people)} of the global total`;
    } else $('announcement').textContent=`All ${hosts.length} countries of asylum, ${fmt.format(atlas.total)} refugees`;
    redraw();
  }
  function reset(v) {select(null); fly(v);}
  $('world-home').addEventListener('click',()=>reset(fullView));
  $('region-home').addEventListener('click',()=>reset(detailView));
  $('hosts').addEventListener('click',e=>{const row=e.target.closest('tr'); if (row) select(row.dataset.code,{focus:true});});
  const local=(p,e)=>{const b=p.canvas.getBoundingClientRect(); return {x:e.clientX-b.left,y:e.clientY-b.top};};
  function hit(p,xy) {
    let closest=null, distance=Infinity;
    for (const h of p.hits) {
      if (h.box) continue;
      const d=Math.hypot(xy.x-h.x,xy.y-h.y);
      if (d<=h.r && d<distance) {distance=d; closest=h.code;}
    }
    return closest || p.hits.find(h=>h.box && overlaps(h.box,{...xy,w:1,h:1}))?.code || null;
  }
  function probe(p,e) {
    if (e.pointerType==='touch') return;
    const code=hit(p,local(p,e)); p.el.toggleAttribute('data-hit',Boolean(code));
    const next=code===origin.code ? null : code;
    if (next!==hover) {hover=next; redraw();}
  }
  for (const p of [world,region]) p.el.addEventListener('pointerleave',()=>{
    p.el.removeAttribute('data-hit'); if (hover) {hover=null; redraw();}
  });
  region.el.addEventListener('pointermove',e=>probe(region,e));
  region.el.addEventListener('click',e=>{const code=hit(region,local(region,e)); select(code,{reveal:true});});

  function zoomAt(x,y,factor) {
    const g=frame(world), next=clamp(g.span*factor,12,360), rel=next/g.span;
    setView({span:next,lon:g.lon+(x-g.w/2)/g.sx*(1-rel),lat:g.lat-(y-g.h/2)/g.sy*(1-rel)});
  }
  world.el.addEventListener('wheel',e=>{
    e.preventDefault(); stopFlight(); hover=null;
    const {x,y}=local(world,e), delta=e.deltaY*(e.deltaMode===1 ? 16 : e.deltaMode===2 ? world.canvas.clientHeight : 1);
    zoomAt(x,y,Math.exp(clamp(delta,-600,600)*.0017));
  },{passive:false});
  world.el.addEventListener('dblclick',e=>{stopFlight();const {x,y}=local(world,e);zoomAt(x,y,.5);});
  const pointers=new Map(); let gesture=null;
  function restartGesture(moved) {
    const pts=Array.from(pointers.values());
    if (!pts.length) {gesture=null; return;}
    const a=pts[0], b=pts[1] || a;
    gesture={g:frame(world),x:(a.x+b.x)/2,y:(a.y+b.y)/2,dist:Math.hypot(a.x-b.x,a.y-b.y),moved};
  }
  world.el.addEventListener('pointerdown',e=>{
    if (e.button!==0) return;
    stopFlight(); world.el.focus({preventScroll:true});
    pointers.set(e.pointerId,local(world,e)); world.el.setPointerCapture(e.pointerId);
    restartGesture(pointers.size>1); hover=null;
  });
  world.el.addEventListener('pointermove',e=>{
    if (!pointers.has(e.pointerId)) {probe(world,e); return;}
    pointers.set(e.pointerId,local(world,e));
    const pts=Array.from(pointers.values()), a=pts[0], b=pts[1]||a;
    const x=(a.x+b.x)/2, y=(a.y+b.y)/2, g=gesture.g;
    if (Math.hypot(x-gesture.x,y-gesture.y)>3 || pts.length>1) gesture.moved=true;
    if (!gesture.moved) return;
    world.el.removeAttribute('data-hit'); world.el.classList.add('dragging');
    const dist=Math.hypot(a.x-b.x,a.y-b.y);
    const span=clamp(pts.length>1 && dist>0 ? g.span*gesture.dist/dist : g.span,12,360);
    const sx=g.w/span;
    setView({span,lon:g.lon+(gesture.x-g.w/2)/g.sx-(x-g.w/2)/sx,lat:g.lat-(gesture.y-g.h/2)/g.sy+(y-g.h/2)/sx});
  });
  function endGesture(e,cancelled) {
    if (!pointers.has(e.pointerId)) return;
    const activate=!cancelled && !gesture.moved && pointers.size===1;
    pointers.delete(e.pointerId); restartGesture(true);
    if (!pointers.size) world.el.classList.remove('dragging');
    if (activate) select(hit(world,local(world,e)),{reveal:true});
  }
  world.el.addEventListener('pointerup',e=>endGesture(e,false));
  world.el.addEventListener('pointercancel',e=>endGesture(e,true));
  world.el.addEventListener('lostpointercapture',e=>endGesture(e,true));
  world.el.addEventListener('keydown',e=>{
    const g=frame(world), k=e.key;
    if (!['Home','Escape','+','=','-','_','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(k)) return;
    e.preventDefault(); stopFlight(); hover=null;
    if (k==='Home') reset(fullView);
    else if (k==='Escape') select(null);
    else if (['+','=','-','_'].includes(k)) zoomAt(g.w/2,g.h/2,['+','='].includes(k) ? .72 : 1/.72);
    else {
      const step=g.span*(e.shiftKey ? .25 : .085);
      setView({span:g.span,lon:g.lon+(k==='ArrowLeft' ? -step : k==='ArrowRight' ? step : 0),
        lat:g.lat+(k==='ArrowUp' ? step : k==='ArrowDown' ? -step : 0)});
    }
  });
  region.el.addEventListener('keydown',e=>{
    if (e.key==='Enter' || e.key===' ') {e.preventDefault(); reset(detailView); world.el.focus({preventScroll:true});}
    if (e.key==='Escape') select(null);
  });
  window.addEventListener('resize',fitSheet);
  window.visualViewport?.addEventListener('resize',fitSheet);
  for (const [img] of photos) img.addEventListener('load',redraw);
  fitSheet(); document.fonts.ready.then(fitSheet);
})();
