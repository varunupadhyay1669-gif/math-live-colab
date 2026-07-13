// Dev-only: prove the Live Mirror engine in isolation (no app). Builds a
// source iframe (stateful quiz + mirror source) and a follower iframe
// (SAME quiz with its scripts STRIPPED + mirror follower) into public/, plus a
// harness that relays messages between them exactly like the server will.
// Run: npx tsx gen-mirror-harness.mts
import { writeFileSync, mkdirSync } from 'fs';
import { mirrorScriptFor, stripLessonScripts } from './src/lib/mirrorScript.ts';

// A faithful compact clone of the Ratio-Rush mechanics: screens toggled by JS
// .active, navigation via inline onclick openW(), DYNAMICALLY created options
// with JS-assigned onclick, progress in localStorage. If the mirror keeps this
// in lockstep, it keeps the real lesson in lockstep (same mechanics).
const QUIZ = `<!doctype html><html><head><meta charset="utf-8"><style>
  body{font-family:sans-serif;background:#2a0a3a;color:#fff;margin:0;padding:16px}
  .screen{display:none}.screen.active{display:block}
  .zone{display:inline-block;padding:20px;margin:8px;background:#4a2070;border-radius:12px;cursor:pointer}
  .opt{display:inline-block;padding:12px 18px;margin:6px;background:#333;border:2px solid #666;border-radius:10px;cursor:pointer}
  .opt.right{background:#28d17c}.opt.wrong{background:#ff5252}
  #hud{font-weight:bold;margin-bottom:12px}
</style></head><body>
<div id="hud">STARS <span id="stars">0</span> · <span id="qbar"></span></div>
<div class="screen active" id="home">
  <h1 id="title">Ratio Quiz — Map</h1>
  <div class="zone" onclick="openW('w1')">World 1</div>
  <div class="zone" onclick="openW('w2')">World 2</div>
  <div class="zone" onclick="openW('w3')">World 3</div>
</div>
<div class="screen" id="world">
  <h2 id="wname"></h2>
  <div id="q"></div>
  <div id="opts"></div>
  <div id="feed"></div>
  <button id="next" onclick="wnext()" disabled>Next</button>
  <button id="map" onclick="go('home')">Map</button>
</div>
<script>
  var state={stars:0,cleared:{}};
  try{var s=localStorage.getItem('rq');if(s)state=JSON.parse(s);}catch(e){}
  if(!state.cleared)state.cleared={};
  function save(){try{localStorage.setItem('rq',JSON.stringify(state));}catch(e){}}
  var WORLDS={w1:{name:'World 1',qs:[{q:'Simplify 4:6',options:['2:3','3:2','4:6'],ans:'2:3'},{q:'Simplify 10:5',options:['2:1','1:2','5:2'],ans:'2:1'},{q:'Simplify 9:12',options:['3:4','4:3','9:12'],ans:'3:4'}]},
    w2:{name:'World 2',qs:[{q:'1:2 = 3:?',options:['4','6','9'],ans:'6'},{q:'2:3 = 4:?',options:['5','6','8'],ans:'6'}]},
    w3:{name:'World 3',qs:[{q:'Share 20 as 2:3, bigger?',options:['8','12','15'],ans:'12'}]}};
  function go(id){document.querySelectorAll('.screen').forEach(function(s){s.classList.remove('active')});document.getElementById(id).classList.add('active');hud();}
  function hud(){document.getElementById('stars').textContent=state.stars;}
  var curW=null,wi=0;
  function openW(k){curW=k;wi=0;document.getElementById('wname').textContent=WORLDS[k].name;go('world');render();}
  function render(){var W=WORLDS[curW];document.getElementById('qbar').textContent='Q '+(wi+1)+' of '+W.qs.length;
    var q=W.qs[wi];document.getElementById('q').textContent=q.q;document.getElementById('feed').textContent='';document.getElementById('next').disabled=true;
    var box=document.getElementById('opts');box.innerHTML='';
    q.options.forEach(function(o){var b=document.createElement('div');b.className='opt';b.textContent=o;
      b.onclick=function(){if(document.querySelector('#opts .right'))return;
        if(o===q.ans){b.classList.add('right');document.getElementById('feed').textContent='Correct!';document.getElementById('next').disabled=false;
          if((state.cleared[curW]||0)<W.qs.length){state.cleared[curW]=(state.cleared[curW]||0)+1;state.stars++;save();hud();}}
        else{b.classList.add('wrong');document.getElementById('feed').textContent='Try again';}};
      box.appendChild(b);});}
  function wnext(){var W=WORLDS[curW];wi++;if(wi>=W.qs.length){go('home');return;}render();}
  hud();
</script></body></html>`;

const source = QUIZ.replace('<head>', '<head>' + mirrorScriptFor('source'));
const follower = stripLessonScripts(QUIZ).replace('<head>', '<head>' + mirrorScriptFor('follower'));

mkdirSync('public', { recursive: true });
writeFileSync('public/__mirror_source.html', source, 'utf8');
writeFileSync('public/__mirror_follower.html', follower, 'utf8');

const harness = `<!doctype html><html><head><meta charset="utf-8"><title>mirror test</title></head>
<body style="margin:0;font-family:sans-serif">
<div style="display:flex;height:100vh">
  <div style="flex:1;border-right:2px solid #333;display:flex;flex-direction:column">
    <div style="background:#123;color:#fff;padding:6px;font-weight:bold">SOURCE (authoritative — runs the lesson)</div>
    <iframe id="src" src="/__mirror_source.html" style="flex:1;border:0"></iframe>
  </div>
  <div style="flex:1;display:flex;flex-direction:column">
    <div style="background:#311;color:#fff;padding:6px;font-weight:bold">FOLLOWER (dumb mirror — no lesson JS)</div>
    <iframe id="fol" src="/__mirror_follower.html" style="flex:1;border:0"></iframe>
  </div>
</div>
<script>
  var src=document.getElementById('src'), fol=document.getElementById('fol');
  // Relay: exactly what the server will do.
  window.addEventListener('message', function(e){
    var d=e.data; if(!d||!d.type) return;
    if(e.source===src.contentWindow){
      if(d.type==='SYNC_MIRROR') fol.contentWindow.postMessage({type:'MIRROR_APPLY',body:d.body,scrollX:d.scrollX,scrollY:d.scrollY},'*');
      else if(d.type==='SYNC_MIRROR_CANVAS') fol.contentWindow.postMessage({type:'MIRROR_CANVAS',canvases:d.canvases},'*');
    } else if(e.source===fol.contentWindow){
      if(d.type==='SYNC_MIRROR_INPUT') src.contentWindow.postMessage({type:'MIRROR_INPUT',kind:d.kind,path:d.path,value:d.value,deltaY:d.deltaY,key:d.key},'*');
      // A (re)loaded follower announces itself → ask the source for a full
      // snapshot so it instantly shows the current screen (late-join / reconnect).
      else if(d.type==='MIRROR_FOLLOWER_READY'){ setTimeout(function(){ fol.contentWindow.postMessage({type:'SET_MIRROR_INTERACT',allowed:true},'*'); src.contentWindow.postMessage({type:'MIRROR_REQUEST'},'*'); }, 50); }
    }
  });
  window.addEventListener('load', function(){ setTimeout(function(){ fol.contentWindow.postMessage({type:'SET_MIRROR_INTERACT',allowed:true},'*'); }, 500); });

  function snap(w){ try{ var d=w.contentDocument; return { screen:(d.querySelector('.screen.active')||{}).id||'?', qbar:(d.getElementById('qbar')||{}).textContent||'', stars:(d.getElementById('stars')||{}).textContent||'', q:(d.getElementById('q')||{}).textContent||'', feed:(d.getElementById('feed')||{}).textContent||'' }; }catch(e){ return {err:String(e)} } }
  window.__states = function(){ return { source: snap(src), follower: snap(fol) }; };
  // Fire a NATIVE click on the source (simulates the student solving).
  window.__srcClick = function(sel){ var el=src.contentDocument.querySelector(sel); if(!el) return 'no-el:'+sel; el.click(); return 'ok'; };
  // Fire a click on the FOLLOWER (simulates the teacher clicking the mirror).
  window.__folClick = function(sel){ var el=fol.contentDocument.querySelector(sel); if(!el) return 'no-el:'+sel; el.click(); return 'ok'; };
</script>
</body></html>`;
writeFileSync('public/__mirror.html', harness, 'utf8');
console.log('wrote public/__mirror.html (+ source/follower)');
