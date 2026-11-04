const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const http=require('node:http');
const {execFileSync}=require('node:child_process');
const {chromium}=require('playwright');

const root=path.resolve(__dirname,'..');
let server,browser,base;
const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
before(async()=>{
  // Test-only hooks are appended to the served module, never the shipping file.
  const html=(await fs.readFile(path.join(root,'index.html'),'utf8')).replace('</script>',`\nwindow.__astra={G,K,Kl,Rl,Ul,sl,j_,tl,qc,Uc,Go,Wo,dl,nu,tu,F_,L_,asImportFdx,asSceneLabel,asSyncScriptNumbers,asBreakupPlan,asBreakupExport,asReclaimMedia,asMediaPut,asMediaHydrate,asMediaPortable,asGenerationVariables,asMergeAnalysis,asRenderAssembly,asMediaRecords,asMediaUrls,setMirror:v=>El=v,setWritable:v=>Il.canWrite=v};</script>`);
  server=http.createServer((req,res)=>{res.setHeader('content-type','text/html');res.end(html)});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  base=`http://127.0.0.1:${server.address().port}/index.html`;
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-background-timer-throttling','--disable-renderer-backgrounding']});
  await fs.mkdir(path.join(root,'test-results'),{recursive:true});
});
after(async()=>{await browser?.close();await new Promise(resolve=>server?.close(resolve));});
async function session(t){
  const context=await browser.newContext();t.after(()=>context.close());
  const page=await context.newPage();
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  t.after(()=>assert.deepEqual(errors,[],'uncaught browser errors'));
  await page.addInitScript(()=>{window.__writes=[];const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(v,k){window.__writes.push(k);return put.apply(this,arguments)}});
  await page.goto(base);await page.waitForFunction(()=>window.__astra?.G.getState().hydrated&&window.__astra.Kl.getState().hydrated);
  await page.waitForTimeout(1000);
  return page;
}
function mediaDuration(file){
  const packets=JSON.parse(execFileSync('ffprobe',['-v','error','-show_packets','-show_entries','packet=pts_time,duration_time','-of','json',file],{encoding:'utf8',maxBuffer:10*1024*1024})).packets;
  return Math.max(...packets.map(p=>Number(p.pts_time||0)+Number(p.duration_time||0)));
}
const scriptLabels=['1','1A','1B','2','3','4','4A','4B'];
async function importNumberedScript(page){
  await page.evaluate(()=>window.__astra.nu({title:'Numbered screenplay'}));
  await page.goto(base+'#/script');
  await page.getByRole('complementary',{name:'Script scenes and versions'}).waitFor();
  await page.locator('main input[type=file]').setInputFiles(path.join(__dirname,'fixtures','numbered-screenplay.fdx'));
  await page.waitForFunction(()=>document.body.innerText.includes('Raw Scene Count: 8'));
}

test('FDX imports as a professionally aligned screenplay with original scene labels and rich text',async t=>{
  const page=await session(t);await importNumberedScript(page);
  const script=page.getByRole('article',{name:'Formatted screenplay'});
  assert.deepEqual(await script.locator('[data-script-scene]').evaluateAll(nodes=>nodes.map(n=>n.dataset.scriptScene)),scriptLabels);
  assert.doesNotMatch(await script.innerText(),/NOT SCREENPLAY CONTENT/);
  assert.equal(await script.getByText('CUT TO:',{exact:true}).count(),1);
  assert.equal(await script.getByText('FADE OUT.',{exact:true}).count(),1);
  assert.equal(await script.locator('.astra-screenplay-dual > div').count(),2);
  assert.equal(await script.getByText('please.',{exact:true}).evaluate(node=>getComputedStyle(node).fontStyle),'italic');
  const action=await script.locator('.astra-screenplay-action').first().boundingBox(),cue=await script.locator('.astra-screenplay-character').first().boundingBox(),dialogue=await script.locator('.astra-screenplay-dialogue').first().boundingBox(),parenthetical=await script.locator('.astra-screenplay-parenthetical').first().boundingBox();
  assert.ok(action.x<dialogue.x&&dialogue.x<parenthetical.x&&parenthetical.x<cue.x,'industry-style dialogue and parenthetical indents');
  assert.equal(await script.getByText('CUT TO:',{exact:true}).evaluate(node=>getComputedStyle(node).textAlign),'right');
  assert.match(await page.getByRole('complementary',{name:'Script scenes and versions'}).innerText(),/Script scene 1A\nRaw scene 2/);
  await page.getByRole('button',{name:'Save version',exact:true}).click();
  await page.getByRole('button',{name:'Edit source',exact:true}).click();await page.getByRole('textbox',{name:'Screenplay source'}).fill('INT. ALTERED - DAY #9#\n\nAltered.');
  await page.getByRole('button',{name:'restore',exact:true}).click();await page.getByRole('button',{name:'Screenplay',exact:true}).click();
  assert.equal(await script.getByText('please.',{exact:true}).evaluate(node=>getComputedStyle(node).fontStyle),'italic');
  await page.evaluate(()=>window.__astra.Ul());await page.reload();await page.waitForFunction(()=>window.__astra?.G.getState().hydrated);
  assert.deepEqual(await script.locator('[data-script-scene]').evaluateAll(nodes=>nodes.map(n=>n.dataset.scriptScene)),scriptLabels);
  await page.screenshot({path:path.join(root,'test-results','screenplay-preview.png'),fullPage:true});
});

test('breakdown and shot exports preserve 1A/1B labels independently from numeric raw counts',async t=>{
  const page=await session(t);await importNumberedScript(page);await page.getByRole('button',{name:'Analyze',exact:true}).click();
  await page.waitForFunction(()=>window.__astra.G.getState().project.scenes.length===8);
  const project=await page.evaluate(()=>window.__astra.G.getState().project);
  assert.deepEqual(project.scenes.map(s=>s.scriptNumber),scriptLabels);assert.deepEqual(project.scenes.map(s=>s.number),[1,2,3,4,5,6,7,8]);
  const beforeIds=project.shots.map(s=>s.id);
  const past=await page.evaluate(()=>window.__astra.G.getState().past.length);await page.getByRole('button',{name:'Analyze',exact:true}).click();
  await page.waitForFunction(count=>window.__astra.G.getState().past.length>count,past);
  assert.deepEqual(await page.evaluate(()=>window.__astra.G.getState().project.shots.map(s=>s.id)),beforeIds);
  const links=await page.evaluate(()=>{
    const a=window.__astra,p=a.G.getState().project;
    const result=a.asBreakupPlan({characters:[{name:'MEERA',description:'Updated safely'}],costumes:[{name:'Travel coat',characterName:'MEERA',sceneNumbers:['1A','4B']}]},p);
    a.G.getState().set(()=>result.next);
    const costume=result.next.costumes.find(c=>c.name==='Travel coat');
    return {labels:costume.sceneIds.map(id=>a.asSceneLabel(result.next.scenes.find(s=>s.id===id))),character:result.next.characters.find(c=>c.id===costume.characterId)?.name,exported:a.asBreakupExport(result.next).costumes.find(c=>c.name==='Travel coat').sceneNumbers};
  });
  assert.deepEqual(links,{labels:['1A','4B'],character:'MEERA',exported:['1A','4B']});
  await page.goto(base+'#/project');
  assert.equal(await page.getByText('SC 1A',{exact:true}).count(),1);
  let download=page.waitForEvent('download');await page.getByRole('button',{name:'JSON',exact:true}).click();
  const exported=path.join(root,'test-results','numbered-shots.json');await(await download).saveAs(exported);
  const shots=JSON.parse(await fs.readFile(exported,'utf8'));assert.ok(shots.some(s=>s.scene==='1A'&&s.code.startsWith('S1A-SH')));assert.ok(shots.some(s=>s.scene==='4B'&&s.rawScene===8));
  await page.goto(base+'#/io');download=page.waitForEvent('download');await page.getByRole('button',{name:'Download project (.ffproj.json)',exact:true}).click();
  const backup=path.join(root,'test-results','numbered.ffproj.json');await(await download).saveAs(backup);
  const fresh=await session(t);await fresh.goto(base+'#/io');await fresh.locator('input[type=file]').last().setInputFiles(backup);await fresh.getByRole('button',{name:'Apply import',exact:true}).click();
  assert.deepEqual(await fresh.evaluate(()=>window.__astra.G.getState().project.scenes.map(s=>s.scriptNumber)),scriptLabels);
  await fresh.goto(base+'#/script');assert.equal(await fresh.getByText('Script scene 4B',{exact:true}).count(),1);
});

test('Fountain scene markers and prefixed labels parse without treating transitions as dialogue',async t=>{
  const page=await session(t);
  const parsed=await page.evaluate(()=>window.__astra.tl('FADE IN:\n\n1 INT. ROOM - DAY 1\n\nA chair.\n\nRAVI\n(softly)\nHello.\n\nCUT TO:\n\nINT. ROOM - NIGHT #1A#\n\nA lamp.\n\n1B EXT. ROAD - DAY 1B\n\nAn empty road.\n\nFADE OUT.'));
  assert.deepEqual(parsed.map(s=>s.scriptNumber),['1','1A','1B']);assert.deepEqual(parsed.map(s=>s.time),['DAY','NIGHT','DAY']);assert.deepEqual(parsed[0].dialogue,[{character:'RAVI',line:'Hello.'}]);
  const rejected=await page.evaluate(()=>{try{window.__astra.asImportFdx('<!DOCTYPE FinalDraft [<!ENTITY bad "x">]><FinalDraft><Content/></FinalDraft>');return false}catch{return true}});assert.equal(rejected,true);
});

test('removed scenes stay outside active script counts and their production work returns when reintroduced',async t=>{
  const page=await session(t);await importNumberedScript(page);await page.getByRole('button',{name:'Analyze',exact:true}).click();await page.waitForFunction(()=>window.__astra.G.getState().project.scenes.length===8);
  const shots=await page.evaluate(()=>window.__astra.G.getState().project.shots.map(s=>s.id).sort());
  await page.getByRole('button',{name:'Edit source',exact:true}).click();await page.getByRole('textbox',{name:'Screenplay source'}).fill('INT. TEA STALL - NIGHT #1#\n\nOne remaining scene.');
  await page.getByRole('button',{name:'Analyze',exact:true}).click();await page.waitForFunction(()=>window.__astra.G.getState().project.scenes.length===1);
  assert.deepEqual(await page.evaluate(()=>window.__astra.G.getState().project.scenes.map(s=>s.scriptNumber)),['1']);
  assert.equal(await page.evaluate(()=>window.__astra.G.getState().project.archivedScenes.length),7);
  assert.deepEqual(await page.evaluate(()=>{const p=window.__astra.G.getState().project;return [...p.shots,...p.archivedShots].map(s=>s.id).sort()}),shots);
  assert.equal(await page.getByRole('heading',{name:'Retained production scenes'}).count(),1);
  await page.locator('main input[type=file]').setInputFiles(path.join(__dirname,'fixtures','numbered-screenplay.fdx'));
  await page.getByRole('button',{name:'Analyze',exact:true}).click();await page.waitForFunction(()=>window.__astra.G.getState().project.scenes.length===8);
  assert.deepEqual(await page.evaluate(()=>window.__astra.G.getState().project.shots.map(s=>s.id).sort()),shots);
  assert.equal(await page.evaluate(()=>window.__astra.G.getState().project.archivedScenes.length),0);
});

test('LLM analysis uses authoritative script scene labels even when model IDs and numbers change',async t=>{
  const page=await session(t);await importNumberedScript(page);
  const response=await page.evaluate(()=>{
    const a=window.__astra,p=a.sl(a.G.getState().project);
    p.scenes=p.scenes.map((scene,index)=>({...scene,number:index+101,scriptNumber:'MODEL-'+index}));
    return JSON.stringify(p);
  });
  await page.route('https://numbered-llm.test/chat/completions',route=>route.fulfill({json:{choices:[{message:{content:response}}]}}));
  await page.evaluate(()=>window.__astra.K.getState().update({llm:[{id:'numbered',kind:'openai',name:'test',baseUrl:'https://numbered-llm.test',model:'test',apiKey:''}],activeLlmId:'numbered'}));
  await page.getByRole('button',{name:'Analyze',exact:true}).click();await page.waitForFunction(()=>window.__astra.G.getState().project.scenes.length===8);
  assert.deepEqual(await page.evaluate(()=>window.__astra.G.getState().project.scenes.map(s=>s.scriptNumber)),scriptLabels);
});

test('storyboard shot labels stay above the frame for below, right and hidden captions',async t=>{
  const page=await session(t);await importNumberedScript(page);await page.getByRole('button',{name:'Analyze',exact:true}).click();await page.waitForFunction(()=>window.__astra.G.getState().project.shots.length>0);
  await page.goto(base+'#/pdf');
  const caption=page.locator('main aside').getByText('Caption',{exact:true}).locator('..').locator('select');
  for(const mode of ['below','right','none']){
    await caption.selectOption(mode);
    const positions=await page.locator('main .astra-storyboard-visual').evaluateAll(nodes=>nodes.map(node=>{const label=node.querySelector('.astra-storyboard-label').getBoundingClientRect(),frame=node.querySelector('.astra-storyboard-frame').getBoundingClientRect();return{text:node.querySelector('.astra-storyboard-label').textContent,labelBottom:label.bottom,frameTop:frame.top,labelLeft:label.left,frameLeft:frame.left,frameWidth:frame.width,frameHeight:frame.height}}));
    assert.ok(positions.length>0);assert.ok(positions.some(p=>p.text.startsWith('S1A-SH')));
    assert.ok(positions.every(p=>p.labelBottom<=p.frameTop&&Math.abs(p.labelLeft-p.frameLeft)<1&&p.frameHeight>0&&p.frameWidth>0),'labels are outside the top-left frame edge');
  }
  await page.locator('main .astra-storyboard-visual').first().scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(root,'test-results','storyboard-labels.png'),fullPage:true});
  await page.emulateMedia({media:'print'});
  const pdf=await page.pdf({path:path.join(root,'test-results','numbered-storyboard.pdf'),preferCSSPageSize:true,printBackground:true});assert.equal(pdf.subarray(0,5).toString(),'%PDF-');
});

test('all screens load; idle autosave stops; changed content mirrors once',async t=>{
  const page=await session(t);
  for(const label of ['Projects','Home','Project Setup','Skills','Connections','Script','Breakup','Production','Rough Cut','Production Control','Import / Export','PDF Export','Settings','Studio PRD']){
    await page.locator('aside a').filter({hasText:new RegExp('^\\s*'+label+'$')}).click();
    assert.ok(await page.locator('h1').count()>=1,label);
  }
  const writes=await page.evaluate(()=>window.__writes.length);
  await page.waitForTimeout(1600);
  assert.equal(await page.evaluate(()=>window.__writes.length),writes,'no writes while idle');
  await page.evaluate(()=>{
    const a=window.__astra;window.__mirrorWrites=[];
    const dir={queryPermission:async()=> 'granted',getDirectoryHandle:async()=>dir,getFileHandle:async name=>({createWritable:async()=>({write:async text=>window.__mirrorWrites.push({name,text}),close:async()=>{}})})};
    a.setMirror(dir);a.G.getState().set(p=>({...p,meta:{...p.meta,title:'Mirror regression'}}));
  });
  await page.waitForFunction(()=>window.__mirrorWrites?.some(w=>w.name==='project.json'),null,{timeout:6000});
  const mirror=await page.evaluate(()=>window.__mirrorWrites);
  assert.equal(mirror.filter(w=>w.name==='project.json').length,1);
  const count=await page.evaluate(()=>window.__writes.length);
  await page.waitForTimeout(1200);
  assert.equal(await page.evaluate(()=>window.__writes.length),count);
});

test('Home combines project details and live dashboard progress; old dashboard links redirect',async t=>{
  const page=await session(t);
  assert.equal(await page.locator('aside a').filter({hasText:/^\s*Dashboard$/}).count(),0);
  assert.equal(await page.getByRole('heading',{name:'The Red Umbrella',exact:true}).count(),1);
  assert.equal(await page.getByRole('heading',{name:'Production overview',exact:true}).count(),1);
  for(const text of ['Stage reached (% of shots)','Scenes × shots heat map','Film timeline','Missing images','Missing videos','Generated runtime','Failed jobs'])assert.equal(await page.getByText(text,{exact:true}).count(),1,text);
  const missing=page.getByText('Missing images',{exact:true}).locator('..');
  assert.match(await missing.innerText(),/6/);
  await page.evaluate(()=>{const a=window.__astra;a.G.getState().updateShot(a.G.getState().project.shots[0].id,{stage:'image',image:{versions:[{id:'test',url:'https://example.test/unused-frame.png',createdAt:1,source:'upload'}],approvedId:null}})});
  assert.match(await missing.innerText(),/5/);
  await page.goto(base+'#/dashboard');
  await page.waitForURL(url=>url.hash==='#/');
  assert.equal(await page.getByRole('heading',{name:'Production overview',exact:true}).count(),1);
  assert.equal(await page.title(),'Home — ASTRA Studio');
});

test('Home banner upload persists per project, supports reset/undo and survives backup import',async t=>{
  const page=await session(t),banner=page.getByRole('region',{name:'Home banner',exact:true});
  const originalId=await page.evaluate(()=>window.__astra.Kl.getState().activeId);
  const originalThumbnail=await page.evaluate(()=>window.__astra.G.getState().project.meta.thumbnail);
  await banner.locator('input[type=file]').setInputFiles({name:'banner.png',mimeType:'image/png',buffer:Buffer.from(image.split(',')[1],'base64')});
  await page.waitForFunction(()=>window.__astra.G.getState().project.meta.bannerImage?.startsWith('blob:'));
  await banner.getByRole('img',{name:'Project banner'}).evaluate(img=>img.decode());
  assert.match(await banner.getByRole('img').getAttribute('src'),/^blob:/);
  assert.equal(await page.evaluate(()=>window.__astra.G.getState().project.meta.thumbnail),originalThumbnail);
  await page.evaluate(()=>window.__astra.Ul());await page.reload();
  await page.waitForFunction(()=>window.__astra?.G.getState().hydrated);
  await banner.getByRole('img').evaluate(img=>img.decode());assert.match(await banner.getByRole('img').getAttribute('src'),/^blob:/);
  await page.evaluate(()=>window.__astra.nu({title:'Second film'}));
  assert.equal(await page.evaluate(()=>window.__astra.G.getState().project.meta.bannerImage),'');
  assert.match(await banner.getByRole('img').getAttribute('src'),/^data:image/);
  await page.evaluate(id=>window.__astra.tu(id),originalId);
  assert.match(await banner.getByRole('img').getAttribute('src'),/^blob:/);
  await banner.getByRole('button',{name:'Reset banner',exact:true}).click();
  assert.match(await banner.getByRole('img').getAttribute('src'),/^data:image/);
  await page.keyboard.press('Control+z');
  await page.waitForFunction(()=>window.__astra.G.getState().project.meta.bannerImage?.startsWith('blob:'));
  // Undecodable images leave the previous banner intact and surface a file error.
  const before=await banner.getByRole('img').getAttribute('src');
  await banner.locator('input[type=file]').setInputFiles({name:'invalid.png',mimeType:'image/png',buffer:Buffer.from('not an image')});
  await page.waitForFunction(()=>document.body.innerText.includes('File could not be processed'));
  assert.equal(await banner.getByRole('img').getAttribute('src'),before);
  await page.goto(base+'#/io');
  const downloaded=page.waitForEvent('download');await page.getByRole('button',{name:'Download project (.ffproj.json)',exact:true}).click();
  const backupPath=path.join(root,'test-results','banner.ffproj.json');await(await downloaded).saveAs(backupPath);
  const backup=JSON.parse(await fs.readFile(backupPath,'utf8'));assert.equal(backup.meta.bannerImage,image);
  const fresh=await session(t);await fresh.goto(base+'#/io');
  await fresh.locator('input[type=file]').last().setInputFiles(backupPath);await fresh.getByRole('button',{name:'Apply import',exact:true}).click();
  await fresh.locator('aside a').filter({hasText:/^\s*Home$/}).click();
  const restored=fresh.getByRole('region',{name:'Home banner'}).getByRole('img');await restored.evaluate(img=>img.decode());
  assert.match(await restored.getAttribute('src'),/^blob:/);
  assert.equal(await fresh.evaluate(async()=> (await window.__astra.asMediaPortable(window.__astra.G.getState().project)).meta.bannerImage),image);
});

test('save failures retain last success; read-only flush does not write',async t=>{
  const page=await session(t);
  const result=await page.evaluate(async()=>{
    const a=window.__astra,last=a.G.getState().lastSaved,put=IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put=function(v,k){if(k==='filmforge-project')throw new DOMException('Disk full','QuotaExceededError');return put.apply(this,arguments)};
    a.G.getState().set(p=>({...p,meta:{...p.meta,title:'Failure test'}}));
    await a.Ul();await new Promise(r=>setTimeout(r,100));
    const unchanged=a.G.getState().lastSaved===last;
    IDBObjectStore.prototype.put=put;
    a.setWritable(false);const before=window.__writes.length;await a.Ul();const readOnly=window.__writes.length===before;
    a.setWritable(true);await a.Ul();return {unchanged,readOnly,saved:a.G.getState().lastSaved>last};
  });
  assert.deepEqual(result,{unchanged:true,readOnly:true,saved:true});
});

test('offline and LLM reanalysis preserve edits, approved media and removed scenes',async t=>{
  const page=await session(t);
  const result=await page.evaluate(()=>{
    const a=window.__astra,p=structuredClone(a.qc);
    p.shots[0].action='Hand-edited action';p.shots[0].duration=8.5;p.shots[0].stage='locked';
    p.shots[0].image={versions:[{id:'approved',url:'https://example.test/frame.png',createdAt:1,source:'upload'}],approvedId:'approved'};
    const initial=JSON.stringify(p.shots),oldIds=p.scenes.map(s=>s.id);
    p.script='EXT. NEW LOCATION - DAY\n\nNew action.\n\n'+p.script;
    const next=a.sl(p),repeat=a.sl(next);
    const incoming=structuredClone(a.qc);incoming.characters[0].id='renamed-ravi';incoming.scenes[0].id='renamed-scene';incoming.shots.forEach(s=>{if(s.sceneId===a.qc.scenes[0].id)s.sceneId='renamed-scene';s.characterIds=s.characterIds.map(id=>id===a.qc.characters[0].id?'renamed-ravi':id)});
    const ai=a.asMergeAnalysis(p,incoming),removed=a.sl({...p,script:'EXT. NEW LOCATION - DAY\n\nOnly one scene now.'});
    return {preserved:next.shots.filter(s=>p.shots.some(old=>old.id===s.id)),initial:JSON.parse(initial),scenes:next.scenes.length,oldIdsPresent:oldIds.every(id=>next.scenes.some(s=>s.id===id)),repeat:JSON.stringify(next)===JSON.stringify(repeat),aiPreserved:JSON.stringify(ai.shots)===initial,removedRetained:oldIds.every(id=>[...removed.scenes,...removed.archivedScenes].some(s=>s.id===id))};
  });
  assert.deepEqual(result.preserved,result.initial);assert.equal(result.scenes,3);assert.equal(result.oldIdsPresent,true);assert.equal(result.repeat,true);assert.equal(result.aiPreserved,true);assert.equal(result.removedRetained,true);
  await page.goto(base+'#/script');await page.getByRole('button',{name:'Analyze',exact:true}).click();
  await page.waitForFunction(()=>document.body.innerText.includes('Existing')||document.body.innerText.includes('2 scenes · 6 shots · 2 characters'));
});

test('media is deduplicated, snapshots stay small and portable backups reopen in a fresh browser',async t=>{
  const page=await session(t);
  const result=await page.evaluate(async data=>{
    const a=window.__astra,blob=await(await fetch(data)).blob();
    const first=await a.dl(blob),second=await a.asMediaPut(blob);
    a.G.getState().set(p=>({...p,shots:p.shots.map((s,i)=>i?s:{...s,image:{versions:[{id:'media-test',url:first,createdAt:1,source:'upload'}],approvedId:'media-test'}})}));
    a.G.getState().snapshot('media');await a.Ul();
    const raw=await a.Wo('filmforge-project');
    return {same:first===second,blobs:a.asMediaRecords.size,raw,portable:await a.asMediaPortable(a.G.getState().project)};
  },image);
  assert.equal(result.same,true);assert.equal(result.blobs,1);assert.match(result.raw,/astra-media:/);assert.doesNotMatch(result.raw,/data:image|blob:/);assert.ok(result.raw.length<60000);
  assert.equal(result.portable.shots[0].image.versions[0].url,image);
  await page.reload();await page.waitForFunction(()=>window.__astra?.G.getState().hydrated);
  assert.equal(await page.evaluate(()=>window.__astra.G.getState().project.shots[0].image.versions[0].url.startsWith('blob:')),true);
  await page.goto(base+'#/io');
  const downloaded=page.waitForEvent('download');await page.getByRole('button',{name:'Download project (.ffproj.json)',exact:true}).click();
  const backup=await downloaded,backupPath=path.join(root,'test-results','portable.ffproj.json');await backup.saveAs(backupPath);
  const backupJSON=JSON.parse(await fs.readFile(backupPath,'utf8'));
  assert.equal(backupJSON.shots[0].image.versions[0].url,image);
  const fresh=await session(t);await fresh.goto(base+'#/io');
  await fresh.locator('input[type=file]').last().setInputFiles(backupPath);
  await fresh.getByRole('button',{name:'Apply import',exact:true}).click();await fresh.waitForTimeout(800);await fresh.reload();
  await fresh.waitForFunction(()=>window.__astra?.G.getState().hydrated);
  const roundtrip=await fresh.evaluate(()=>window.__astra.asMediaPortable(window.__astra.G.getState().project));
  assert.deepEqual(roundtrip,backupJSON);
});

test('ComfyUI and web API requests use project FPS and the target shot duration',async t=>{
  const page=await session(t),requests=[];
  await page.route('https://comfy.test/**',async route=>{
    const u=new URL(route.request().url());
    if(u.pathname==='/prompt'){requests.push(route.request().postDataJSON());return route.fulfill({json:{prompt_id:'render'}})}
    if(u.pathname==='/history/render')return route.fulfill({json:{render:{outputs:{one:{images:[{filename:'frame.png',subfolder:'',type:'output'}]}}}}});
    if(u.pathname==='/view')return route.fulfill({contentType:'image/png',body:Buffer.from(image.split(',')[1],'base64')});
    throw Error('Unexpected request '+u);
  });
  await page.route('https://api.test/generate',async route=>{requests.push(route.request().postDataJSON());await route.fulfill({json:{data:[{url:image}]}})});
  const statuses=await page.evaluate(async()=>{
    const a=window.__astra;a.G.getState().set(p=>({...p,meta:{...p.meta,frameRate:30},shots:p.shots.map((s,i)=>i?s:{...s,duration:7.25})}));
    const target={shotId:a.G.getState().project.shots[0].id};
    const template='{"fps":"{{fps}}","duration":"{{duration}}","frames":"{{frames}}","num_frames":"{{num_frames}}"}';
    await a.F_({kind:'image',target,prompt:'test',negative:'',label:'test',workflow:{id:'test',json:template},server:{id:'test',url:'https://comfy.test'}});
    await a.L_({kind:'image',target,prompt:'test',negative:'',label:'test',api:{name:'test',endpoint:'https://api.test/generate',template,authHeader:'',responsePath:'data.0.url'}});
    return a.K.getState().jobs.map(j=>j.status);
  });
  assert.deepEqual(statuses,['done','done']);
  const expected={fps:30,duration:7.25,frames:218,num_frames:218};
  assert.deepEqual(requests[0].prompt,expected);assert.deepEqual(requests[1],expected);
});

test('media cleanup retains undo, snapshots and other projects',async t=>{
  const page=await session(t);
  const result=await page.evaluate(async data=>{
    const a=window.__astra,base=await(await fetch(data)).blob(),urls=[];
    for(let i=0;i<5;i++)urls.push(await a.asMediaPut(new Blob([base,String(i)],{type:base.type})));
    const attach=url=>a.G.getState().set(p=>({...p,shots:p.shots.map((s,i)=>i?s:{...s,image:{versions:[{id:'gc',url,createdAt:1,source:'upload'}],approvedId:'gc'}})}));
    attach(urls[0]);attach(urls[1]);a.G.getState().snapshot('keep');attach(urls[2]);
    await a.Go('ff-proj:other',{image:a.asMediaUrls.get(urls[3])});
    for(const record of a.asMediaRecords.values())record.createdAt=0;
    const result=await a.asReclaimMedia();
    return {...result,retained:await Promise.all(urls.slice(0,4).map(url=>fetch(url).then(r=>r.ok))),orphanExists:!!await a.Wo([...a.asMediaUrls.entries()].find(([url])=>url===urls[4])?.[1]||'missing')};
  },image);
  assert.equal(result.removed,1);assert.deepEqual(result.retained,[true,true,true,true]);assert.equal(result.orphanExists,false);
});

test('legacy embedded-media storage migrates without losing bytes',async t=>{
  const page=await session(t);
  await page.evaluate(async data=>{
    const a=window.__astra,p=structuredClone(a.qc);p.meta.thumbnail=data;
    await a.Go('filmforge-project',JSON.stringify({state:{project:p,snapshots:[]},version:0}));
  },image);
  await page.reload();await page.waitForFunction(()=>window.__astra?.G.getState().hydrated);
  const migrated=await page.evaluate(async()=>{const a=window.__astra;await a.Ul();return{raw:await a.Wo('filmforge-project'),thumbnail:(await a.asMediaPortable(a.G.getState().project)).meta.thumbnail}});
  assert.equal(migrated.thumbnail,image);assert.match(migrated.raw,/astra-media:/);assert.doesNotMatch(migrated.raw,/data:image|blob:/);
});

test('missing saved media never overwrites a project with the default sample',async t=>{
  const page=await session(t);
  const original=await page.evaluate(async()=>{
    const a=window.__astra,p=structuredClone(a.qc);p.meta.title='Protected project';p.meta.thumbnail='astra-media:missing-file:image/png';
    const raw=JSON.stringify({state:{project:p,snapshots:[]},version:0});
    a.setWritable(false);await a.Go('filmforge-project',raw);return raw;
  });
  await page.reload();await page.waitForFunction(()=>window.__astra?.G.getState().storageError);
  await page.waitForTimeout(1000);
  assert.equal(await page.evaluate(()=>window.__astra.Wo('filmforge-project')),original);
  assert.match(await page.getByRole('alert').innerText(),/Automatic writes are disabled/);
  const backup=await page.evaluate(()=>JSON.stringify(window.__astra.qc));
  await page.goto(base+'#/io');await page.locator('input[type=file]').last().setInputFiles({name:'restore.ffproj.json',mimeType:'application/json',buffer:Buffer.from(backup)});
  await page.getByRole('button',{name:'Apply import',exact:true}).click();await page.waitForTimeout(1000);
  assert.equal(await page.evaluate(()=>window.__astra.G.getState().storageError),'');
  assert.doesNotMatch(await page.evaluate(()=>window.__astra.Wo('filmforge-project')),/missing-file/);
});

test('edits made during an LLM request are not overwritten',async t=>{
  const page=await session(t);let release,requested;
  const requestSeen=new Promise(resolve=>requested=resolve),responseReady=new Promise(resolve=>release=resolve);
  const response=await page.evaluate(()=>JSON.stringify(window.__astra.qc));
  await page.route('https://llm.test/chat/completions',async route=>{requested();await responseReady;await route.fulfill({json:{choices:[{message:{content:response}}]}})});
  await page.evaluate(()=>window.__astra.K.getState().update({llm:[{id:'test',kind:'openai',name:'test',baseUrl:'https://llm.test',model:'test',apiKey:''}],activeLlmId:'test'}));
  await page.goto(base+'#/script');await page.getByRole('button',{name:'Analyze',exact:true}).click();await requestSeen;
  await page.getByRole('button',{name:'Edit source',exact:true}).click();await page.locator('main textarea').fill('INT. EDITED DURING ANALYSIS - DAY\n\nKeep this edit.');release();
  await page.waitForFunction(()=>document.body.innerText.includes('Project changed during analysis'));
  assert.match(await page.locator('main textarea').inputValue(),/Keep this edit/);
});

test('WebM contains source audio, respects timing and cleans up cancellation',async t=>{
  const page=await session(t),fixture=path.join(root,'test-results','tone.webm');
  execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=blue:s=160x90:r=24:d=2','-f','lavfi','-i','sine=frequency=440:duration=2','-c:v','libvpx','-c:a','libopus','-shortest',fixture]);
  const data='data:video/webm;base64,'+(await fs.readFile(fixture)).toString('base64');
  await page.evaluate(async data=>{
    const a=window.__astra,url=await a.asMediaHydrate(data),p=structuredClone(a.qc);
    p.meta.frameRate=24;p.shots=[{...p.shots[0],duration:1.5,video:{versions:[{id:'tone',url,createdAt:1,source:'upload'}],approvedId:'tone'}}];a.G.setState({project:p});
    window.showSaveFilePicker=undefined;
  },data);
  await page.goto(base+'#/assembly');
  assert.equal(await page.locator('main video').count(),1,'blob URL recognized as video');
  const downloaded=page.waitForEvent('download');await page.getByRole('button',{name:'WebM review',exact:true}).click();
  const output=path.join(root,'test-results','audio-review.webm');await(await downloaded).saveAs(output);
  const info=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',output],{encoding:'utf8'}));
  assert.ok(info.streams.some(s=>s.codec_type==='video'));assert.ok(info.streams.some(s=>s.codec_type==='audio'));
  const video=info.streams.find(s=>s.codec_type==='video');assert.ok(Math.abs(video.width/(video.height-32)-2.39)<.01,'picture aspect is retained below the separate shot-label header');
  const seconds=mediaDuration(output);assert.ok(seconds>=1.4 && seconds<2.2,String(seconds));
  // Decode succeeds; separately inspect sample energy to distinguish a silent track.
  const pcm=execFileSync('ffmpeg',['-v','error','-i',output,'-vn','-f','s16le','-ac','1','-ar','8000','-']);
  let peak=0;for(let i=0;i+1<pcm.length;i+=2)peak=Math.max(peak,Math.abs(pcm.readInt16LE(i)));assert.ok(peak>100,'source audio is audible');
  const bottom=execFileSync('ffmpeg',['-v','error','-ss','0.5','-i',output,'-frames:v','1','-vf','crop=100:24:(iw-100)/2:ih-24','-pix_fmt','rgb24','-f','rawvideo','-']);
  for(let i=0;i<bottom.length;i+=3)assert.ok(bottom[i]<40&&bottom[i+1]<40&&bottom[i+2]>150,'picture remains blue and unobstructed down to its bottom edge');
  const header=execFileSync('ffmpeg',['-v','error','-ss','0.5','-i',output,'-frames:v','1','-vf','crop=200:32:0:0','-pix_fmt','rgb24','-f','rawvideo','-']);
  let textPixels=0;for(let i=0;i<header.length;i+=3)if(header[i]>150&&header[i+1]>150&&header[i+2]>150)textPixels++;assert.ok(textPixels>10,'shot code is present in the separate header');
  await page.evaluate(()=>window.__astra.G.getState().updateShot(window.__astra.G.getState().project.shots[0].id,{duration:200}));
  await page.getByRole('button',{name:'WebM review',exact:true}).click();await page.getByRole('button',{name:'Cancel export',exact:true}).click();
  await page.waitForFunction(()=>document.body.innerText.includes('Export cancelled'));
  assert.equal(await page.getByRole('button',{name:'WebM review',exact:true}).isEnabled(),true);
});

test('181-second export streams to a file without clipping a long shot',{skip:!process.env.ASTRA_LONG_TEST,timeout:240000},async t=>{
  const page=await session(t);
  await page.evaluate(async data=>{
    const a=window.__astra,p=structuredClone(a.qc);p.meta.frameRate=12;
    const url=await a.asMediaHydrate(data);
    p.shots=[{...p.shots[0],duration:181,image:{versions:[{id:'still',url,createdAt:1,source:'upload'}],approvedId:'still'}}];a.G.setState({project:p});
    const dir=await navigator.storage.getDirectory(),handle=await dir.getFileHandle('long.webm',{create:true});
    window.showSaveFilePicker=async()=>handle;
    window.__longExport=a.asRenderAssembly({project:p,shots:p.shots,signal:new AbortController().signal,onStatus:status=>window.__exportStatus=status});
  },image);
  const result=await page.evaluate(()=>window.__longExport);
  assert.equal(result.duration,181);
  const downloaded=page.waitForEvent('download');
  await page.evaluate(async()=>{const dir=await navigator.storage.getDirectory(),blob=await(await dir.getFileHandle('long.webm')).getFile(),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='long.webm';a.click()});
  const output=path.join(root,'test-results','long-review.webm');await(await downloaded).saveAs(output);
  const seconds=mediaDuration(output);
  assert.ok(seconds>=180.5&&seconds<184,`actual WebM duration ${seconds}`);
});
