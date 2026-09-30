let state = {data:null, parameter:'leakage', selected:null, theme:'dark'};
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const PARAM = {
  leakage:{label:'Leakage Current', unit:'µA', limit:50},
  iddq:{label:'Standby Current (Iddq)', unit:'µA', limit:20},
  delay:{label:'Propagation Delay', unit:'ns', limit:50}
};
const TIMES = [0,24,96,168];

function toast(message){
  const t=$('#toast'); t.textContent=message; t.classList.add('show');
  clearTimeout(window.__toastTimer); window.__toastTimer=setTimeout(()=>t.classList.remove('show'),2600);
}
function esc(v){return String(v).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));}
function fmt(v,n=3){return Number.isFinite(Number(v))?Number(v).toFixed(n):'—';}
function statusClass(s){return s==='HIGH RISK'?'high':s==='WATCH'?'watch':'normal';}
function showPage(id){
  $$('.page').forEach(p=>p.classList.toggle('active',p.id===id));
  $$('.nav').forEach(n=>n.classList.toggle('active',n.dataset.page===id));
  const titles={overview:'Overview',screening:'Batch Screening',drift:'168h Drift Forecast',inspector:'Component Inspector',simulator:'Scenario Lab',reports:'QA Report'};
  $('#pageTitle').textContent=titles[id]||'Overview';
  if(id==='reports') renderReport();
}
$$('.nav').forEach(n=>n.onclick=()=>showPage(n.dataset.page));
$$('[data-go]').forEach(b=>b.onclick=()=>showPage(b.dataset.go));

function applyTheme(theme){
  state.theme=theme; document.body.dataset.theme=theme; localStorage.setItem('burnsight-theme',theme);
  $$('[data-theme-choice]').forEach(b=>b.classList.toggle('active',b.dataset.themeChoice===theme));
}
applyTheme(localStorage.getItem('burnsight-theme')||'dark');
$$('[data-theme-choice]').forEach(b=>b.onclick=()=>applyTheme(b.dataset.themeChoice));

function setParam(p){
  if(!PARAM[p]) return;
  state.parameter=p;
  $('#parameter').value=p;
  $$('.page-param').forEach(x=>x.value=p);
  $('#driftParam').value=p;
  $('#simParam').value=p;
  $('#limitInput').placeholder=PARAM[p].limit;
}
$('#parameter').onchange=e=>loadReference(e.target.value);

async function api(url,opts={}){
  const r=await fetch(url,opts);
  if(!r.ok){let msg='Request failed';try{const j=await r.json();msg=j.detail||msg;}catch{}throw new Error(msg);}
  return r.json();
}
async function checkHealth(){
  try{await api('/api/health'); $('#apiStatusText').textContent='API connected · local inference';}
  catch{ $('#apiStatusText').textContent='API connection issue'; toast('Backend connection unavailable');}
}

async function loadReference(p=state.parameter){
  setParam(p);
  try{const d=await api('/api/reference?parameter='+encodeURIComponent(p)+'&batch_id=BATCH-REFERENCE-01'); state.data=d; state.selected=null; renderAll(); toast('Reference set loaded');}
  catch(e){toast(e.message);}
}
$('#runReference').onclick=()=>loadReference(state.parameter);
$('#analyzeReference').onclick=()=>loadReference($('.page-param')?.value||state.parameter);
$$('.page-param').forEach(x=>x.onchange=e=>setParam(e.target.value));

function renderAll(){
  const d=state.data,s=d.summary,p=PARAM[d.parameter];
  $('#kTotal').textContent=s.total; $('#kNormal').textContent=s.normal; $('#kWatch').textContent=s.watch; $('#kRisk').textContent=s.high_risk;
  $('#kTotalSub').textContent=`${p.label} · ${s.total} parts`;
  const med=d.meta.batch_median[3], p90=d.meta.envelope_p90[3];
  $('#screenMedian').textContent=`${fmt(med)} ${p.unit}`; $('#screenP90').textContent=`${fmt(p90)} ${p.unit}`;
  $('#screenSlope').textContent=`${fmt(d.meta.safety_slope,5)} ${p.unit}/h`; $('#screenLimit').textContent=`${fmt(d.meta.absolute_limit)} ${p.unit}`;
  $('#screenMethod').innerHTML=`<b>Current method</b><span>${esc(d.meta.screening_method)}</span><small>Healthy reference fraction ${Math.round(d.meta.healthy_reference_fraction*100)}% · ${esc(d.meta.scoring)}</small>`;
  renderFingerprint(); renderRiskList(); renderScreenTable(); renderTrajectory(); fillComponents(); renderReport();
}
function renderFingerprint(){
  const d=state.data, p=PARAM[d.parameter], med=d.meta.batch_median, lo=d.meta.envelope_p10, hi=d.meta.envelope_p90;
  const max=Math.max(...hi,0.001);
  $('#fingerprint').innerHTML=TIMES.map((t,i)=>{
    const medianWidth=Math.max(7,Math.min(100,med[i]/max*100));
    const bandWidth=Math.max(2,Math.min(100,(hi[i]-lo[i])/max*100));
    return `<div class="fp-row"><label>${t}h</label><div class="fp-science"><i class="fp-band" style="width:${bandWidth}%"></i><i class="fp-median" style="width:${medianWidth}%"></i></div><b>${fmt(med[i])} ${p.unit}</b></div>`;
  }).join('');
}
function renderRiskList(){
  const top=state.data.top_risks.slice(0,6);
  $('#riskList').innerHTML=top.map(r=>`<div class="risk-row"><div class="risk-id">${esc(r.id)}</div><div><div class="risk-meter"><i style="width:${r.score}%"></i></div><span class="status ${statusClass(r.status)}">${r.status}</span></div><div class="risk-score">${fmt(r.score,1)}</div></div>`).join('');
}
function renderScreenTable(){
  const q=($('#tableSearch')?.value||'').toLowerCase();
  const rows=state.data.rows.filter(r=>r.id.toLowerCase().includes(q));
  $('#screenTable').innerHTML=rows.map(r=>`<tr><td><b>${esc(r.id)}</b></td>${r.values.map(v=>`<td>${fmt(v)}</td>`).join('')}<td>${fmt(r.score,1)}%</td><td><span class="status ${statusClass(r.status)}">${r.status}</span></td><td><button class="link" onclick="inspect('${esc(r.id)}')">Inspect</button></td></tr>`).join('');
}
$('#tableSearch').oninput=()=>state.data&&renderScreenTable();

function percentile(values,p){
  const a=[...values].sort((x,y)=>x-y); if(!a.length)return 0;
  const idx=(a.length-1)*p, lo=Math.floor(idx), hi=Math.ceil(idx); if(lo===hi)return a[lo]; return a[lo]+(a[hi]-a[lo])*(idx-lo);
}
function pathFrom(values,x,y){return values.map((v,i)=>`${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');}
function chartSvg(rows,{showEnvelope=true,showLimit=true,height=340}={}){
  if(!state.data) return '';
  const W=980,H=height,pad={l:58,r:24,t:22,b:42};
  const all=rows.flatMap(r=>r.values);
  const meta=state.data.meta, limit=meta.absolute_limit;
  const med=meta.batch_median, low=meta.envelope_p10, high=meta.envelope_p90;
  const series=[...all, ...(showEnvelope?high:[]), ...(showEnvelope?low:[]), ...(showEnvelope?med:[]), ...(showLimit?[limit]:[])];
  let mn=Math.min(...series), mx=Math.max(...series);
  if(mn===mx){mn-=1;mx+=1;}
  const span=mx-mn; mn=Math.max(0,mn-span*.10); mx=mx+span*.10;
  const x=i=>pad.l+i*(W-pad.l-pad.r)/3;
  const y=v=>H-pad.b-(v-mn)/(mx-mn)*(H-pad.t-pad.b);
  const yt=[]; for(let j=0;j<=5;j++) yt.push(mn+(mx-mn)*(j/5));
  const clipId=`clip-${Math.random().toString(36).slice(2,8)}`;
  let svg=`<svg class="svg scientific-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Scientific trajectory chart">
    <defs>
      <linearGradient id="band-${clipId}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--cyan)" stop-opacity=".22"/><stop offset="1" stop-color="var(--cyan)" stop-opacity=".02"/></linearGradient>
      <filter id="glow-${clipId}" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    </defs>`;
  yt.forEach(v=>{svg+=`<line x1="${pad.l}" y1="${y(v)}" x2="${W-pad.r}" y2="${y(v)}" class="grid-line"/><text x="${pad.l-10}" y="${y(v)+3}" class="axis-text" text-anchor="end">${fmt(v,2)}</text>`;});
  [0,1,2,3].forEach((i)=>{svg+=`<line x1="${x(i)}" y1="${pad.t}" x2="${x(i)}" y2="${H-pad.b}" class="grid-line vertical"/><text x="${x(i)}" y="${H-14}" class="axis-text" text-anchor="middle">${TIMES[i]}h</text>`;});
  if(showEnvelope){
    const top=pathFrom(high,x,y), bottom=[...low].reverse().map((v,ri)=>{const i=low.length-1-ri;return `${x(i).toFixed(1)},${y(v).toFixed(1)}`}).join(' ');
    svg+=`<polygon points="${top} ${bottom}" fill="url(#band-${clipId})" class="envelope-band"/>`;
    svg+=`<polyline points="${pathFrom(low,x,y)}" class="envelope-edge"/>`;
    svg+=`<polyline points="${pathFrom(high,x,y)}" class="envelope-edge"/>`;
    svg+=`<polyline points="${pathFrom(med,x,y)}" class="median-line"/>`;
  }
  const highlighted=[...rows].sort((a,b)=>b.score-a.score).slice(0,7);
  rows.forEach((r)=>{
    const isHi=r.status==='HIGH RISK', isWatch=r.status==='WATCH';
    if(isHi||isWatch){
      const cls=isHi?'risk-line':'watch-line';
      svg+=`<polyline points="${pathFrom(r.values,x,y)}" class="${cls}"/>`;
      r.values.forEach((v,i)=>{if(isHi||i===3) svg+=`<circle cx="${x(i)}" cy="${y(v)}" r="${isHi?4:3}" class="point ${isHi?'point-risk':'point-watch'}"/>`;});
    } else if(Math.random()<0.05){
      svg+=`<polyline points="${pathFrom(r.values,x,y)}" class="normal-trace"/>`;
    }
  });
  if(showLimit){
    svg+=`<line x1="${pad.l}" y1="${y(limit)}" x2="${W-pad.r}" y2="${y(limit)}" class="limit-line"/>`;
    svg+=`<text x="${W-pad.r}" y="${y(limit)-7}" class="limit-text" text-anchor="end">ENGINEERING LIMIT ${fmt(limit,2)}</text>`;
  }
  svg+=`<text x="${pad.l}" y="${pad.t-7}" class="axis-title">${esc(PARAM[state.data.parameter].unit)}</text>`;
  svg+='</svg>';
  return svg;
}
function renderTrajectory(){
  const rows=state.data.rows;
  $('#trajectoryChart').innerHTML=chartSvg(rows,{showEnvelope:true,showLimit:true,height:355});
}
function fillComponents(){
  const s=$('#componentSelect');
  s.innerHTML=state.data.rows.map(r=>`<option value="${esc(r.id)}">${esc(r.id)} · ${esc(r.status)}</option>`).join('');
  s.value=state.selected?.id||state.data.rows[0]?.id||'';
  inspect(s.value,false);
}
function forecastLocal(r){
  // Inspector remains responsive even if the page was loaded before the prediction API completes.
  const v0=r.values[0],v24=r.values[1],s=(v24-v0)/24;
  return Math.max(0,v24+s*144*.7);
}
async function fetchPrediction(parameter,values){
  try{return await api('/api/predict',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parameter,values})});}
  catch{return {predicted_168h:forecastLocal({values}),uncertainty:0,model_metrics:{mae:0,r2:0},engineering_limit:PARAM[parameter].limit,risk:'CONTROLLED'};}
}
async function inspect(id,go=true){
  if(!state.data)return;
  const r=state.data.rows.find(x=>x.id===id)||state.data.rows[0]; if(!r)return;
  state.selected=r; $('#componentSelect').value=r.id;
  const p=PARAM[state.data.parameter];
  const d=await fetchPrediction(state.data.parameter,r.values.slice(0,2));
  const pred=Number(d.predicted_168h); const limit=p.limit;
  const lead=r.lead_time_hours;
  $('#inspectorBody').innerHTML=`<div class="panel inspector-card">
    <div class="component-head"><div><span class="eyebrow">COMPONENT RECORD</span><div class="component-id">${esc(r.id)}</div><span class="note">${p.label} · batch ${esc(state.data.batch_id)}</span></div><div class="component-risk"><span class="status ${statusClass(r.status)}">${r.status}</span><b>${fmt(r.score,1)}% risk</b></div></div>
    <div class="metric-grid">${r.values.map((v,i)=>`<div class="reading"><small>${TIMES[i]}h</small><b>${fmt(v)}</b><span>${p.unit}</span></div>`).join('')}</div>
    <div class="inspector-grid">
      <div class="panel inner-panel"><div class="panel-head"><div><span class="eyebrow">TRAJECTORY ANALYSIS</span><h3>Component vs batch envelope</h3></div><span class="mono">z = ${fmt(r.endpoint_z,2)}</span></div><div class="chart scientific inspector-chart">${chartSvg([r],{showEnvelope:true,showLimit:true,height:300})}</div></div>
      <div class="panel inner-panel"><div class="panel-head"><div><span class="eyebrow">EVIDENCE TRACE</span><h3>Why it was flagged</h3></div></div><div class="evidence">${r.reasons.map((x,i)=>`<div><b>${String(i+1).padStart(2,'0')} · Evidence</b><span>${esc(x)}</span></div>`).join('')}<div><b>Forecasted 168h</b><span>${fmt(pred)} ${p.unit} · uncertainty ±${fmt(d.uncertainty)} ${p.unit}</span></div><div><b>Lead-time signal</b><span>${lead?`Estimated threshold crossing around ${fmt(lead,1)}h`:'No crossing within 168h at the observed full-trajectory slope'}</span></div></div></div>
    </div>
    <div class="signal-row"><div class="signal-card"><span>Batch deviation</span><i><b style="width:${r.signals.batch_deviation}%"></b></i><strong>${fmt(r.signals.batch_deviation,1)}</strong></div><div class="signal-card"><span>Endpoint deviation</span><i><b style="width:${r.signals.endpoint_deviation}%"></b></i><strong>${fmt(r.signals.endpoint_deviation,1)}</strong></div><div class="signal-card"><span>Trajectory drift</span><i><b style="width:${r.signals.trajectory_drift}%"></b></i><strong>${fmt(r.signals.trajectory_drift,1)}</strong></div><div class="signal-card"><span>Shape rarity</span><i><b style="width:${r.signals.shape_rarity}%"></b></i><strong>${fmt(r.signals.shape_rarity,1)}</strong></div></div>
  </div>`;
  if(go)showPage('inspector');
}
window.inspect=inspect;
$('#componentSelect').onchange=e=>inspect(e.target.value,false);

function renderModelMetrics(m){
  $('#modelMetrics').innerHTML=`<div class="metric-box"><small>VALIDATION MAE</small><b>${fmt(m.mae)}</b></div><div class="metric-box"><small>R² SCORE</small><b>${fmt(m.r2)}</b></div><div class="metric-box"><small>TRAIN SAMPLES</small><b>${m.train_samples}</b></div><div class="metric-box"><small>HOLDOUT SAMPLES</small><b>${m.test_samples}</b></div>`;
  $('#mae').textContent=fmt(m.mae);
}
function forecastSvg(a,b,pred,unc,limit){
  const W=900,H=180,p={l:54,r:28,t:18,b:34};
  const vals=[a,b,pred,pred+unc,pred-unc,limit]; let mn=Math.min(...vals),mx=Math.max(...vals); if(mn===mx){mn-=1;mx+=1;} const sp=mx-mn; mn=Math.max(0,mn-sp*.12); mx+=sp*.12;
  const x=i=>p.l+i*(W-p.l-p.r)/2, y=v=>H-p.b-(v-mn)/(mx-mn)*(H-p.t-p.b);
  const yy=[]; for(let i=0;i<=4;i++)yy.push(mn+(mx-mn)*i/4);
  let svg=`<svg class="svg forecast-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><defs><filter id="fg"><feGaussianBlur stdDeviation="2.8" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter><linearGradient id="ci" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--cyan)" stop-opacity=".2"/><stop offset="1" stop-color="var(--cyan)" stop-opacity=".03"/></linearGradient></defs>`;
  yy.forEach(v=>svg+=`<line x1="${p.l}" y1="${y(v)}" x2="${W-p.r}" y2="${y(v)}" class="grid-line"/><text x="${p.l-10}" y="${y(v)+3}" class="axis-text" text-anchor="end">${fmt(v,2)}</text>`);
  svg+=`<line x1="${p.l}" y1="${y(limit)}" x2="${W-p.r}" y2="${y(limit)}" class="limit-line"/><text x="${W-p.r}" y="${y(limit)-8}" class="limit-text" text-anchor="end">TARGET ${fmt(limit,2)}</text>`;
  const x2=x(2); svg+=`<polygon points="${x(1)},${y(pred-unc)} ${x(2)},${y(pred-unc)} ${x(2)},${y(pred+unc)} ${x(1)},${y(pred+unc)}" fill="url(#ci)"/>`;
  svg+=`<polyline points="${x(0)},${y(a)} ${x(1)},${y(b)} ${x(2)},${y(pred)}" class="forecast-line" filter="url(#fg)"/><circle cx="${x(0)}" cy="${y(a)}" r="4" class="point point-cyan"/><circle cx="${x(1)}" cy="${y(b)}" r="4" class="point point-cyan"/><circle cx="${x(2)}" cy="${y(pred)}" r="6" class="point point-risk" filter="url(#fg)"/>`;
  ['0h','24h','168h'].forEach((t,i)=>svg+=`<text x="${x(i)}" y="${H-12}" class="axis-text" text-anchor="middle">${t}</text>`);
  svg+=`<text x="${x2-4}" y="${y(pred)-12}" class="forecast-label" text-anchor="end">FORECAST</text></svg>`; return svg;
}
async function predict(){
  const p=$('#driftParam').value, v0=Number($('#v0').value),v24=Number($('#v24').value); if(!(v0>=0&&v24>=0))return toast('Enter valid non-negative measurements');
  try{
    const d=await api('/api/predict',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parameter:p,values:[v0,v24]})});
    const meta=PARAM[p], pred=d.predicted_168h, unc=d.uncertainty;
    $('#predValue').textContent=fmt(pred); $('#predUnit').textContent=meta.unit;
    $('#earlySlope').textContent=fmt(d.early_slope,5); $('#driftLimit').textContent=`${fmt(meta.limit)} ${meta.unit}`; renderModelMetrics(d.model_metrics);
    $('#forecastViz').innerHTML=forecastSvg(v0,v24,pred,unc,meta.limit);
    $('#uncertainty').textContent=`Ensemble spread ±${fmt(unc)} ${meta.unit}. Validation MAE ${fmt(d.model_metrics.mae)} ${meta.unit}.`;
    const risk=d.risk||'CONTROLLED', rp=$('#forecastRisk'); rp.textContent=risk; rp.className='risk-pill '+risk.toLowerCase();
    const margin=meta.limit-pred; $('#forecastMargin').textContent=`Margin ${margin>=0?'+':''}${fmt(margin)} ${meta.unit}`;
    const earlySlope=(v24-v0)/24; const cross=earlySlope>0?((meta.limit-v0)/earlySlope):null; $('#forecastLead').textContent=`Threshold lead ${cross>0&&cross<=168?fmt(cross,1)+'h':'not indicated'}`;
    toast('168h forecast generated');
  }catch(e){toast(e.message);}
}
$('#predictBtn').onclick=predict;
$('#driftParam').onchange=e=>{setParam(e.target.value);};

async function simulate(){
  const p=$('#simParam').value,v0=Number($('#s0').value),v24=Number($('#s24').value),target=Number($('#target').value);
  if(!(v0>=0&&v24>=0&&target>0))return toast('Enter valid scenario values');
  try{
    const d=await api('/api/what-if',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parameter:p,values:[v0,v24],target_168h:target})});
    const unit=PARAM[p].unit; $('#simValue').textContent=fmt(d.predicted_168h); $('#simUnit').textContent=unit;
    const risk=d.risk, rp=$('#simRisk'); rp.textContent=risk; rp.className='risk-pill '+risk.toLowerCase();
    const status=$('#simStatus'); status.textContent=risk==='HIGH'?'HIGH RISK · forecast exceeds target':risk==='WATCH'?'WATCH · forecast approaches target':'CONTROLLED · forecast below target'; status.className='big-status '+risk.toLowerCase();
    $('#simMeter').style.width=Math.min(100,d.predicted_168h/target*100)+'%'; $('#simMarker').style.left='calc(100% - 1px)';
    $('#simMargin').textContent=`${d.margin>=0?'+':''}${fmt(d.margin)} ${unit}`; $('#simCrossing').textContent=d.estimated_crossing_hours?`${fmt(d.estimated_crossing_hours,1)} h`:'Not indicated'; $('#simUncertainty').textContent=`±${fmt(d.uncertainty)} ${unit}`;
    $('#simExplain').textContent=`The forecast is ${d.predicted_168h>target?'above':'below'} the configured 168h target by ${fmt(Math.abs(d.margin))} ${unit}.`;
    toast('Scenario evaluated');
  }catch(e){toast(e.message);}
}
$('#simulateBtn').onclick=simulate;
$('#simParam').onchange=e=>setParam(e.target.value);

async function uploadCsv(){
  const file=$('#csvFile').files[0]; if(!file)return toast('Choose a CSV file first');
  const p=$('.page-param')?.value||state.parameter, batchId=$('#batchIdInput').value.trim()||'BATCH-UPLOAD-001', fd=new FormData();
  fd.append('file',file);
  try{
    const d=await api(`/api/upload?parameter=${encodeURIComponent(p)}&batch_id=${encodeURIComponent(batchId)}${$('#limitInput').value?`&max_limit=${encodeURIComponent($('#limitInput').value)}`:''}`,{method:'POST',body:fd});
    state.data=d; state.selected=null; setParam(p); renderAll(); toast(`Batch ${batchId} analyzed`);
  }catch(e){toast(e.message);}
}
$('#uploadBtn').onclick=uploadCsv;
$('#templateBtn').onclick=()=>{
  const text='Component_ID,0h,24h,96h,168h\nC001,10,11,12,13\nC002,9,10,11,12\nC003,11,15,25,43\n';
  const blob=new Blob([text],{type:'text/csv'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='burnin_data_structure.csv'; a.click(); URL.revokeObjectURL(a.href); toast('CSV structure downloaded');
};

function renderReport(){
  if(!state.data)return; const d=state.data,p=PARAM[d.parameter],s=d.summary,top=d.top_risks.slice(0,8);
  $('#report').innerHTML=`<div class="report-banner"><div><div class="report-title">BurnSight AI · Burn-In Screening Report</div><div class="report-sub">Batch ${esc(d.batch_id)} · ${esc(p.label)} · generated ${new Date(d.generated_at).toLocaleString()}</div></div><div class="report-stamp">QA / SCREENING</div></div>
  <div class="report-grid"><div class="report-stat"><small>ANALYZED</small><b>${s.total}</b></div><div class="report-stat good"><small>NORMAL</small><b>${s.normal}</b></div><div class="report-stat warn"><small>WATCH</small><b>${s.watch}</b></div><div class="report-stat danger"><small>HIGH RISK</small><b>${s.high_risk}</b></div></div>
  <div class="report-section"><h3>Executive assessment</h3><p>The screening engine combines robust batch statistics, trajectory analysis, shape-rarity detection, and a parameter-specific 168h regression model. The fixed engineering limit is treated as a safety gate rather than the sole anomaly criterion.</p></div>
  <div class="report-section"><h3>Adaptive controls</h3><p>Batch median at 168h: <b>${fmt(d.meta.batch_median[3])} ${p.unit}</b> · P90 envelope: <b>${fmt(d.meta.envelope_p90[3])} ${p.unit}</b> · adaptive safety slope: <b>${fmt(d.meta.safety_slope,5)} ${p.unit}/h</b> · absolute limit: <b>${fmt(d.meta.absolute_limit)} ${p.unit}</b></p></div>
  <div class="report-section"><h3>Priority queue</h3><table class="report-table"><thead><tr><th>Component</th><th>Risk</th><th>Status</th><th>Primary evidence</th></tr></thead><tbody>${top.map(r=>`<tr><td>${esc(r.id)}</td><td>${fmt(r.score,1)}%</td><td>${esc(r.status)}</td><td>${esc(r.reasons[0])}</td></tr>`).join('')}</tbody></table></div>
  <div class="report-section"><h3>Model registry</h3><p>Forecast model: <b>${esc(d.model.algorithm)}</b> · target: <b>Value_168h</b> · features: <b>${d.model.features.join(', ')}</b> · holdout MAE: <b>${fmt(d.model.mae)} ${p.unit}</b> · R²: <b>${fmt(d.model.r2)}</b>.</p></div>
  <div class="report-note">Control note: bundled reference data is intended for software verification. Production release decisions require validated historical burn-in data, approved engineering limits, measurement traceability, and qualified human review.</div>`;
}
$('#printReport').onclick=()=>window.print();

checkHealth();
loadReference('leakage');
