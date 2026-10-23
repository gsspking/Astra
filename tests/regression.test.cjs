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
  const html=(await fs.readFile(path.join(root,'ASTRA_Studio_V4F.html'),'utf8')).replace('</script>',`\nwindow.__astra={G,K,Kl,Rl,Ul,sl,j_,qc,Uc,Go,Wo,dl,F_,L_,asReclaimMedia,asMediaPut,asMediaHydrate,asMediaPortable,asGenerationVariables,asMergeAnalysis,asRenderAssembly,asMediaRecords,asMediaUrls,setMirror:v=>El=v,setWritable:v=>Il.canWrite=v};</script>`);
  server=http.createServer((req,res)=>{res.setHeader('content-type','text/html');res.end(html)});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  base=`http://127.0.0.1:${server.address().port}/ASTRA_Studio_V4F.html`;
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

test('all screens load; idle autosave stops; changed content mirrors once',async t=>{
  const page=await session(t);
  for(const label of ['Projects','Home','Project Setup','Skills','Connections','Script','Breakup','Production','Rough Cut','Production Control','Dashboard','Import / Export','PDF Export','Settings','Studio PRD']){
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
    return {preserved:next.shots.filter(s=>p.shots.some(old=>old.id===s.id)),initial:JSON.parse(initial),scenes:next.scenes.length,oldIdsPresent:oldIds.every(id=>next.scenes.some(s=>s.id===id)),repeat:JSON.stringify(next)===JSON.stringify(repeat),aiPreserved:JSON.stringify(ai.shots)===initial,removedRetained:oldIds.every(id=>removed.scenes.some(s=>s.id===id))};
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
  await page.locator('main textarea').fill('INT. EDITED DURING ANALYSIS - DAY\n\nKeep this edit.');release();
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
  const video=info.streams.find(s=>s.codec_type==='video');assert.ok(Math.abs(video.width/video.height-2.39)<.01);
  const seconds=mediaDuration(output);assert.ok(seconds>=1.4 && seconds<2.2,String(seconds));
  // Decode succeeds; separately inspect sample energy to distinguish a silent track.
  const pcm=execFileSync('ffmpeg',['-v','error','-i',output,'-vn','-f','s16le','-ac','1','-ar','8000','-']);
  let peak=0;for(let i=0;i+1<pcm.length;i+=2)peak=Math.max(peak,Math.abs(pcm.readInt16LE(i)));assert.ok(peak>100,'source audio is audible');
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
