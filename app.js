/* ============================================================
   DIFFER — Live Engine  v3
   OAuth login · live ticks + balance · auto-trade
   Center prediction circle with running data behind it
   Self-learning ensemble + auto-generated MATCH/DIFFER rules
   ============================================================ */

const $ = id => document.getElementById(id);
const DIGITS=[...Array(10).keys()];
const WIN=240;

/* ---- connection ---- */
let ws=null, running=false, autoTrade=true, symbol='R_75';
let acctId='', balance=0, balanceStart=null;

/* ---- data collection ---- */
let ticks=[], counts=new Array(10).fill(0);
let trans=Array.from({length:10},()=>new Array(10).fill(1));
let gap=new Array(10).fill(0), lastDigit=null;
let pnl=0,wins=0,losses=0,streak=0,baseStake=0.35,curStake=0.35;
let pendingPred=null, awaitingResult=false;

/* ---- ensemble + generated rules ---- */
let strat={freq:{w:1,hits:1,n:2},markov:{w:1,hits:1,n:2},gap:{w:1,hits:1,n:2},
           ewma:{w:1,hits:1,n:2},streak:{w:1,hits:1,n:2}};
let genRules={}, activeRule=null;

/* ============================================================
   OAUTH  (Deriv redirect flow)
   IMPORTANT: Deriv redirects to the "OAuth Redirect URL" set in
   YOUR app's dashboard settings — it does NOT honor a redirect_uri
   query param. So the app_id below MUST be your own registered app
   whose redirect URL points at the page hosting this file.
   On return the URL holds: ?acct1=cr..&token1=a1-..&cur1=usd&acct2=..
   ============================================================ */
function appId(){ return ($('appId')?.value || localStorage.getItem('differ_appid') || '1089').trim(); }

function startOAuth(){
  const id=appId();
  localStorage.setItem('differ_appid',id);
  if(id==='1089'){
    log('App ID 1089 is Deriv\u2019s test app \u2014 OAuth will not return here. Register your own app and use its App ID.','l');
  }
  // No redirect_uri param: Deriv uses the redirect URL from app settings.
  location.href=`https://oauth.deriv.com/oauth2/authorize?app_id=${encodeURIComponent(id)}&l=EN`;
}

/* parse every acctN/tokenN/curN triplet Deriv appends on return */
function parseAccounts(search){
  const q=new URLSearchParams(search);
  const accts=[];
  let i=1;
  while(q.get('token'+i)){
    accts.push({ loginid:q.get('acct'+i)||'', token:q.get('token'+i), cur:(q.get('cur'+i)||'').toUpperCase() });
    i++;
  }
  return accts;
}

function readOAuthReturn(){
  const accts=parseAccounts(location.search);
  if(accts.length){
    // strip tokens from the address bar / history immediately
    history.replaceState({}, document.title, location.pathname);
    sessionStorage.setItem('differ_accts', JSON.stringify(accts));
    // prefer a real (CR) account over virtual (VRTC) if present
    const real=accts.find(a=>/^CR/i.test(a.loginid));
    const chosen=real||accts[0];
    sessionStorage.setItem('differ_token',chosen.token);
    sessionStorage.setItem('differ_acct',chosen.loginid);
    return chosen.token;
  }
  return sessionStorage.getItem('differ_token');
}

/* ============================================================
   MODELS
   ============================================================ */
function pFreq(){const t=counts.reduce((a,b)=>a+b,0)||1;return counts.map(c=>c/t);}
function pMarkov(){if(lastDigit===null)return new Array(10).fill(.1);
  const r=trans[lastDigit],s=r.reduce((a,b)=>a+b,0);return r.map(v=>v/s);}
function pGap(){const mg=Math.max(...gap,1),raw=gap.map(g=>g/mg),
  s=raw.reduce((a,b)=>a+b,0)||1;return raw.map(v=>v/s);}
function pEwma(){const p=new Array(10).fill(0);let w=0;
  for(let i=ticks.length-1,k=0;i>=0&&k<60;i--,k++){const ww=Math.pow(.94,k);p[ticks[i]]+=ww;w+=ww;}
  return w?p.map(v=>v/w):new Array(10).fill(.1);}
function pStreak(){const p=pFreq().slice();
  if(ticks.length>=2&&ticks.at(-1)===ticks.at(-2))p[ticks.at(-1)]*=1.6;
  const s=p.reduce((a,b)=>a+b,0)||1;return p.map(v=>v/s);}
const MODELS={freq:pFreq,markov:pMarkov,gap:pGap,ewma:pEwma,streak:pStreak};

function ensemble(){const b=new Array(10).fill(0);let tw=0;
  for(const k in MODELS){tw+=strat[k].w;const p=MODELS[k]();
    for(let d=0;d<10;d++)b[d]+=strat[k].w*p[d];}
  for(let d=0;d<10;d++)b[d]/=(tw||1);return b;}
function hotCold(p){let h=0,c=0;for(let d=1;d<10;d++){if(p[d]>p[h])h=d;if(p[d]<p[c])c=d;}return{hot:h,cold:c};}

/* ============================================================
   RULE GENERATOR
   ============================================================ */
function ruleTemplates(){return[
  {label:'DIFFER coldest (ensemble)',contract:'DIGITDIFF',fn:()=>{const p=ensemble();return{digit:hotCold(p).cold,p};}},
  {label:'MATCH hottest (ensemble)',contract:'DIGITMATCH',fn:()=>{const p=ensemble();return{digit:hotCold(p).hot,p};}},
  {label:'DIFFER markov-min after '+(lastDigit??'?'),contract:'DIGITDIFF',fn:()=>{const p=pMarkov();return{digit:hotCold(p).cold,p};}},
  {label:'DIFFER gap-reversion',contract:'DIGITDIFF',fn:()=>{const p=pGap();return{digit:hotCold(p).hot,p:ensemble()};}},
  {label:'MATCH on repeat-streak',contract:'DIGITMATCH',fn:()=>{if(ticks.length<2||ticks.at(-1)!==ticks.at(-2))return null;return{digit:ticks.at(-1),p:ensemble()};}},
  {label:'DIFFER recency-cold (EWMA)',contract:'DIGITDIFF',fn:()=>{const p=pEwma();return{digit:hotCold(p).cold,p};}},
];}
function generateRules(){
  ruleTemplates().forEach(t=>{const id=t.contract+'|'+t.label.replace(/after.*/,'');
    if(!genRules[id])genRules[id]={...t,hits:1,n:2};
    else{genRules[id].fn=t.fn;genRules[id].label=t.label;}});
  for(const id in genRules){const r=genRules[id];if(r.n>=14&&(r.hits/r.n)<.42)delete genRules[id];}
}
function ruleScore(r){return r.hits/r.n;}
function bestGeneratedPick(){generateRules();
  let best=null,bs=-1,bp=null,bid=null;
  for(const id in genRules){const r=genRules[id],out=r.fn();if(!out)continue;
    const s=ruleScore(r);if(s>bs){bs=s;best=r;bp=out;bid=id;}}
  if(!best)return null;
  return{rule:best,ruleId:bid,contract:best.contract,digit:bp.digit,p:bp.p,score:bs};}

/* ============================================================
   DECISION
   ============================================================ */
function decide(){
  if(ticks.length<25)return null;
  const sel=$('contract').value, minConf=parseFloat($('minConf').value)||60;
  const gen=bestGeneratedPick(); if(!gen)return null;
  let{contract,digit,p,rule}=gen;
  if(sel!=='AUTO'&&contract!==sel){const hc=hotCold(p);contract=sel;
    digit=contract==='DIGITDIFF'?hc.cold:hc.hot;}
  let conf;
  if(contract==='DIGITDIFF')conf=(1-p[digit])*100;
  else conf=p[digit]*100;
  conf=conf*.7+(gen.score*100)*.3;
  activeRule=gen.ruleId;
  return{skip:conf<minConf,conf,digit,contract,ruleId:gen.ruleId,ruleLabel:rule.label,p};
}

/* ============================================================
   LEARNING
   ============================================================ */
function learn(actualDigit,won){
  const contract=pendingPred.contract;
  for(const k in MODELS){const p=MODELS[k]();
    const pick=contract==='DIGITDIFF'?p.indexOf(Math.min(...p)):p.indexOf(Math.max(...p));
    const ok=contract==='DIGITDIFF'?(pick!==actualDigit):(pick===actualDigit);
    strat[k].n++;if(ok)strat[k].hits++;strat[k].w=.15+(strat[k].hits/strat[k].n);}
  if(pendingPred.ruleId&&genRules[pendingPred.ruleId]){
    const r=genRules[pendingPred.ruleId];r.n++;if(won)r.hits++;}
}

/* ============================================================
   RENDER — circle, behind data, strips
   ============================================================ */
function renderCircle(dec){
  const sweep=$('sweepBar'), C=2*Math.PI*110;
  if(!dec){ $('coreDigit').textContent='–'; $('coreConf').textContent='analyzing…';
    sweep.style.strokeDashoffset=C; return; }
  const side=dec.contract==='DIGITDIFF'?'DIFFERS':'MATCHES';
  $('coreSide').textContent=side;
  $('coreSide').className='core-side'+(dec.contract==='DIGITMATCH'?' match':'');
  $('coreDigit').textContent=dec.digit;
  $('coreConf').textContent=dec.conf.toFixed(1)+'% conf'+(dec.skip?' · waiting':'');
  const frac=Math.min(dec.conf,100)/100;
  sweep.style.strokeDashoffset=C*(1-frac);
  sweep.style.stroke=dec.contract==='DIGITMATCH'?'var(--acc2)':'var(--acc)';
}
function renderBehind(d){
  // big faint digit pulse
  const t=$('ticker'); t.textContent=d; t.style.animation='none'; void t.offsetWidth; t.style.animation='fade .7s';
  // scrolling analysis text = live model internals
  const p=ensemble(); const{hot,cold}=hotCold(p);
  let txt='';
  for(let i=0;i<10;i++){
    txt+=`d${i}:${(p[i]*100).toFixed(1)}%  `;
    if(i%3===2)txt+='\n';
  }
  txt+=`\nHOT ${hot}  COLD ${cold}  LAST ${lastDigit}\n`;
  const arr=Object.values(genRules).sort((a,b)=>ruleScore(b)-ruleScore(a)).slice(0,4);
  arr.forEach(r=>{txt+=`${r.contract==='DIGITDIFF'?'DIF':'MAT'} ${(ruleScore(r)*100).toFixed(0)}% ${r.label}\n`;});
  $('ringText').textContent=(txt+'\n').repeat(3);
}
function pushLast(d,cls=''){const s=$('laststrip');
  s.insertAdjacentHTML('afterbegin',`<div class="ld ${cls}">${d}</div>`);
  while(s.children.length>9)s.lastChild.remove();}
function renderStats(){const t=wins+losses;
  $('wr').textContent=t?((wins/t*100).toFixed(0)+'%'):'—';
  $('trades').textContent=t;
  $('streak').textContent=(streak>0?'+':'')+streak;
  $('streak').className='tb-v '+(streak>0?'green':streak<0?'red':'');
  $('stakeV').textContent='$'+curStake.toFixed(2);
  $('pnl').textContent=(pnl<0?'-$':'$')+Math.abs(pnl).toFixed(2);
  $('pnl').className='m-v '+(pnl>0?'green':pnl<0?'red':'');}
function setBalance(b){balance=b;if(balanceStart===null)balanceStart=b;
  $('balance').textContent='$'+Number(b).toFixed(2);}
function log(msg,cls=''){const l=$('log');const t=new Date().toLocaleTimeString();
  l.insertAdjacentHTML('afterbegin',`<div class="${cls}">[${t}] ${msg}</div>`);
  while(l.children.length>100)l.lastChild.remove();}

/* ============================================================
   TICK HANDLER
   ============================================================ */
function onTick(price){
  const d=parseInt(String(price).slice(-1),10);if(isNaN(d))return;

  if(awaitingResult&&pendingPred){
    const won=pendingPred.contract==='DIGITDIFF'?(d!==pendingPred.digit):(d===pendingPred.digit);
    learn(d,won); pushLast(d,won?'win':'loss'); awaitingResult=false;
  } else { pushLast(d); }

  if(lastDigit!==null)trans[lastDigit][d]++;
  ticks.push(d);counts[d]++;
  for(let i=0;i<10;i++)gap[i]++;gap[d]=0;
  if(ticks.length>WIN){const o=ticks.shift();counts[o]--;}
  lastDigit=d;

  renderBehind(d);
  const dec=decide();
  renderCircle(dec);

  if(autoTrade&&dec&&!dec.skip&&!awaitingResult)placeTrade(dec);

  checkLimits();
}

/* ============================================================
   TRADE
   ============================================================ */
function placeTrade(dec){
  pendingPred={digit:dec.digit,contract:dec.contract,ruleId:dec.ruleId};
  awaitingResult=true;
  log(`OPEN ${dec.contract==='DIGITDIFF'?'DIFF':'MATCH'} ${dec.digit} · $${curStake.toFixed(2)} · ${dec.conf.toFixed(0)}%`,'i');
  if(ws&&ws.readyState===1){
    ws.send(JSON.stringify({buy:1,price:curStake,parameters:{
      amount:curStake,basis:'stake',contract_type:dec.contract,currency:'USD',
      duration:1,duration_unit:'t',symbol:symbol,barrier:String(dec.digit)}}));
  }
}
function settleLive(profit,won){
  pnl+=profit;
  if(won){wins++;streak=streak>=0?streak+1:1;curStake=baseStake;}
  else{losses++;streak=streak<=0?streak-1:-1;
    curStake=baseStake*Math.pow(parseFloat($('mart').value)||2,Math.min(-streak,6));}
  log((won?'WIN ':'LOSS')+` → P/L $${profit.toFixed(2)}`,won?'w':'l');
  renderStats();
}
function checkLimits(){
  const tp=parseFloat($('tp').value),sl=parseFloat($('sl').value);
  if(!isNaN(tp)&&pnl>=tp){log(`TAKE PROFIT +$${pnl.toFixed(2)} — auto-trade off`,'w');setAuto(false);}
  if(!isNaN(sl)&&pnl<=-Math.abs(sl)){log(`STOP LOSS $${pnl.toFixed(2)} — auto-trade off`,'l');setAuto(false);}
}

/* ============================================================
   DERIV CONNECTION
   ============================================================ */
function connect(token){
  ws=new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${appId()}`);
  $('connDot').className='dot';
  ws.onopen=()=>ws.send(JSON.stringify({authorize:token}));
  ws.onmessage=ev=>{
    const m=JSON.parse(ev.data);
    if(m.error){log('API: '+m.error.message,'l');
      if(['InvalidToken','AuthorizationRequired'].includes(m.error.code))logout();return;}
    switch(m.msg_type){
      case 'authorize':
        acctId=m.authorize.loginid; $('acctId').textContent=acctId;
        $('connDot').className='dot live';
        setBalance(m.authorize.balance);
        running=true;
        log('Connected · '+acctId,'i');
        ws.send(JSON.stringify({balance:1,subscribe:1}));
        ws.send(JSON.stringify({ticks:symbol,subscribe:1}));
        ws.send(JSON.stringify({proposal_open_contract:1,subscribe:1}));
        break;
      case 'balance':
        if(m.balance)setBalance(m.balance.balance);break;
      case 'tick':
        if(m.tick)onTick(m.tick.quote);break;
      case 'buy':
        log('Bought '+m.buy.contract_id,'i');break;
      case 'proposal_open_contract':{
        const c=m.proposal_open_contract;
        if(c&&c.is_sold){const won=parseFloat(c.profit)>=0;
          settleLive(parseFloat(c.profit),won);awaitingResult=false;}
        break;}
    }
  };
  ws.onclose=()=>{$('connDot').className='dot';
    if(running){setTimeout(()=>running&&connect(token),1500);}};
  ws.onerror=()=>log('WebSocket error — check network/app id.','l');
}

/* ============================================================
   AUTH FLOW / UI WIRING
   ============================================================ */
function showApp(){ $('loginGate').classList.add('hidden'); $('app').classList.remove('hidden'); }
function setAuto(on){autoTrade=on;const b=$('autoBtn');
  b.textContent=on?'AUTO ●':'AUTO ○';b.className='auto'+(on?' on':' off');}
function logout(){
  // guard against exiting with a trade still open
  if(awaitingResult && !confirm('A trade is still open. Log out anyway?')) return;

  running=false; autoTrade=false;
  // gracefully drop subscriptions, then close
  if(ws && ws.readyState===1){
    try{ ws.send(JSON.stringify({forget_all:['ticks','balance','proposal_open_contract']})); }catch(e){}
  }
  try{ ws && ws.close(); }catch(e){} ws=null;

  // clear stored credentials
  sessionStorage.removeItem('differ_token');
  sessionStorage.removeItem('differ_acct');

  // reset session state so a fresh login starts clean
  ticks=[]; counts=new Array(10).fill(0); gap=new Array(10).fill(0);
  trans=Array.from({length:10},()=>new Array(10).fill(1));
  lastDigit=null; pendingPred=null; awaitingResult=false;
  pnl=0; wins=0; losses=0; streak=0; curStake=baseStake;
  balance=0; balanceStart=null; acctId='';
  genRules={}; activeRule=null;
  for(const k in strat) strat[k]={w:1,hits:1,n:2};

  // clear the UI
  $('laststrip').innerHTML=''; $('log').innerHTML='';
  $('balance').textContent='—'; $('acctId').textContent='—';
  $('connDot').className='dot';
  renderStats(); renderCircle(null);

  // return to the login gate (no hard reload — keeps it instant)
  $('app').classList.add('hidden');
  $('loginGate').classList.remove('hidden');
}

window.addEventListener('DOMContentLoaded',()=>{
  // restore saved app id
  const savedId=localStorage.getItem('differ_appid'); if(savedId)$('appId').value=savedId;
  baseStake=parseFloat($('stake')?.value)||0.35; curStake=baseStake;

  // login gate wiring
  $('oauthBtn').onclick=startOAuth;
  $('advToggle').onclick=()=>$('advBox').classList.toggle('show');
  $('tokenBtn').onclick=()=>{const t=$('tokenInput').value.trim();
    if(!t){log('Enter a token first.','l');return;}
    sessionStorage.setItem('differ_token',t); boot(t);};
  // toggle the 1089 warning live as the app id is edited
  const hint=$('setupHint');
  const refreshHint=()=>{ if(hint) hint.classList.toggle('ok', $('appId').value.trim()!=='1089'); };
  $('appId').addEventListener('input',refreshHint); refreshHint();

  // app wiring
  $('autoBtn').onclick=()=>setAuto(!autoTrade);
  $('logoutBtn').onclick=logout;
  $('stake').addEventListener('change',e=>{baseStake=parseFloat(e.target.value)||0.35;
    if(!awaitingResult)curStake=baseStake;renderStats();});
  $('symbol').addEventListener('change',e=>{ if(ws&&ws.readyState===1){
    ws.send(JSON.stringify({forget_all:'ticks'}));
    symbol=e.target.value; ticks=[];counts.fill(0);gap.fill(0);lastDigit=null;
    trans=Array.from({length:10},()=>new Array(10).fill(1));
    ws.send(JSON.stringify({ticks:symbol,subscribe:1}));
    log('Switched to '+symbol,'i');}});

  // returning from OAuth or restored session?
  const token=readOAuthReturn();
  if(token) boot(token);
});

function boot(token){
  symbol=$('symbol').value;
  showApp(); setAuto(true);
  renderStats(); renderCircle(null);
  connect(token);
}
