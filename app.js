var D = { j: {}, z: {} };
var cFM = null, cFlt = 'All', cJob = null, photoData = {}, pickerIdx = null;
var tc = function(t){return t.indexOf('Aqua')>=0?'aq':t.indexOf('Quality')>=0?'qi':t.indexOf('Sod')>=0?'so':t.indexOf('Builder')>=0?'bm':'cc'};
var DATA_FILE = 'dispatch-data.xlsx';
var MOBILE_CAPTURE = (function(){
  var ua = navigator.userAgent || '';
  var touchMac = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return /iPhone|iPad|iPod|Android/i.test(ua) || touchMac;
})();

document.getElementById('dt').textContent = new Date().toLocaleDateString('en-US', {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric'
});

function toast(msg){var t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(function(){t.classList.remove('show')},2000)}
function he(s){return s?String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;'):''}
function asText(v){return v==null?'':String(v).trim()}
function asNumber(v,fallback){if(v==null||v==='')return fallback;var n=Number(v);return isNaN(n)?fallback:n}
function makeClickable(){var q='.card,.tab,.jc,.ck,.ps .tm,.bk';var els=document.querySelectorAll(q);for(var i=0;i<els.length;i++){var el=els[i];if(!el.hasAttribute('tabindex'))el.setAttribute('tabindex','0');if(!el.hasAttribute('role'))el.setAttribute('role','button')}}
document.addEventListener('keydown',function(e){if((e.key==='Enter'||e.key===' ')&&e.target.matches('.card,.tab,.jc,.ck,.ps .tm,.bk')){e.preventDefault();e.target.click()}})

function setGridStatus(title,detail){
  document.getElementById('fg').innerHTML='<div class="status-card"><div class="status-title">'+he(title)+'</div><div class="status-detail">'+he(detail)+'</div></div>';
}

function syncPickerUi(){
  var title = document.getElementById('pModalTitle');
  var cameraBtn = document.getElementById('pCameraBtn');
  var cameraLabel = document.getElementById('pCameraLabel');
  var libraryLabel = document.getElementById('pLibraryLabel');
  if(!title||!cameraBtn||!cameraLabel||!libraryLabel)return;
  if(MOBILE_CAPTURE){
    title.textContent='Add Photo';
    cameraBtn.style.display='';
    cameraLabel.textContent='Camera';
    libraryLabel.textContent='Photo Library';
  }else{
    title.textContent='Upload Photo';
    cameraBtn.style.display='none';
    libraryLabel.textContent='Choose File';
  }
}

function buildDataFromWorkbook(workbook){
  var jobsSheet = workbook.Sheets.Jobs || workbook.Sheets.jobs;
  var zonesSheet = workbook.Sheets.Zones || workbook.Sheets.zones;
  if(!jobsSheet)throw new Error('Workbook is missing a Jobs sheet.');
  if(!zonesSheet)throw new Error('Workbook is missing a Zones sheet.');
  var rows = XLSX.utils.sheet_to_json(jobsSheet, { defval: '' });
  var zones = XLSX.utils.sheet_to_json(zonesSheet, { defval: '' });
  var data = { j: {}, z: {} };
  for(var i=0;i<rows.length;i++){
    var row = rows[i];
    var fm = asText(row.fm);
    if(!fm)continue;
    if(!data.j[fm])data.j[fm]=[];
    data.j[fm].push([
      asNumber(row.stop, 0),
      asText(row.community),
      asText(row.subcommunity),
      asText(row.address),
      asText(row.task_type),
      asText(row.start_time),
      asText(row.end_time),
      asNumber(row.duration_minutes, 0),
      asText(row.job_number),
      asText(row.customer),
      asText(row.zip_code),
      asNumber(row.latitude, ''),
      asNumber(row.longitude, '')
    ]);
  }
  for(var fm in data.j)data.j[fm].sort(function(a,b){return a[0]-b[0]});
  for(var k=0;k<zones.length;k++){
    var zoneRow = zones[k];
    var zoneFm = asText(zoneRow.fm);
    if(zoneFm)data.z[zoneFm] = asText(zoneRow.zone);
  }
  return data;
}

async function loadDispatchData(){
  setGridStatus('Loading routes','Reading '+DATA_FILE+'...');
  try{
    if(!window.XLSX)throw new Error('Excel reader did not load.');
    var response = await fetch(DATA_FILE, { cache: 'no-store' });
    if(!response.ok)throw new Error('Could not fetch '+DATA_FILE+' ('+response.status+').');
    var buffer = await response.arrayBuffer();
    D = buildDataFromWorkbook(XLSX.read(buffer, { type: 'array' }));
    rFM();
    makeClickable();
  }catch(err){
    console.error(err);
    var detail = location.protocol === 'file:'
      ? 'This app needs to be opened over http or https so the workbook can be fetched.'
      : 'Make sure '+DATA_FILE+' is in the same folder as this page.';
    setGridStatus('Could not load Excel data', detail);
  }
}

function rFM(){
  var g=document.getElementById('fg');g.innerHTML='';var fms=Object.keys(D.j);
  if(!fms.length){setGridStatus('No routes found','Add rows to the Jobs sheet in '+DATA_FILE+' and refresh the page.');return}
  for(var i=0;i<fms.length;i++){var f=fms[i],js=D.j[f],types={};for(var k=0;k<js.length;k++){var t=js[k][4];types[t]=(types[t]||0)+1}var st=[];for(var t in types)st.push(types[t]+' '+t);g.innerHTML+='<div class="card" onclick="selFM(\''+f+'\')"><div class="nm">'+f+'</div><div class="st">'+js.length+' stops<br>'+st.join(', ')+'</div><div class="zn">'+(D.z[f]||'')+'</div></div>'}
}

function selFM(f){cFM=f;cFlt='All';show('s2');document.getElementById('h1').textContent=f+"'s Route";document.getElementById('h2').textContent=D.j[f].length+' stops';document.getElementById('bk').style.display='block';rJL()}

function rJL(){var js=D.j[cFM],types=['All'],seen={};for(var i=0;i<js.length;i++){var t=js[i][4];if(!seen[t]){seen[t]=1;types.push(t)}}var tb=document.getElementById('tb');tb.innerHTML='';for(var i=0;i<types.length;i++){var t=types[i],cnt=t=='All'?js.length:0;if(t!='All')for(var k=0;k<js.length;k++)if(js[k][4]==t)cnt++;tb.innerHTML+='<div class="tab'+(t==cFlt?' on':'')+'" onclick="flt(\''+t.replace(/'/g,"\\'")+'\')">'+ t+' ('+cnt+')</div>'}var fl=[];for(var i=0;i<js.length;i++)if(cFlt=='All'||js[i][4]==cFlt)fl.push(js[i]);var jl=document.getElementById('jl');jl.innerHTML='';for(var i=0;i<fl.length;i++){var j=fl[i],gps=j[11]!==''&&j[12]!==''?'https://www.google.com/maps/search/?api=1&query='+j[11]+','+j[12]:'#';jl.innerHTML+='<div class="jc" onclick="oJob('+j[0]+')"><div class="jt"><div class="sn">'+j[0]+'</div><div class="ji"><div class="cm">'+he(j[1])+(j[2]&&j[2]!=j[1]?' ('+he(j[2])+')':'')+'</div><div class="ad">'+he(j[3])+'</div></div><div class="tt '+tc(j[4])+'">'+j[4]+'</div></div><div class="jb"><span class="ch">'+j[5]+' - '+j[6]+'</span><span class="ch">'+j[7]+'m</span>'+(j[10]?'<span class="ch">'+j[10]+'</span>':'')+'<a class="gps" href="'+gps+'" target="_blank" onclick="event.stopPropagation()">&#128205; Nav</a></div></div>'}}

function flt(t){cFlt=t;rJL();makeClickable()}

function oJob(stop){var js=D.j[cFM];for(var i=0;i<js.length;i++)if(js[i][0]==stop){cJob=js[i];break}if(!cJob)return;photoData={};show('s3');document.getElementById('h1').textContent=cJob[4];document.getElementById('h2').textContent='Stop #'+cJob[0]+' - '+cJob[1];rForm()}

function rForm(){var j=cJob,gps=j[11]!==''&&j[12]!==''?'https://www.google.com/maps/search/?api=1&query='+j[11]+','+j[12]:null;var h='';
h+='<div class="ctx"><div class="cp"><span class="lb">FM&nbsp;</span><span class="vl">'+cFM+'</span></div><div class="cp"><span class="lb">Community&nbsp;</span><span class="vl">'+he(j[1])+'</span></div><div class="cp"><span class="lb">Zip&nbsp;</span><span class="vl">'+j[10]+'</span></div></div>';
if(gps)h+='<div class="gbar"><span style="font-size:16px">&#128205;</span><div style="flex:1"><div style="font-size:11px;color:#0D2240;font-weight:600">'+he(j[3])+'</div><div style="font-size:9px;color:#757575">'+j[11]+', '+j[12]+'</div></div><a href="'+gps+'" target="_blank">Open GPS &#8599;</a></div>';
h+='<div class="sec"><div class="sh">&#128196; Job Details</div><div class="fd"><label>Job #</label><input value="'+he(j[8])+'" readonly style="background:#fafafa"></div><div class="fd"><label>Customer</label><input value="'+he(j[9])+'" readonly style="background:#fafafa"></div></div>';
var tt=j[4];
if(tt=='Quality Inspection')h+=bScores(['Sod Install','Sod Health','Plant Install','Plant Health','Tree Install','Cleanup','Site Cond.','Overall'])+bVio()+bPhotos(['Front Elevation','Sod Area','Plant Bed','Cleanup','Safety']);
else if(tt=='Aqua Check')h+=bFields([['Zones Checked','number'],['System Type',['Temporary','Permanent','Both']],['Action',['None','Repair','Emergency','Adjust']]])+bChk([['Controller on & programmed',1],['All zones firing',1],['No broken heads/leaks',1],['Drip lines active',0],['Timer matches season',1],['Backflow intact',1],['No pooling/runoff',1],['Rain sensor OK',0],['Valve boxes flush',0]])+bVio()+bPhotos(['Controller','Coverage','Issue']);
else if(tt.indexOf('Sod')>=0)h+=bFields([['Sod Type',['Bermuda','Fescue','Zoysia','Centipede','Mixed']],['Sq Footage','number'],['Pallet Est','number'],['Grade',['Ready','Needs Grading','Needs Fill','Debris']],['Irrigation',['Temp','Perm','Not Installed','N/A']]])+bChk([['Lot graded & ready',1],['Trenches backfilled',1],['No standing water',1],['Debris cleared',1],['Slopes measured',0],['Builder notified',0]])+bPhotos(['Lot Overview','Grade','Issue']);
else if(tt.indexOf('Builder')>=0)h+=bFields([['Builder Rep','text'],['Type',['Walk','Punch','Pre-Install','Post-Install','Escalation']],['Lots Discussed','text']])+bChk([['Walk w/ rep present',1],['Punch items documented',1],['Timeline confirmed',1],['Change orders noted',0],['Irrigation reviewed',0],['Sod/plant readiness',0],['Safety flagged',0],['Follow-up date set',1]])+bPhotos(['Attendees','Punch 1','Punch 2','Overview']);
else h+=bFields([['Homeowner','text'],['Visit Type',['Warranty','Callback','Courtesy','HO Request','Escalation']],['Install Date','text']])+bScores(['Sod Cond.','Plant Cond.','Irrigation','Curb Appeal'])+bChk([['HO greeted & scope explained',1],['Issue inspected',1],['Root cause identified',1],['Warranty eligibility',1],['Corrective action',0],['Work order needed',0],['HO acknowledged',1]])+bPhotos(['Issue 1','Issue 2','Before','After']);
h+='<div class="sec"><div class="na"><label>Field Notes</label><textarea placeholder="Additional observations..."></textarea></div></div>';
document.getElementById('fc').innerHTML=h;bindEv();restoreForm()}

function bScores(items){var h='<div class="sec"><div class="sh">&#9881; Quality Scores <span class="hn">1=Poor 10=Excellent</span></div><div class="sgr">';for(var i=0;i<items.length;i++)h+='<div class="sc"><div class="sl">'+items[i]+' <span class="sv hi" id="v'+i+'">7</span></div><input type="range" min="1" max="10" value="7" data-i="'+i+'"></div>';return h+'</div></div>'}

function bChk(items){var h='<div class="sec"><div class="sh">&#9989; Checklist</div>';for(var i=0;i<items.length;i++)h+='<div class="ck"><div class="cb"></div><div class="tx">'+items[i][0]+(items[i][1]?' <span class="rq">*</span>':'')+'</div></div>';return h+'</div>'}

function bFields(items){var h='<div class="sec"><div class="sh">&#128221; Details</div>';for(var i=0;i<items.length;i++){h+='<div class="fd"><label>'+items[i][0]+'</label>';if(Array.isArray(items[i][1])){h+='<select><option value="">Select...</option>';for(var k=0;k<items[i][1].length;k++)h+='<option>'+items[i][1][k]+'</option>';h+='</select>'}else h+='<input type="'+(items[i][1]||'text')+'" placeholder="">';h+='</div>'}return h+'</div>'}

function bPhotos(items){var h='<div class="sec"><div class="sh">&#128248; Required Photos <span class="hn pc">0 of '+items.length+'</span></div><div class="pg">';for(var i=0;i<items.length;i++)h+='<div class="ps" data-idx="'+i+'"><div class="tm" id="pt'+i+'">&#128247;</div><div class="pl">'+items[i]+'</div><input type="file" accept="image/*" id="pfc'+i+'" capture="environment" onchange="onPhoto('+i+',this)"><input type="file" accept="image/*" id="pfl'+i+'" onchange="onPhoto('+i+',this)"><div class="rm" onclick="rmPhoto(event,'+i+')">&#215;</div></div>';return h+'</div></div>'}

function bVio(){return '<div class="vi"><div class="vh">&#9888; Safety Violations<div class="vc"><button class="vn on" data-v="0">0</button><button class="vn" data-v="1">1</button><button class="vn" data-v="2">2</button><button class="vn" data-v="3">3+</button></div></div><div class="vb" id="vbd"><label style="font-size:10px;font-weight:600;color:#757575">Describe *</label><textarea placeholder="Describe issue..."></textarea></div></div>'}

function openPicker(idx){pickerIdx=idx;syncPickerUi();document.getElementById('pModal').classList.add('show')}
function closePicker(){document.getElementById('pModal').classList.remove('show');pickerIdx=null}
function pickCamera(){if(pickerIdx==null)return;closePicker();document.getElementById('pfc'+pickerIdx).click()}
function pickLibrary(){if(pickerIdx==null)return;closePicker();document.getElementById('pfl'+pickerIdx).click()}

function onPhoto(idx,input){if(!input.files||!input.files[0])return;var file=input.files[0];var reader=new FileReader();reader.onload=function(e){photoData[idx]=e.target.result;var tm=document.getElementById('pt'+idx);tm.className='tm has';tm.innerHTML='<img src="'+e.target.result+'">';upc();toast('Photo added')};reader.readAsDataURL(file)}

function rmPhoto(ev,idx){ev.stopPropagation();delete photoData[idx];var tm=document.getElementById('pt'+idx);tm.className='tm';tm.innerHTML='&#128247;';document.getElementById('pfc'+idx).value='';document.getElementById('pfl'+idx).value='';upc()}

function bindEv(){var cks=document.querySelectorAll('.ck');for(var i=0;i<cks.length;i++)cks[i].onclick=function(){var cb=this.querySelector('.cb');if(cb)cb.classList.toggle('on')};
var pss=document.querySelectorAll('.ps');for(var i=0;i<pss.length;i++){(function(ps){ps.querySelector('.tm').onclick=function(){if(!this.classList.contains('has')){openPicker(parseInt(ps.dataset.idx,10))}}})(pss[i])}
var sls=document.querySelectorAll('input[type=range]');for(var i=0;i<sls.length;i++)sls[i].oninput=function(){var v=parseInt(this.value,10),el=document.getElementById('v'+this.dataset.i);if(el){el.textContent=v;el.className='sv '+(v<=4?'lo':v<=6?'md':'hi')}};
var vns=document.querySelectorAll('.vn');for(var i=0;i<vns.length;i++)vns[i].onclick=function(){var btns=this.parentElement.querySelectorAll('button');for(var k=0;k<btns.length;k++)btns[k].classList.remove('on');this.classList.add('on');var bd=document.getElementById('vbd');if(bd)bd.className='vb'+(this.dataset.v!='0'?' show':'')};makeClickable()}

function upc(){var t=document.querySelectorAll('.ps').length,d=Object.keys(photoData).length;var pc=document.querySelector('.pc');if(pc){pc.textContent=d+' of '+t;pc.style.color=d>=t?'#2E7D32':''}}

function show(id){var ss=document.querySelectorAll('.scr');for(var i=0;i<ss.length;i++)ss[i].classList.remove('on');document.getElementById(id).classList.add('on');window.scrollTo(0,0);setTimeout(makeClickable,0)}

function back(){if(document.getElementById('s3').classList.contains('on')){show('s2');document.getElementById('h1').textContent=cFM+"'s Route";document.getElementById('h2').textContent=D.j[cFM].length+' stops'}else if(document.getElementById('s2').classList.contains('on')){show('s1');document.getElementById('h1').textContent='LOVING Field Dispatch';document.getElementById('h2').textContent='Select your route';document.getElementById('bk').style.display='none'}}

function formKey(){return 'loving-dispatch:'+cFM+':'+cJob[0]+':'+cJob[8]}
function collectForm(){var root=document.getElementById('fc'),fields=root.querySelectorAll('input:not([type=file]),select,textarea'),checks=root.querySelectorAll('.cb'),vals=[],ck=[],vn=root.querySelector('.vn.on');for(var i=0;i<fields.length;i++)vals.push(fields[i].value);for(var k=0;k<checks.length;k++)ck.push(checks[k].classList.contains('on'));return{values:vals,checks:ck,violation:vn?vn.dataset.v:'0',photos:photoData}}
function restoreForm(){if(!cJob)return;try{var raw=localStorage.getItem(formKey());if(!raw)return;var data=JSON.parse(raw),root=document.getElementById('fc'),fields=root.querySelectorAll('input:not([type=file]),select,textarea'),checks=root.querySelectorAll('.cb');if(data.values)for(var i=0;i<fields.length&&i<data.values.length;i++){fields[i].value=data.values[i];if(fields[i].type=='range'&&fields[i].oninput)fields[i].oninput()}if(data.checks)for(var k=0;k<checks.length&&k<data.checks.length;k++)checks[k].classList.toggle('on',!!data.checks[k]);if(data.violation){var btn=root.querySelector('.vn[data-v="'+data.violation+'"]');if(btn)btn.click()}photoData=data.photos||{};for(var p in photoData){var tm=document.getElementById('pt'+p);if(tm){tm.className='tm has';tm.innerHTML='<img src="'+photoData[p]+'">'}}upc()}catch(e){}}
function saveForm(){try{localStorage.setItem(formKey(),JSON.stringify(collectForm()));toast('Form saved locally')}catch(e){toast('Save failed: storage full')}}

function sub(){var cks=document.querySelectorAll('#s3 .cb').length;var done=document.querySelectorAll('#s3 .cb.on').length;var totalP=document.querySelectorAll('.ps').length;var doneP=Object.keys(photoData).length;var issues=[];if(cks>0&&done<cks)issues.push('Checklist: '+done+'/'+cks);if(totalP>0&&doneP<totalP)issues.push('Photos: '+doneP+'/'+totalP);if(issues.length){toast('Missing: '+issues.join(', '));return}
toast('Submitted: '+cJob[4]+' #'+cJob[0]);setTimeout(function(){back()},1500)}

setGridStatus('Loading routes','Reading '+DATA_FILE+'...');
makeClickable();
syncPickerUi();
loadDispatchData();
