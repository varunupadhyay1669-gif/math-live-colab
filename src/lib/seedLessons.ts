// The lessons that ship with the product.
//
// The library was a personal folder: every teacher opened it to nothing, and a
// board that runs things is worth nothing on the first day if there is nothing
// to run. That is the single biggest reason a trial ends without a second
// lesson — the tutor has to build the product's value before they can judge it.
//
// So a set ships. Rules each of these follows, because a bad interactive is
// worse than none:
//
//   TOUCHABLE, not animated. If the student cannot change it, a video would
//   have done. Every one has something to drag, tap or run.
//   ONE IDEA. A simulation that demonstrates four things demonstrates none.
//   HONEST. The maths is correct at every position, not just the pretty one.
//   TABLET-SIZED. Pointer events, targets over 44px, no hover-only affordance —
//   the student is on an iPad, and a control they cannot hit is not a control.
//
// Each is one self-contained page: no build step, no imports, nothing to fetch.
// It runs in the lesson frame exactly as pasted, which is also how a teacher's
// own material behaves — these are examples of the format, not a special case.

export interface SeedLesson {
  id: string;
  name: string;
  topic: string;
  /** One line, shown under the name — what the student actually does. */
  blurb: string;
  html: string;
}

/** Shared chrome so the set looks like a set and not six strangers. */
const shell = (title: string, hint: string, body: string, script: string) => `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  *{box-sizing:border-box}
  body{margin:0;padding:16px;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;
       background:#F7F8FB;color:#12203A;display:flex;flex-direction:column;gap:14px;
       align-items:center}
  h1{margin:0;font-size:21px;font-weight:700;letter-spacing:-0.01em;text-align:center}
  .hint{margin:0;font-size:14px;color:#5C6883;text-align:center;max-width:46ch}
  .stage{background:#fff;border:1px solid #DCE1EC;border-radius:14px;padding:16px;
         width:100%;max-width:620px;box-shadow:0 10px 28px -22px rgba(18,32,58,.5)}
  .read{font-size:22px;font-weight:700;text-align:center;margin:12px 0 0;
        font-variant-numeric:tabular-nums}
  .muted{font-size:14px;color:#5C6883;text-align:center;margin:4px 0 0}
  button{font:inherit;cursor:pointer;border-radius:10px;border:1px solid #C9D0DF;
         background:#fff;padding:12px 18px;font-weight:600;min-height:46px}
  button:hover{border-color:#8E9AB5}
  button.go{background:#4F46E5;border-color:#4F46E5;color:#fff}
  .row{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:14px}
  svg{display:block;width:100%;height:auto;touch-action:none}
</style></head>
<body>
<h1>${title}</h1>
<p class="hint">${hint}</p>
<div class="stage">${body}</div>
<script>${script}<\/script>
</body></html>`;

export const SEED_LESSONS: SeedLesson[] = [
  {
    id: 'seed_convenient_order',
    name: 'Convenient order',
    topic: 'Algebra',
    blurb: 'Pair the numbers that make a ten, and a hard multiplication becomes an easy one.',
    html: shell(
      'Multiply in a convenient order',
      'Tap two numbers to multiply first. The answer never changes — the effort does.',
      '<div class="row" id="tiles"></div><p class="read" id="out">4 &times; 21 &times; 5</p><p class="muted" id="say">Which two would you pair?</p>',
      `var N=[4,21,5],p=[],t=document.getElementById('tiles'),o=document.getElementById('out'),s=document.getElementById('say');
N.forEach(function(n,i){var b=document.createElement('button');b.textContent=n;b.style.fontSize='26px';b.style.minWidth='72px';
b.onclick=function(){var k=p.indexOf(i);if(k>-1)p.splice(k,1);else{if(p.length>1)p.shift();p.push(i)}draw()};t.appendChild(b)});
function draw(){[].forEach.call(t.children,function(b,i){var on=p.indexOf(i)>-1;b.className=on?'go':'';});
if(p.length!==2){o.textContent='4 \\u00d7 21 \\u00d7 5';s.textContent='Which two would you pair?';return}
var a=N[p[0]],b=N[p[1]],r=N[[0,1,2].filter(function(k){return p.indexOf(k)<0})[0]],f=a*b;
o.textContent=a+' \\u00d7 '+b+' = '+f+'  \\u2192  '+f+' \\u00d7 '+r+' = '+(f*r);
s.textContent=f%10===0?'A step you can do in your head.':'That one you have to write down. Try pairing 4 and 5.'}
draw();`,
    ),
  },

  {
    id: 'seed_fraction_wall',
    name: 'Fraction wall',
    topic: 'Fractions',
    blurb: 'Tap two rows to see which fraction is bigger, and why halves and quarters line up.',
    html: shell(
      'Which fraction is bigger?',
      'Tap any two rows. The bars are the same width, so the pieces tell you the answer.',
      '<div id="wall"></div><p class="read" id="out">Tap two rows</p>',
      `var D=[1,2,3,4,5,6,8],sel=[],w=document.getElementById('wall'),o=document.getElementById('out');
D.forEach(function(d,i){
/* A real button, not a clickable div: the student may be on a keyboard, and a
   div gives them no focus ring and no way in. */
var row=document.createElement('button');
row.setAttribute('aria-label','Compare one over '+d);
row.style.cssText='display:flex;gap:3px;margin-bottom:6px;width:100%;padding:0;border:0;background:none;cursor:pointer;min-height:46px';
for(var k=0;k<d;k++){var c=document.createElement('span');
c.style.cssText='flex:1;height:34px;border-radius:5px;background:#E7EAF3;display:flex;align-items:center;justify-content:center;font-size:12px;color:#5C6883';
c.textContent=d===1?'1':'1/'+d;row.appendChild(c)}
row.onclick=function(){var k=sel.indexOf(i);if(k>-1)sel.splice(k,1);else{if(sel.length>1)sel.shift();sel.push(i)}draw()};
w.appendChild(row)});
function draw(){[].forEach.call(w.children,function(row,i){var on=sel.indexOf(i)>-1;
[].forEach.call(row.children,function(c){c.style.background=on?'#4F46E5':'#E7EAF3';c.style.color=on?'#fff':'#5C6883'})});
if(sel.length!==2){o.textContent='Tap two rows';return}
var a=D[sel[0]],b=D[sel[1]];if(a===b){o.textContent='Same row';return}
var big=a<b?a:b,sm=a<b?b:a;
o.textContent='1/'+big+' is bigger than 1/'+sm+'  \\u2014  more pieces means smaller pieces'}
draw();`,
    ),
  },

  {
    id: 'seed_balance',
    name: 'Balance an equation',
    topic: 'Algebra',
    blurb: 'Do the same to both sides and watch the scale stay level until x is alone.',
    html: shell(
      'Solve 2x + 3 = 11',
      'Whatever you do to one side, do to the other. The scale stays level while it is true.',
      '<p class="read" id="eq">2x + 3 = 11</p><svg viewBox="0 0 320 90" id="sc"></svg>'
      + '<div class="row"><button id="sub">Subtract 3</button><button id="div">Divide by 2</button><button id="rst">Start again</button></div>'
      + '<p class="muted" id="say">Both sides, every time.</p>',
      `var a=2,b=3,c=11,eq=document.getElementById('eq'),sc=document.getElementById('sc'),say=document.getElementById('say');
function show(){eq.textContent=(a===1?'x':a+'x')+(b?' + '+b:'')+' = '+c;
var tilt=(b===0&&a===1)?0:4;
sc.innerHTML='<line x1="160" y1="20" x2="160" y2="70" stroke="#12203A" stroke-width="3"/>'+
'<line x1="60" y1="'+(30+tilt)+'" x2="260" y2="'+(30-tilt)+'" stroke="#12203A" stroke-width="4" stroke-linecap="round"/>'+
'<circle cx="60" cy="'+(30+tilt)+'" r="15" fill="#4F46E5"/><circle cx="260" cy="'+(30-tilt)+'" r="15" fill="#4F46E5"/>'+
'<text x="60" y="'+(35+tilt)+'" text-anchor="middle" fill="#fff" font-size="12" font-weight="700">'+(a===1?'x':a+'x')+(b?'+'+b:'')+'</text>'+
'<text x="260" y="'+(35-tilt)+'" text-anchor="middle" fill="#fff" font-size="12" font-weight="700">'+c+'</text>';
say.textContent=(a===1&&b===0)?'x = '+c+'. The scale is level and x is alone.':'Both sides, every time.'}
document.getElementById('sub').onclick=function(){if(b===0){say.textContent='Nothing left to subtract.';return}c-=b;b=0;show()};
document.getElementById('div').onclick=function(){if(b!==0){say.textContent='Take the 3 off first \\u2014 dividing now splits it too.';return}
if(a===1)return;if(c%a){say.textContent='That would not divide evenly.';return}c/=a;a=1;show()};
document.getElementById('rst').onclick=function(){a=2;b=3;c=11;show()};
show();`,
    ),
  },

  {
    id: 'seed_triangle_area',
    name: 'Why triangle area is half',
    topic: 'Geometry',
    blurb: 'Slide the top corner anywhere along the line — the area refuses to change.',
    html: shell(
      'Area = ½ × base × height',
      'Drag the top corner. It changes shape but not area, because the base and the height never change.',
      '<svg viewBox="0 0 320 190" id="s"></svg><p class="read" id="out"></p><p class="muted">Base 200, height 120 \\u2014 whatever the shape.</p>',
      `var s=document.getElementById('s'),out=document.getElementById('out'),ax=160,drag=false;
function draw(){s.innerHTML='<line x1="20" y1="40" x2="300" y2="40" stroke="#C9D0DF" stroke-dasharray="5 5"/>'+
'<polygon points="60,160 260,160 '+ax+',40" fill="#4F46E5" fill-opacity=".16" stroke="#4F46E5" stroke-width="2.5"/>'+
'<line x1="'+ax+'" y1="40" x2="'+ax+'" y2="160" stroke="#0D7A5F" stroke-width="2" stroke-dasharray="4 4"/>'+
'<line x1="60" y1="170" x2="260" y2="170" stroke="#12203A" stroke-width="2"/>'+
'<circle cx="'+ax+'" cy="40" r="13" fill="#4F46E5"/>';
out.textContent='\\u00bd \\u00d7 200 \\u00d7 120 = 12000 square units'}
function move(e){if(!drag)return;var r=s.getBoundingClientRect(),p=e.touches?e.touches[0]:e;
ax=Math.max(-40,Math.min(360,(p.clientX-r.left)/r.width*320));draw();e.preventDefault()}
s.addEventListener('pointerdown',function(e){drag=true;move(e)});
window.addEventListener('pointermove',move);window.addEventListener('pointerup',function(){drag=false});
draw();`,
    ),
  },

  {
    id: 'seed_angle_sum',
    name: 'Angles in a triangle',
    topic: 'Geometry',
    blurb: 'Drag any corner. The three angles change, and they always add to 180.',
    html: shell(
      'They always add to 180°',
      'Drag any corner and watch the three numbers. Try to make them add to anything else.',
      '<svg viewBox="0 0 320 200" id="s"></svg><p class="read" id="out"></p>',
      `var P=[[60,170],[260,170],[150,50]],s=document.getElementById('s'),out=document.getElementById('out'),held=-1;
function ang(a,b,c){var v1=[b[0]-a[0],b[1]-a[1]],v2=[c[0]-a[0],c[1]-a[1]];
var d=v1[0]*v2[0]+v1[1]*v2[1],m=Math.hypot(v1[0],v1[1])*Math.hypot(v2[0],v2[1]);
return m?Math.acos(Math.max(-1,Math.min(1,d/m)))*180/Math.PI:0}
function draw(){var A=ang(P[0],P[1],P[2]),B=ang(P[1],P[0],P[2]),C=ang(P[2],P[0],P[1]);
var h='<polygon points="'+P.map(function(p){return p[0]+','+p[1]}).join(' ')+'" fill="#4F46E5" fill-opacity=".14" stroke="#4F46E5" stroke-width="2.5"/>';
[A,B,C].forEach(function(v,i){h+='<circle cx="'+P[i][0]+'" cy="'+P[i][1]+'" r="13" fill="#4F46E5"/>'+
'<text x="'+P[i][0]+'" y="'+(P[i][1]-20)+'" text-anchor="middle" font-size="14" font-weight="700" fill="#12203A">'+Math.round(v)+'\\u00b0</text>'});
s.innerHTML=h;out.textContent=Math.round(A)+' + '+Math.round(B)+' + '+Math.round(C)+' = '+Math.round(A+B+C)+'\\u00b0'}
function at(e){var r=s.getBoundingClientRect(),p=e.touches?e.touches[0]:e;
return [(p.clientX-r.left)/r.width*320,(p.clientY-r.top)/r.height*200]}
s.addEventListener('pointerdown',function(e){var q=at(e);held=-1;
P.forEach(function(p,i){if(Math.hypot(p[0]-q[0],p[1]-q[1])<26)held=i})});
window.addEventListener('pointermove',function(e){if(held<0)return;var q=at(e);
P[held]=[Math.max(14,Math.min(306,q[0])),Math.max(14,Math.min(186,q[1]))];draw();e.preventDefault()});
window.addEventListener('pointerup',function(){held=-1});
draw();`,
    ),
  },

  {
    id: 'seed_probability',
    name: 'Does it even out?',
    topic: 'Probability',
    blurb: 'Roll ten or a thousand times and watch the bars settle towards one sixth.',
    html: shell(
      'Rolling a die, many times',
      'Ten rolls looks random. A thousand looks like a rule. Run it and see where the bars go.',
      '<svg viewBox="0 0 320 150" id="s"></svg><p class="read" id="out">0 rolls</p>'
      + '<div class="row"><button id="r10">Roll 10</button><button class="go" id="r100">Roll 100</button>'
      + '<button id="r1000">Roll 1000</button><button id="rst">Clear</button></div>',
      `var c=[0,0,0,0,0,0],n=0,s=document.getElementById('s'),out=document.getElementById('out');
function draw(){var m=Math.max.apply(null,c)||1,h='';
c.forEach(function(v,i){var bh=v/m*100,x=18+i*50;
h+='<rect x="'+x+'" y="'+(120-bh)+'" width="34" height="'+bh+'" rx="4" fill="#4F46E5"/>'+
'<text x="'+(x+17)+'" y="136" text-anchor="middle" font-size="12" fill="#5C6883">'+(i+1)+'</text>'+
'<text x="'+(x+17)+'" y="'+(114-bh)+'" text-anchor="middle" font-size="11" fill="#12203A">'+(n?Math.round(v/n*100)+'%':'')+'</text>'});
h+='<line x1="10" y1="'+(120-100/m*(n/6))+'" x2="310" y2="'+(120-100/m*(n/6))+'" stroke="#0D7A5F" stroke-dasharray="4 4"/>';
s.innerHTML=h;out.textContent=n+' rolls'+(n?'  \\u2014  one sixth is 16.7%':'')}
function roll(k){for(var i=0;i<k;i++){c[Math.floor(Math.random()*6)]++;n++}draw()}
document.getElementById('r10').onclick=function(){roll(10)};
document.getElementById('r100').onclick=function(){roll(100)};
document.getElementById('r1000').onclick=function(){roll(1000)};
document.getElementById('rst').onclick=function(){c=[0,0,0,0,0,0];n=0;draw()};
draw();`,
    ),
  },
];

/** Topics that actually have something in them, for the library filter. */
export const SEED_TOPICS = [...new Set(SEED_LESSONS.map(l => l.topic))].sort();
