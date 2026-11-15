(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const data = VOYAGER;
  const map = $('map'), labelLayer = $('map-labels');
  const tau = 2 * Math.PI, rad = Math.PI / 180;
  const ink = '#232321', paper = '#f5f3ec', accent = '#e3a29a', ground = '#242624';
  const bodyGM = [22032, 324859, 398600, 42828, 126686532, 37931207, 5793951, 6835100];
  const origin = Date.UTC(1977,7,20);
  const formatDate = new Intl.DateTimeFormat('en-GB',{day:'2-digit',month:'short',year:'numeric',timeZone:'UTC'});
  const dateAt = t => formatDate.format(origin + t * 86400000);
  const clamp = (v,a,b) => Math.max(a, Math.min(b,v));
  const add = (a,b) => a.map((v,i) => v + b[i]);
  const mult = (a,s) => a.map(v => v*s);
  const dot = (a,b) => a.reduce((sum,v,i) => sum+v*b[i],0);
  const cross = (a,b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const norm = a => Math.hypot(...a);
  const unit = a => mult(a,1/norm(a));
  const num = (v, digits=2) => Number(v.toFixed(digits)).toLocaleString('en-US',{maximumFractionDigits:digits});
  const presets = {flight:{x:-.8, y:-15.1, span:44.5}, system:{x:0,y:0,span:70}};
  let camera = {...presets.flight}, view = 'flight', selected = 0, compare = true;
  let W = 1, size = 10, font = '', pending = false;
  let epochBodies = [], localMoons = [];
  let buttons = new Map(), placed = [];
  const hits = [];
  const isLocal = () => view === 'encounter';
  const event = () => data.encounters[selected];
  const project = p => [W*(.5+(p[0]-camera.x)/camera.span), W*(.5-(p[1]-camera.y)/camera.span)];
  const world = (x,y) => [camera.x+(x/W-.5)*camera.span,camera.y+(.5-y/W)*camera.span];
  const inner = (x,y,pad=0) => x>=-pad && y>=-pad && x<=W+pad && y<=W+pad;

  function interval(rows,time) {
    let lo=0, hi=rows.length-1;
    while(hi-lo>1) {
      const mid=(hi+lo)>>1;
      if(rows[mid][0]<=time) lo=mid; else hi=mid;
    }
    return [rows[lo],rows[hi]];
  }
  function stateAt(rows,time) {
    const [a,b]=interval(rows,time), h=b[0]-a[0], u=clamp((time-a[0])/h,0,1), u2=u*u;
    const p=[], v=[];
    for(let i=1;i<=3;i++) {
      // Hermite position and analytical derivative use the same interval.
      const d=b[i]-a[i], m=a[i+3]*h, n=b[i+3]*h;
      p.push(a[i] + u*(m + u*(3*d-2*m-n + u*(m+n-2*d))));
      v.push((m + 2*u*(3*d-2*m-n) + 3*u2*(m+n-2*d))/h);
    }
    return {p,v};
  }
  function ellipse(a,e,P,Q) {
    // Eccentric-anomaly form with the attracting body at the focus.
    const u=mult(P,a), v=mult(Q,a*Math.sqrt(1-e*e));
    return {cx:-e*u[0],cy:-e*u[1], ux:u[0],uy:u[1],vx:v[0],vy:v[1]};
  }
  function fromElements(row) {
    const [,a,e,inc,node,omega,anomaly]=row;
    const c=Math.cos(node*rad),s=Math.sin(node*rad),ci=Math.cos(inc*rad),si=Math.sin(inc*rad);
    const cp=Math.cos(omega*rad),sp=Math.sin(omega*rad);
    const P=[c*cp-s*sp*ci,s*cp+c*sp*ci,sp*si], Q=[-c*sp-s*cp*ci,-s*sp+c*cp*ci,cp*si];
    const orbit=ellipse(a,e,P,Q);
    if(anomaly===undefined) return orbit;
    const f=anomaly*rad, r=a*(1-e*e)/(1+e*Math.cos(f));
    const position=add(mult(P,r*Math.cos(f)),mult(Q,r*Math.sin(f)));
    return {name:row[0],orbit,p:position};
  }
  function orbitAt(p,v,gm) {
    const h=cross(p,v), r=norm(p);
    const ev=add(mult(cross(v,h),1/gm),mult(p,-1/r)), e=norm(ev), a=1/(2/r-dot(v,v)/gm);
    const P=unit(ev), Q=cross(unit(h),P);
    return ellipse(a,e,P,Q);
  }
  const minorOrbits=data.minor.map(fromElements);
  const encounters=data.encounters.map(e => stateAt(data.route,e.ca).p);
  const route=data.route.map(row=>row.slice(1,4));
  const bodyName = () => data.planets[event().body].name;
  function refreshEpoch() {
    epochBodies=data.planets.map((body,i)=>{
      const {p,v}=stateAt(body.states,event().ca);
      const gm=data.mu + bodyGM[i]*86400**2/data.au**3;
      return {...body,p,orbit:orbitAt(p,v,gm)};
    });
    localMoons=event().moons.map(fromElements);
  }

  function surface(canvas) {
    const w=canvas.clientWidth,h=canvas.clientHeight,dpr=Math.min(window.devicePixelRatio||1,3);
    const pw=Math.max(1,Math.round(w*dpr)), ph=Math.max(1,Math.round(h*dpr));
    if(canvas.width!==pw || canvas.height!==ph) {canvas.width=pw; canvas.height=ph;}
    const ctx=canvas.getContext('2d');
    ctx.setTransform(pw/Math.max(w,1),0,0,ph/Math.max(h,1),0,0);
    ctx.clearRect(0,0,w,h); ctx.font=font;
    return ctx;
  }
  function orbitPath(ctx,o,projection,pixelsPerAU,color,width) {
    const [x,y]=projection([o.cx,o.cy]);
    const radiusX=Math.hypot(o.ux,o.vx)*pixelsPerAU, radiusY=Math.hypot(o.uy,o.vy)*pixelsPerAU;
    if(x+radiusX<0 || y+radiusY<0 || x-radiusX>ctx.canvas.clientWidth || y-radiusY>ctx.canvas.clientHeight) return;
    ctx.beginPath();
    ctx.save();ctx.translate(x,y);
    ctx.transform(o.ux*pixelsPerAU,-o.uy*pixelsPerAU,o.vx*pixelsPerAU,-o.vy*pixelsPerAU,0,0);
    ctx.arc(0,0,1,0,tau);ctx.restore();
    ctx.strokeStyle=color;ctx.lineWidth=width;ctx.stroke();
  }
  function line(ctx,a,b,color,width=1) {
    ctx.beginPath();ctx.moveTo(...a);ctx.lineTo(...b);ctx.strokeStyle=color;ctx.lineWidth=width;ctx.stroke();
  }
  function circle(ctx,x,y,r,fill,stroke,width=.8) {
    ctx.beginPath();ctx.arc(x,y,r,0,tau);
    if(fill) {ctx.fillStyle=fill;ctx.fill();}
    if(stroke) {ctx.strokeStyle=stroke;ctx.lineWidth=width;ctx.stroke();}
  }
  function trace(ctx,points,offset,projection,pixels,color,width,dash=[]) {
    // Subpixel samples may be skipped, while all visible bends retain vertices.
    let last=null;
    ctx.beginPath();
    for(let i=0;i<points.length;i++){
      const row=points[i], p=projection([row[offset],row[offset+1]]);
      if(!last) ctx.moveTo(...p);
      else if(i!==points.length-1 && Math.abs(p[0]-last[0])+Math.abs(p[1]-last[1])<pixels) continue;
      else ctx.lineTo(...p);
      last=p;
    }
    ctx.lineWidth=width;ctx.lineJoin='round';ctx.lineCap='round';ctx.strokeStyle=color;
    ctx.setLineDash(dash);ctx.stroke();ctx.setLineDash([]);
  }
  function nice(v) {
    const base=10**Math.floor(Math.log10(Math.max(v,1e-12)));
    return [1,2,5,10].reduce((a,b)=>Math.abs(Math.log(b*base/v))<Math.abs(Math.log(a*base/v))?b:a)*base;
  }
  function axis(vertical,step,factor,units) {
    const canvas=$(vertical?'y-axis':'x-axis'), ctx=surface(canvas), ticks=[];
    const mid=(vertical?camera.y:camera.x)*factor, span=camera.span*factor;
    const start=mid-span/2, end=mid+span/2;
    ctx.strokeStyle='#777';ctx.lineWidth=.65;ctx.fillStyle=ink;ctx.textAlign='center';ctx.textBaseline='middle';ctx.beginPath();
    const gutter=vertical?canvas.clientWidth:canvas.clientHeight;
    for(let i=Math.ceil(start/step*10-1e-8);i<=Math.floor(end/step*10+1e-8);i++){
      const value=i*step/10, pos=(vertical?(end-value):(value-start))/span*W;
      const major=i%10===0, len=major?6:i%5===0?4:2;
      if(vertical){ctx.moveTo(gutter,pos);ctx.lineTo(gutter-len,pos);}
      else {ctx.moveTo(pos,0);ctx.lineTo(pos,len);}
      if(!major) continue;
      ticks.push(pos);
      const label=num(value,Math.min(8,Math.max(0,-Math.floor(Math.log10(step)))))+' '+units;
      const half=ctx.measureText(label).width/2+2;
      if(pos<half || pos>W-half) continue;
      ctx.save();
      const inset=Math.min(7+size*.56,gutter-size*.65-1);
      if(vertical){ctx.translate(gutter-inset,pos);ctx.rotate(-Math.PI/2);} else ctx.translate(pos,inset);
      ctx.fillText(label,0,0);ctx.restore();
    }
    ctx.stroke();return ticks;
  }
  function axes(ctx,factor,units) {
    const step=nice(camera.span*factor/4.2);
    const xs=axis(false,step,factor,units), ys=axis(true,step,factor,units);
    ctx.beginPath();
    for(const x of xs){ctx.moveTo(x,0);ctx.lineTo(x,W);}
    for(const y of ys){ctx.moveTo(0,y);ctx.lineTo(W,y);}
    ctx.strokeStyle='#535651';ctx.lineWidth=.55;ctx.stroke();
    ctx.beginPath();
    for(const x of xs) for(const y of ys) {
      ctx.moveTo(x-2.2,y);ctx.lineTo(x+2.2,y);ctx.moveTo(x,y-2.2);ctx.lineTo(x,y+2.2);
    }
    ctx.strokeStyle='#93958c';ctx.lineWidth=.7;ctx.stroke();
  }
  function scaleBar(factor,units) {
    const canvas=$('scale'), ctx=surface(canvas), w=canvas.clientWidth,h=canvas.clientHeight;
    const kilometreSpan=camera.span*data.au;
    let title='Scale in astronomical units';
    if(units==='km'){
      const divisor=kilometreSpan>=1e6?1e6:kilometreSpan>=10000?1000:1;
      title=divisor===1e6?'Scale in millions of kilometres':divisor===1000?'Scale in thousands of kilometres':'Scale in kilometres';
      factor/=divisor;
      units=divisor===1e6?'million km':divisor===1000?'thousand km':'km';
    }
    const perPixel=camera.span*factor/W, available=w-4*size, max=available*perPixel/5;
    const power=10**Math.floor(Math.log10(max)), step=[1,2,2.5,5,10].filter(v=>v*power<=max).pop()*power;
    const px=step/perPixel, n=clamp(Math.floor(available/px+1e-8)-1,1,6);
    const length=(n+1)*px, left=(w-length)/2, zero=left+px, y=h-3;
    ctx.fillStyle=ink;ctx.strokeStyle=ink;ctx.lineWidth=.65;ctx.strokeRect(left,y-1.5,length,1.5);
    for(let j=0;j<5;j+=2) ctx.fillRect(left+j*px/5,y-1.5,px/5,1.5);
    for(let j=0;j<n;j+=2) ctx.fillRect(zero+j*px,y-1.5,px,1.5);
    ctx.textAlign='center';ctx.textBaseline='bottom';ctx.beginPath();
    const ticks=[];
    for(let j=-1;j<=n;j++) {
      const x=zero+j*px;ctx.moveTo(x,y+.5);ctx.lineTo(x,y-4);
      const label=String(Number((Math.abs(j)*step).toPrecision(5)));
      const half=ctx.measureText(label).width/2+2;
      ticks.push({x,label,left:x-half,right:x+half});
    }
    ctx.stroke();
    // Keep zero and the endpoint readable even in the narrow portrait margin.
    const occupied=[];
    for(const tick of [ticks[1],ticks.at(-1),ticks[0],...ticks.slice(2,-1)]) {
      if(occupied.some(t=>tick.left<t.right && tick.right>t.left)) continue;
      ctx.fillText(tick.label,tick.x,y-4);occupied.push(tick);
    }
    canvas.setAttribute('aria-label',num(step,6)+' '+units+' per major division');
    $('scale-title').textContent=title;
  }
  function labels(ctx,items) {
    const used=new Set(), next=[];
    labelLayer.style.font=font;
    const test=(a,b)=>a[0]<b[2] && a[2]>b[0] && a[1]<b[3] && a[3]>b[1];
    for(const item of items) {
      const [x,y]=project(item.p);
      if(!inner(x,y,2)) continue;
      const w=ctx.measureText(item.text).width, h=size+4, dy=item.offset||8;
      const offsets=[[dy+4,-h-3],[dy+4,4],[-w-dy-4,4],[-w-dy-4,-h-3],[dy+5,12],[-w-dy-5,-h-14],[1,-h-17]];
      let box;
      for(const [ox,oy] of offsets) {
        const b=[x+ox-1,y+oy,x+ox+w+2,y+oy+h];
        if(b[0]<3 || b[1]<3 || b[2]>W-3 || b[3]>W-3 || placed.some(q=>test(b,q))) continue;
        box=b;break;
      }
      if(!box) continue;
      placed.push(box);const bx=box[0]+1,by=box[1];
      const endX=bx>x?bx-2:bx+w+2,endY=by+h/2;
      line(ctx,[x,y],[endX,endY],item.leader||'#a0a299',.55);
      if(item.action) {
        used.add(item.key);let el=buttons.get(item.key);
        if(!el) {
          el=document.createElement('button');el.type='button';el.dataset.key=item.key;
          el.addEventListener('click',e=>{if(!suppressClick || e.detail===0) el.activate();});
          buttons.set(item.key,el);labelLayer.append(el);
        }
        el.activate=item.action;
        if(el.textContent!==item.text) el.textContent=item.text;
        el.setAttribute('aria-label',item.aria||item.text);
        el.style.transform='translate('+bx+'px,'+by+'px)';
      } else next.push({text:item.text,x:bx,y:by+2,color:item.color||paper});
    }
    for(const [key,el] of buttons) if(!used.has(key)){el.remove();buttons.delete(key);}
    ctx.textAlign='left';ctx.textBaseline='top';
    for(const label of next) {
      ctx.lineWidth=2.4;ctx.strokeStyle=ground;ctx.strokeText(label.text,label.x,label.y);
      ctx.fillStyle=label.color;ctx.fillText(label.text,label.x,label.y);
    }
  }
  function arrow(ctx,a,b,sz,color) {
    const angle=Math.atan2(b[1]-a[1],b[0]-a[0]), cs=Math.cos(angle),sn=Math.sin(angle);
    ctx.beginPath();ctx.moveTo(b[0]-sz*cs+sz*.46*sn,b[1]-sz*sn-sz*.46*cs);
    ctx.lineTo(...b);ctx.lineTo(b[0]-sz*cs-sz*.46*sn,b[1]-sz*sn+sz*.46*cs);
    ctx.lineWidth=1;ctx.strokeStyle=color;ctx.stroke();
  }
  function flightMap(ctx) {
    const items=[], px=W/camera.span, e=event();
    minorOrbits.forEach(o=>orbitPath(ctx,o,project,px,'#5c5e58',.56));
    epochBodies.forEach(b=>orbitPath(ctx,b.orbit,project,px,'#a1a39a',.82));
    trace(ctx,route,0,project,.2,paper,1.65);
    if(compare) trace(ctx,e.model,0,project,.15,accent,1.4,[5,3.4]);
    for(const [i,p] of encounters.entries()) {
      const [x,y]=project(p);if(!inner(x,y,8)) continue;
      const active=i===selected;
      circle(ctx,x,y,active?4.2:3.35,ground,active?accent:paper,1);
      line(ctx,[x-6,y],[x-2,y],active?accent:paper,.8);line(ctx,[x+2,y],[x+6,y],active?accent:paper,.8);
      hits.push({x,y,r:9,fn:()=>showEncounter(i)});
      const name=data.planets[data.encounters[i].body].name;
      items.push({p,key:'fly'+i,text:name+' · '+dateAt(data.encounters[i].ca).slice(-4),action:()=>showEncounter(i),aria:'Inspect '+name+' flyby'});
    }
    const last=route.at(-1);
    const endScreen=project(last);
    if(inner(...endScreen,6)) {
      arrow(ctx,project(route.at(-3)),endScreen,6,paper);
      items.push({p:last,text:'Voyager 2 · 1992'});
    }
    const first=route[0];const [fx,fy]=project(first);
    if(inner(fx,fy,4)){circle(ctx,fx,fy,2,paper);items.push({p:first,text:'Earth departure · 1977'});}
    if(compare) {
      const lastModel=e.model.at(-1), mp=project(lastModel);
      if(inner(...mp,5)) {
        arrow(ctx,project(e.model.at(-4)),mp,5,accent);
        items.push({p:lastModel,text:'Sun-only coast',color:accent,leader:accent});
      }
    }
    // A symbol floor keeps subpixel bodies findable while zoomed-out.
    function point(p,km,name,id,sun=false) {
      const [x,y]=project(p), r=Math.max(sun?3.3:2,km/data.au*px);
      if(!inner(x,y,r)) return;
      circle(ctx,x,y,r,sun?'#f4f2e9':'#c7c9bd',sun?paper:ground,.7);
      if(sun) circle(ctx,x,y,r+2.7,null,'#d6d6c9',.6);
      const fn=()=>{camera={x:p[0],y:p[1],span:Math.max(.035,Math.min(camera.span*.32,sun?3.8:1.8))};invalidate();};
      hits.push({x,y,r:Math.max(6,r+1),fn});
      if(!sun && (id===e.body || (id<4 && px<12))) return;
      items.push({p,key:'body'+id,text:name,action:fn,offset:Math.max(4,Math.min(r,25)),aria:'Center map on '+name});
    }
    point([0,0],695700,'Sun',-1,true);
    for(const [i,b] of epochBodies.entries()) point(b.p,b.radius,b.name,i);
    // Annual transverse ticks give the route a time scale independent of its orbit lines.
    for(let year=1978;year<=1991;year++){
      const t=(Date.UTC(year,0,1)-origin)/86400000,{p,v}=stateAt(data.route,t),[x,y]=project(p);
      if(!inner(x,y,4)) continue;
      const l=Math.hypot(v[0],v[1]), dx=v[1]/l*2.3,dy=v[0]/l*2.3;
      line(ctx,[x-dx,y-dy],[x+dx,y+dy],paper,.8);
    }
    labels(ctx,items);
  }
  function closeMap(ctx) {
    const e=event(), b=epochBodies[e.body], px=W/camera.span;
    for(const moon of localMoons) orbitPath(ctx,moon.orbit,project,px,'#898c83',.8);
    const [x,y]=project([0,0]), radius=b.radius/data.au*px;
    circle(ctx,x,y,Math.max(radius,2),'#b6b9af',paper,.8);
    // A true mean-radius disk and drafting center mark share the orbital focus.
    line(ctx,[x-4,y],[x+4,y],ground,.7);line(ctx,[x,y-4],[x,y+4],ground,.7);
    trace(ctx,e.local,1,project,.1,paper,1.7);
    if(compare) trace(ctx,e.local,4,project,.1,accent,1.4,[5,3.4]);
    const [a,brow]=interval(e.local,e.ca), u=(e.ca-a[0])/(brow[0]-a[0]);
    const ca=a.slice(1,4).map((v,i)=>v+u*(brow[i+1]-v)), c=project(ca);
    line(ctx,[x,y],c,'#b5b8ad',.65);circle(ctx,...c,2.7,ground,paper,1);
    const items=[{p:[0,0],text:bodyName(),offset:Math.min(28,Math.max(5,radius))},{p:ca,text:'Closest approach'}];
    for(const t of [-24,-12,-6,6,12,24,48]) {
      const [q,r]=interval(e.local,e.ca+t/24), f=(e.ca+t/24-q[0])/(r[0]-q[0]);
      const pp=q.slice(1,3).map((v,i)=>v+f*(r[i+1]-v));
      const sp=project(pp);if(!inner(...sp,3)) continue;
      arrow(ctx,project(q.slice(1,3)),project(r.slice(1,3)),4,paper);
      if(t===-12||t===12||t===24) items.push({p:pp,text:(t>0?'+':'−')+Math.abs(t)+' h'});
    }
    if(compare) {
      const visible=e.local.filter(r=>{const [a,b]=project(r.slice(4,6));return a>W*.13&&a<W*.87&&b>W*.13&&b<W*.87;});
      if(visible.length) items.push({p:visible[Math.floor(visible.length*.75)].slice(4,6),text:'Sun-only coast',color:accent,leader:accent});
    }
    for(const moon of localMoons) {
      const pt=project(moon.p);if(!inner(...pt,6)) continue;
      circle(ctx,...pt,1.65,'#c2c5ba',ground,.6);items.push({p:moon.p,text:moon.name});
    }
    labels(ctx,items);
  }
  function locators() {
    const ref=encounters[selected];
    for(const kind of ['system','flight']) {
      const canvas=$(kind).querySelector('canvas'),ctx=surface(canvas),d=canvas.clientWidth;
      const preset=presets[kind], pp=d/(preset.span*1.02);
      const projectLoc=p=>[d/2+(p[0]-preset.x)*pp,d/2-(p[1]-preset.y)*pp];
      ctx.save();ctx.beginPath();ctx.arc(d/2,d/2,d*.48,0,tau);ctx.clip();ctx.fillStyle=ground;ctx.fillRect(0,0,d,d);
      epochBodies.forEach(b=>orbitPath(ctx,b.orbit,projectLoc,pp,'#96998e',.5));
      trace(ctx,route,0,projectLoc,.45,'#fff',.85);
      const center=isLocal()?[camera.x+ref[0],camera.y+ref[1]]:[camera.x,camera.y];
      const [x,y]=projectLoc(center), width=Math.max(2,camera.span*pp);
      ctx.strokeStyle=accent;ctx.lineWidth=1;
      ctx.strokeRect(x-width/2,y-width/2,width,width);
      circle(ctx,...projectLoc(encounters[selected]),1,accent);ctx.restore();
      $(kind).setAttribute('aria-pressed',String(view===kind &&
          Math.abs(camera.span-preset.span)<.01 && Math.hypot(camera.x-preset.x,camera.y-preset.y)<.01));
    }
  }
  function paint() {
    pending=false;
    W=map.clientWidth;if(W<1) return;
    const style=getComputedStyle(document.body);
    size=parseFloat(style.fontSize);font=style.fontWeight+' '+style.fontSize+' '+style.fontFamily;
    const ctx=surface($('chart'));ctx.fillStyle=ground;ctx.fillRect(0,0,W,W);
    const km=isLocal() || camera.span<.1, factor=km?data.au:1, units=km?'km':'AU';
    hits.length=0;placed=[];
    axes(ctx,factor,units);
    if(isLocal()) closeMap(ctx); else flightMap(ctx);
    scaleBar(factor,units);locators();
    $('projection').textContent=(isLocal()?bodyName()+'-centered':'Heliocentric')+' · J2000 ecliptic';
    $('encounter').setAttribute('aria-pressed',String(isLocal()));
    $('departure').setAttribute('aria-pressed',String(view==='departure'));
    $('compare').setAttribute('aria-pressed',String(compare));
  }
  function invalidate(){if(!pending){pending=true;requestAnimationFrame(paint);}}
  function boundsCamera(points,padding) {
    const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);
    const xmin=Math.min(...xs),xmax=Math.max(...xs),ymin=Math.min(...ys),ymax=Math.max(...ys);
    return {x:(xmin+xmax)/2,y:(ymin+ymax)/2,span:Math.max(xmax-xmin,ymax-ymin)*padding};
  }
  function selectEpoch(i) {
    selected=i;refreshEpoch();
    [...$('flybys').rows].forEach((r,k)=>r.setAttribute('aria-current',String(k===selected)));
    $('epoch').textContent=bodyName()+' · '+dateAt(event().ca)+' TDB';
  }
  function showEncounter(i) {
    selectEpoch(i);view='encounter';
    const rows=event().local.filter(r=>Math.abs(r[0]-event().ca)<=.8);
    const extent=boundsCamera([[0,0],...rows.flatMap(r=>[r.slice(1,3),r.slice(4,6)])],1.36);
    camera=extent;invalidate();
  }
  function departure() {
    const e=event(), points=[encounters[selected],...e.model];
    const segment=data.route.filter(row=>row[0]>=e.modelStart && row[0]<=e.modelStart+760);
    points.push(...segment.map(row=>row.slice(1,3)));
    view='departure';camera=boundsCamera(points,1.35);invalidate();
  }
  function restore(kind){view=kind;camera={...presets[kind]};invalidate();}
  for(const [i,e] of data.encounters.entries()) {
    const name=data.planets[e.body].name, row=$('flybys').insertRow();
    const cell=row.insertCell(), b=document.createElement('button');
    b.type='button';b.textContent=name;b.setAttribute('aria-label','Inspect '+name+' encounter');
    cell.append(b);row.insertCell().textContent=dateAt(e.ca);row.insertCell().textContent=num(e.turn,1)+'°';
    row.addEventListener('click',()=>showEncounter(i));
  }
  $('system').onclick=()=>restore('system');$('flight').onclick=()=>restore('flight');
  $('encounter').onclick=()=>showEncounter(selected);$('departure').onclick=departure;
  $('compare').onclick=()=>{compare=!compare;invalidate();};
  $('method').onclick=()=>$('method-sheet').showModal();
  $('method-sheet').addEventListener('click',e=>{if(e.target===$('method-sheet')) $('method-sheet').close();});

  // Preserve the point beneath the cursor (or the pinch midpoint) as scales change.
  function zoomAt(x,y,factor,anchor=world(x,y)) {
    const limits=isLocal()?[.00025,.5]:[.003,300];
    const span=clamp(camera.span*factor,...limits);
    camera={x:anchor[0]-(x/W-.5)*span,y:anchor[1]+(y/W-.5)*span,span};invalidate();
  }
  const touches=new Map();
  let session=null, suppressClick=false, downButton=null;
  const pointerPos=e=>{const box=map.getBoundingClientRect();return [e.clientX-box.left,e.clientY-box.top];};
  function resetGesture() {
    const coords=[...touches.values()], [a,b]=coords;
    if(!a){session=null;return;}
    if(!b){session={a,cam:{...camera},moved:suppressClick};return;}
    const mid=[(a[0]+b[0])/2,(a[1]+b[1])/2];
    session={dist:Math.max(1,Math.hypot(a[0]-b[0],a[1]-b[1])),anchor:world(...mid),cam:{...camera},moved:true};
    suppressClick=true;
  }
  map.addEventListener('pointerdown',e=>{
    if(e.button!==0 || touches.size>=2) return;
    if(!touches.size) suppressClick=false;
    touches.set(e.pointerId,pointerPos(e));resetGesture();
    // A stable capture surface keeps drags alive when a label slides out of view.
    if(touches.size===1) downButton=e.target.closest('button');
    map.setPointerCapture(e.pointerId);
    if(!e.target.closest('button')) map.focus({preventScroll:true});
  });
  map.addEventListener('pointermove',e=>{
    if(!touches.has(e.pointerId)||!session) return;
    touches.set(e.pointerId,pointerPos(e));const [a,b]=touches.values();
    if(b){
      const mid=[(a[0]+b[0])/2,(a[1]+b[1])/2];
      const distance=Math.max(1,Math.hypot(a[0]-b[0],a[1]-b[1]));
      zoomAt(...mid,session.cam.span*session.dist/(camera.span*distance),session.anchor);
    } else {
      const dx=a[0]-session.a[0],dy=a[1]-session.a[1];
      if(!session.moved && Math.hypot(dx,dy)<3) return;
      session.moved=true;suppressClick=true;map.classList.add('dragging');
      camera={x:session.cam.x-dx*session.cam.span/W,y:session.cam.y+dy*session.cam.span/W,span:session.cam.span};
      invalidate();
    }
  });
  function release(e) {
    if(!touches.has(e.pointerId)) return;
    const moved=suppressClick,point=pointerPos(e);
    touches.delete(e.pointerId);resetGesture();
    if(!touches.size) map.classList.remove('dragging');
    if(e.type==='pointerup' && !moved) {
      const hit=hits.find(h=>Math.hypot(h.x-point[0],h.y-point[1])<=h.r);
      if(downButton) downButton.activate();
      else if(hit) hit.fn();
    }
    if(!touches.size) downButton=null;
  }
  // Capture may outlast a label when its anchor exits the visible crop.
  window.addEventListener('pointerup',release);
  window.addEventListener('pointercancel',release);
  map.addEventListener('wheel',e=>{
    e.preventDefault();
    const delta=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?W:1);
    zoomAt(...pointerPos(e),Math.exp(clamp(delta,-660,660)*.00165));
  },{passive:false});
  map.addEventListener('keydown',e=>{
    const step=camera.span*(e.shiftKey?.2:.065);
    switch(e.key){
      case 'ArrowLeft':camera.x-=step;break;
      case 'ArrowRight':camera.x+=step;break;
      case 'ArrowUp':camera.y+=step;break;
      case 'ArrowDown':camera.y-=step;break;
      case '+':case '=':zoomAt(W/2,W/2,.7);break;
      case '-':case '_':zoomAt(W/2,W/2,1/.7);break;
      case 'Home':restore('flight');break;
      default:return;
    }
    e.preventDefault();invalidate();
  });
  function fitSheet() {
    const sheet = document.querySelector('.sheet');
    const notes = document.querySelector('.note-space');
    const css = getComputedStyle(sheet);
    const width = sheet.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
    const height = sheet.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom);
    const horizontal = css.flexDirection === 'row';
    sheet.toggleAttribute('data-foot', !horizontal);
    let side;
    if (horizontal) {
      const rail = notes.getBoundingClientRect().width;
      side = Math.min(height, width - rail - parseFloat(css.columnGap), 1340);
    } else {
      const room = height - parseFloat(css.rowGap);
      // Three columns need room for complete coordinate pairs and scale marks.
      const minFooter = Math.min(width, (width >= 550 ? 64 : 31) * parseFloat(css.fontSize));
      let footer = Math.min(width, 1340);
      // Align the bottom legend to the square. Re-measure when narrower
      // columns wrap. Short windows keep enough width for the coordinates.
      for (let pass = 0; pass < 4; pass++) {
        notes.style.setProperty('--foot-width', footer + 'px');
        side = Math.min(width, room - notes.getBoundingClientRect().height, 1340);
        const next = Math.max(minFooter, Math.floor(side));
        if (next >= footer - 1) break;
        footer = next;
      }
    }
    side = Math.max(1, Math.floor(side));
    sheet.style.setProperty('--side',side + 'px');
    invalidate();
  }
  selectEpoch(0);
  fitSheet();
  window.addEventListener('resize',fitSheet);
  document.fonts.ready.then(fitSheet);
})();
