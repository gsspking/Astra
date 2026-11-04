const {test,before,after}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http');
const {execFileSync}=require('node:child_process');const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');let browser,server,base,video;
before(async()=>{
  const html=(await fs.readFile(path.join(root,'index.html'),'utf8')).replace('</script>',`\nwindow.__astra={G,Kl,Ul,Uc,qc,I_,nu,tu,asMediaHydrate,asMediaPortable};</script>`);
  server=http.createServer((req,res)=>{res.setHeader('content-type','text/html');res.end(html)});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}/index.html`;
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  await fs.mkdir(path.join(root,'test-results'),{recursive:true});const fixture=path.join(root,'test-results','production-video.webm');
  execFileSync('ffmpeg',['-v','error','-y','-f','lavfi','-i','color=c=blue:s=160x90:r=12:d=1','-c:v','libvpx',fixture]);video='data:video/webm;base64,'+(await fs.readFile(fixture)).toString('base64');
});
after(async()=>{await browser?.close();await new Promise(resolve=>server.close(resolve))});
async function session(t,width=1440){const context=await browser.newContext({viewport:{width,height:1000},hasTouch:width<1200,isMobile:width<768});t.after(()=>context.close());const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));t.after(()=>assert.deepEqual(errors,[]));await page.goto(base+'#/project');await page.waitForFunction(()=>window.__astra?.G.getState().hydrated&&window.__astra.Kl.getState().hydrated);return page;}
const scene=(page,label)=>page.getByRole('region',{name:`Scene ${label}`,exact:true});
async function flick(page){await page.getByRole('button',{name:'flick',exact:true}).click();}
async function seedMedia(page){return page.evaluate(async video=>{
  const a=window.__astra,p=a.G.getState().project;
  const png=color=>{const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;const ctx=canvas.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,320,180);return canvas.toDataURL('image/png')};
  const red=await a.asMediaHydrate(png('red')),green=await a.asMediaHydrate(png('green')),blue=await a.asMediaHydrate(png('blue')),clip=await a.asMediaHydrate(video);
  const ids=p.shots.map(s=>s.id),images=[red,green,blue];
  a.G.getState().set(current=>({...current,shots:current.shots.map((s,index)=>index<3?{...s,image:{versions:[{id:'img-'+index,url:images[index],createdAt:1,source:'upload'}],approvedId:null},video:{versions:[{id:'vid-'+index,url:clip,createdAt:1,source:'comfyui'}],approvedId:null},stage:'video',action:'ACTION_ONLY_'+index,lens:'LENS_ONLY_'+index,notes:'NOTES_ONLY_'+index}:s)}));
  return {ids,images,clip};
},video);}

test('collapse, individual expansion and focus restore the exact normal view in Crux and Flick',async t=>{
  const page=await session(t);assert.equal(await page.locator('.astra-production-scene.is-expanded').count(),2);
  await page.getByRole('button',{name:'Collapse all',exact:true}).click();assert.equal(await page.locator('.astra-production-scene.is-expanded').count(),0);
  await scene(page,'1').getByRole('button',{name:'Expand scene 1',exact:true}).click();assert.equal(await page.locator('.astra-production-scene.is-expanded').count(),1);
  await scene(page,'2').getByRole('button',{name:'Focus scene 2',exact:true}).click();assert.equal(await page.locator('.astra-production-scene').count(),1);assert.equal(await scene(page,'2').getByRole('button',{name:'Exit focus for scene 2'}).getAttribute('aria-pressed'),'true');
  await page.getByRole('button',{name:'Show all scenes',exact:true}).click();assert.equal(await page.locator('.astra-production-scene').count(),2);assert.equal(await scene(page,'1').getByRole('button',{name:'Collapse scene 1'}).count(),1);assert.equal(await scene(page,'2').getByRole('button',{name:'Expand scene 2'}).count(),1);
  await flick(page);assert.equal(await page.locator('.astra-production-scene.is-expanded').count(),0,'Flick starts as collapsed scene thumbnails');
  await scene(page,'1').getByRole('button',{name:'Expand scene 1',exact:true}).click();assert.equal(await page.locator('.astra-production-shot-card').count(),3);
  await scene(page,'2').getByRole('button',{name:'Focus scene 2',exact:true}).click();assert.equal(await page.locator('.astra-production-scene').count(),1);
  await page.locator('.astra-production-shot-card').first().getByRole('button',{name:/^S002-SH/}).click();await page.getByRole('dialog').waitFor();await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'detached'});assert.equal(await page.locator('.astra-production-scene').count(),1,'closing a shot inspector keeps scene focus');await page.keyboard.press('Escape');
  assert.equal(await scene(page,'1').getByRole('button',{name:'Collapse scene 1'}).count(),1);assert.equal(await scene(page,'2').getByRole('button',{name:'Expand scene 2'}).count(),1);
  await page.getByRole('button',{name:'Expand all',exact:true}).click();assert.equal(await page.locator('.astra-production-shot-card').count(),6);
  await page.getByRole('button',{name:'Collapse all',exact:true}).click();await page.getByRole('button',{name:'Scene list',exact:true}).click();await page.reload();
  await page.waitForFunction(()=>document.querySelector('.astra-scene-collection')?.dataset.mode==='flick');assert.equal(await page.locator('.astra-scene-collection').getAttribute('data-layout'),'list');assert.equal(await page.locator('.astra-production-scene.is-expanded').count(),0);
});

test('focus on a later page preserves pagination and scene expansion',async t=>{
  const page=await session(t);await page.evaluate(()=>{const a=window.__astra,p=a.G.getState().project;const scenes=Array.from({length:25},(_,i)=>({...p.scenes[0],id:'scene-'+i,number:i+1,scriptNumber:String(i+1),slug:'INT. SET '+i+' - DAY'})),shots=scenes.map((scene,index)=>({...p.shots[0],id:'shot-'+index,sceneId:scene.id}));a.G.getState().set(()=>({...p,scenes,shots}));});
  await flick(page);await page.getByRole('button',{name:'Next',exact:true}).click();await page.getByRole('button',{name:'Next',exact:true}).click();
  await scene(page,'25').getByRole('button',{name:'Focus scene 25',exact:true}).click();assert.equal(await page.locator('.astra-production-scene').count(),1);
  await scene(page,'25').getByRole('button',{name:'Exit focus for scene 25',exact:true}).click();assert.match(await page.locator('.astra-production-pagination').innerText(),/page 3 \/ 3/);assert.equal(await scene(page,'25').getByRole('button',{name:'Expand scene 25'}).count(),1);
});

test('Flick field toggles filter thumbnails and shot cards independently of PDF export',async t=>{
  const page=await session(t);await seedMedia(page);await page.goto(base+'#/pdf');const options=page.locator('.astra-pdf-options');
  for(const name of await options.getByRole('button',{pressed:true}).allTextContents())await options.getByRole('button',{name,exact:true}).click();
  await options.getByRole('button',{name:'notes',exact:true}).click();
  await page.waitForFunction(()=>JSON.stringify(JSON.parse(localStorage.getItem('ff-pdf-last')).fields)==='["notes"]');
  await page.goto(base+'#/project');await flick(page);
  assert.equal(await page.getByText('Choose fields in PDF Export',{exact:true}).count(),0);
  const controls=page.getByRole('group',{name:'Flick visible details'});
  assert.equal(await controls.getByRole('button').count(),17);
  assert.deepEqual(await controls.getByRole('button',{pressed:true}).allTextContents(),['Description','Type','Lens','Duration','Dialogue'],'Flick starts with its own defaults');
  for(const name of await controls.getByRole('button',{pressed:true}).allTextContents())if(!['Lens','Duration'].includes(name))await controls.getByRole('button',{name,exact:true}).click();
  await page.getByRole('button',{name:'Expand all',exact:true}).click();
  const details=page.locator('.astra-production-shot-card').first().locator('.astra-selected-shot-details');
  assert.deepEqual(await details.locator('dt').allTextContents(),['Lens','Duration']);assert.doesNotMatch(await details.innerText(),/ACTION_ONLY|NOTES_ONLY/);assert.match(await details.innerText(),/LENS_ONLY_0/);
  assert.equal(await page.locator('.astra-production-shot-card').first().getByText('video',{exact:true}).count(),0,'unselected status stays hidden');
  await page.getByRole('button',{name:'Collapse all',exact:true}).click();
  assert.deepEqual(await scene(page,'1').locator('.astra-selected-shot-details dt').allTextContents(),['Lens','Duration']);
  await page.getByRole('button',{name:'Scene list',exact:true}).click();
  assert.deepEqual(await scene(page,'1').locator('.astra-selected-shot-details dt').allTextContents(),['Lens','Duration']);
  assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('ff-pdf-last')).fields),['notes'],'Flick changes leave PDF settings alone');
  const other=await page.context().newPage();await other.goto(base+'#/pdf');
  await other.locator('.astra-pdf-options').getByRole('button',{name:'notes',exact:true}).click();
  await other.locator('.astra-pdf-options').getByRole('button',{name:'stage',exact:true}).click();
  await page.waitForFunction(()=>JSON.stringify(JSON.parse(localStorage.getItem('ff-pdf-last')).fields)==='["stage"]');
  assert.deepEqual(await scene(page,'1').locator('.astra-selected-shot-details dt').allTextContents(),['Lens','Duration'],'PDF changes in another tab leave Flick alone');await other.close();
  await controls.getByRole('button',{name:'Lens',exact:true}).click();await controls.getByRole('button',{name:'Stage',exact:true}).click();
  assert.deepEqual(await scene(page,'1').locator('.astra-selected-shot-details dt').allTextContents(),['Duration','Stage']);
  await page.goto(base+'#/pdf');assert.equal(await page.locator('.astra-pdf-options').getByRole('button',{name:'stage',exact:true}).getAttribute('aria-pressed'),'true');
  await page.goto(base+'#/project');assert.deepEqual(await controls.getByRole('button',{pressed:true}).allTextContents(),['Duration','Stage']);
  await controls.getByRole('button',{name:'Duration',exact:true}).click();await controls.getByRole('button',{name:'Stage',exact:true}).click();
  assert.equal(await scene(page,'1').locator('.astra-selected-shot-details dt').count(),0);assert.equal((await scene(page,'1').locator('.astra-scene-summary').innerText()).trim(),'3 shots');
  await page.reload();await controls.waitFor();assert.equal(await controls.getByRole('button',{pressed:true}).count(),0,'an empty choice survives reload');
  await page.getByRole('button',{name:'Expand all',exact:true}).click();assert.equal(await page.locator('.astra-production-shot-card .astra-selected-shot-details dt').count(),0);
});

test('Flick detail choices persist per project without overwriting another project',async t=>{
  const page=await session(t);await flick(page);const controls=page.getByRole('group',{name:'Flick visible details'});
  for(const name of await controls.getByRole('button',{pressed:true}).allTextContents())await controls.getByRole('button',{name,exact:true}).click();
  await controls.getByRole('button',{name:'Notes',exact:true}).click();
  const originalId=await page.evaluate(()=>window.__astra.Kl.getState().activeId);
  await page.evaluate(()=>window.__astra.nu({title:'Separate Flick preferences'}));await flick(page);
  assert.deepEqual(await controls.getByRole('button',{pressed:true}).allTextContents(),['Description','Type','Lens','Duration','Dialogue']);
  for(const name of await controls.getByRole('button',{pressed:true}).allTextContents())await controls.getByRole('button',{name,exact:true}).click();await controls.getByRole('button',{name:'Stage',exact:true}).click();
  const secondId=await page.evaluate(()=>window.__astra.Kl.getState().activeId);
  await page.evaluate(id=>window.__astra.tu(id),originalId);assert.deepEqual(await controls.getByRole('button',{pressed:true}).allTextContents(),['Notes']);
  await page.evaluate(id=>window.__astra.tu(id),secondId);assert.deepEqual(await controls.getByRole('button',{pressed:true}).allTextContents(),['Stage']);
  await page.reload();await controls.waitFor();assert.deepEqual(await controls.getByRole('button',{pressed:true}).allTextContents(),['Stage']);
});

test('scene hero image/video selections come from shot versions and survive export/import',async t=>{
  const page=await session(t),media=await seedMedia(page);await flick(page);await page.getByRole('combobox',{name:'Thumbnail media'}).selectOption('both');await scene(page,'1').getByRole('button',{name:'Expand scene 1',exact:true}).click();
  const cards=page.locator('.astra-production-shot-card');await cards.nth(1).getByRole('button',{name:'Set scene hero image',exact:true}).click();await cards.nth(2).getByRole('button',{name:'Set scene hero video',exact:true}).click();
  await scene(page,'1').getByRole('button',{name:'Collapse scene 1',exact:true}).click();assert.equal(await scene(page,'1').getByRole('img',{name:'Scene 1 hero image'}).getAttribute('src'),media.images[1]);assert.equal(await scene(page,'1').locator('video').getAttribute('src'),media.clip);
  await page.getByRole('button',{name:'Scene list',exact:true}).click();const sizes=await page.locator('.astra-scene-preview').evaluateAll(nodes=>nodes.map(n=>({width:n.getBoundingClientRect().width,height:n.getBoundingClientRect().height})));assert.equal(sizes[0].width,sizes[1].width);assert.equal(sizes[0].height,sizes[1].height);
  await page.evaluate(()=>window.__astra.Ul());await page.reload();await page.waitForFunction(()=>document.querySelector('.astra-scene-collection')?.dataset.mode==='flick');
  const hero=await page.evaluate(()=>window.__astra.G.getState().project.scenes[0]);assert.deepEqual(hero.heroImage,{shotId:media.ids[1],versionId:'img-1'});assert.deepEqual(hero.heroVideo,{shotId:media.ids[2],versionId:'vid-2'});
  const portable=await page.evaluate(()=>window.__astra.asMediaPortable(window.__astra.G.getState().project));const fresh=await session(t);await fresh.goto(base+'#/io');await fresh.locator('input[type=file]').last().setInputFiles({name:'heroes.ffproj.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(portable))});await fresh.getByRole('button',{name:'Apply import',exact:true}).click();await fresh.goto(base+'#/project');await flick(fresh);
  assert.deepEqual(await fresh.evaluate(()=>window.__astra.G.getState().project.scenes[0].heroImage),hero.heroImage);await scene(fresh,'1').getByRole('img',{name:'Scene 1 hero image'}).evaluate(img=>img.decode());
});

test('deleting uploaded/generated media versions cleans heroes and approvals atomically and supports Undo',async t=>{
  const page=await session(t),media=await seedMedia(page);
  await page.evaluate(async()=>{const a=window.__astra,p=a.G.getState().project,s=p.shots[0];a.I_('image',{shotId:s.id},s.image.versions[0].url,'comfyui');const latest=a.G.getState().project.shots[0];a.G.getState().updateShot(s.id,{image:{...latest.image,approvedId:'img-0'}});});
  await flick(page);await page.getByRole('combobox',{name:'Thumbnail media'}).selectOption('both');await scene(page,'1').getByRole('button',{name:'Expand scene 1',exact:true}).click();const card=page.locator('.astra-production-shot-card').first(),image=card.getByRole('figure',{name:/^Image media/}),video=card.getByRole('figure',{name:/^Video media/});
  const version=await page.evaluate(()=>window.__astra.G.getState().project.shots[0].image.versions.at(-1).id);await image.getByRole('combobox',{name:'Image version'}).selectOption(version);await image.getByRole('button',{name:'Set scene hero image',exact:true}).click();
  await image.getByRole('button',{name:'Delete image',exact:true}).click();await image.getByRole('group',{name:'Confirm image deletion'}).getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(await page.evaluate(()=>window.__astra.G.getState().project.shots[0].image.versions.length),2);
  await image.getByRole('button',{name:'Delete image',exact:true}).click();await image.getByRole('button',{name:'Confirm delete image',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>{const p=window.__astra.G.getState().project;return{versions:p.shots[0].image.versions.length,approved:p.shots[0].image.approvedId,hero:p.scenes[0].heroImage}}),{versions:1,approved:'img-0',hero:null});
  await page.getByRole('complementary',{name:'Primary navigation'}).getByRole('button',{name:'Undo',exact:true}).click();assert.equal(await page.evaluate(()=>window.__astra.G.getState().project.shots[0].image.versions.length),2);assert.equal(await page.evaluate(()=>window.__astra.G.getState().project.scenes[0].heroImage.versionId),version);
  await video.getByRole('button',{name:'Set scene hero video',exact:true}).click();await video.getByRole('button',{name:'Delete video',exact:true}).click();await video.getByRole('button',{name:'Confirm delete video',exact:true}).click();assert.equal(await page.evaluate(()=>window.__astra.G.getState().project.shots[0].video.versions.length),0);assert.equal(await page.evaluate(()=>window.__astra.G.getState().project.scenes[0].heroVideo),null);
  await page.getByRole('complementary',{name:'Primary navigation'}).getByRole('button',{name:'Undo',exact:true}).click();assert.equal(await page.evaluate(()=>window.__astra.G.getState().project.shots[0].video.versions[0].source),'comfyui');assert.equal(await page.evaluate(()=>window.__astra.G.getState().project.scenes[0].heroVideo.versionId),'vid-0');
  await page.evaluate(id=>window.__astra.G.getState().updateShot(id,{sceneId:window.__astra.G.getState().project.scenes[1].id}),media.ids[0]);assert.deepEqual(await page.evaluate(()=>{const s=window.__astra.G.getState().project.scenes[0];return[s.heroImage,s.heroVideo]}),[null,null]);
});

test('Crux inspector offers image/video deletion and deleting the shot clears hero references',async t=>{
  const page=await session(t);await seedMedia(page);await scene(page,'1').getByRole('button',{name:/^S001-SH010$/}).click();const dialog=page.getByRole('dialog');await dialog.waitFor();
  assert.equal(await dialog.getByRole('button',{name:'Delete image',exact:true}).count(),1);assert.equal(await dialog.getByRole('button',{name:'Delete video',exact:true}).count(),1);await dialog.getByRole('button',{name:'Set scene hero image',exact:true}).click();await dialog.getByRole('button',{name:'Delete',exact:true}).click();await dialog.waitFor({state:'detached'});assert.equal(await page.evaluate(()=>window.__astra.G.getState().project.scenes[0].heroImage),null);assert.equal(await page.evaluate(()=>window.__astra.G.getState().project.shots.length),5);
});

test('storage optimization retains an older version pinned as a scene hero',async t=>{
  const page=await session(t);await seedMedia(page);await page.evaluate(()=>{const a=window.__astra,s=a.G.getState().project.shots[0];a.I_('image',{shotId:s.id},s.image.versions[0].url,'comfyui');a.I_('image',{shotId:s.id},s.image.versions[0].url,'comfyui');});await flick(page);await scene(page,'1').getByRole('button',{name:'Expand scene 1',exact:true}).click();
  const image=page.locator('.astra-production-shot-card').first().getByRole('figure',{name:/^Image media/});await image.getByRole('combobox',{name:'Image version'}).selectOption('img-0');await image.getByRole('button',{name:'Set scene hero image',exact:true}).click();
  await page.goto(base+'#/settings');await page.getByRole('button',{name:'Optimize storage',exact:true}).click();const result=await page.evaluate(()=>{const p=window.__astra.G.getState().project;return{versions:p.shots[0].image.versions.map(v=>v.id),hero:p.scenes[0].heroImage}});assert.equal(result.versions.length,2);assert.ok(result.versions.includes('img-0'));assert.equal(result.hero.versionId,'img-0');
});

test('uploaded image and video versions can be deleted completely without leaving stale approvals or heroes',async t=>{
  const page=await session(t);await flick(page);await page.getByRole('combobox',{name:'Thumbnail media'}).selectOption('both');await page.getByRole('button',{name:'Expand all',exact:true}).click();
  const card=page.locator('.astra-production-shot-card').first(),image=card.getByRole('figure',{name:/^Image media/}),clip=card.getByRole('figure',{name:/^Video media/});
  const png=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=160;canvas.height=90;return canvas.toDataURL('image/png')});
  await image.locator('input[type=file]').setInputFiles({name:'upload.png',mimeType:'image/png',buffer:Buffer.from(png.split(',')[1],'base64')});await page.waitForFunction(()=>window.__astra.G.getState().project.shots[0].image.versions.length===1);
  await clip.locator('input[type=file]').setInputFiles({name:'upload.webm',mimeType:'video/webm',buffer:Buffer.from(video.split(',')[1],'base64')});await page.waitForFunction(()=>window.__astra.G.getState().project.shots[0].video.versions.length===1);
  for(const [figure,kind]of [[image,'image'],[clip,'video']]){await figure.getByRole('button',{name:'Approve',exact:true}).click();await figure.getByRole('button',{name:`Set scene hero ${kind}`,exact:true}).click();await figure.getByRole('button',{name:`Delete ${kind}`,exact:true}).click();await figure.getByRole('button',{name:`Confirm delete ${kind}`,exact:true}).click();}
  const empty=await page.evaluate(()=>{const p=window.__astra.G.getState().project,s=p.shots[0];return{image:s.image,video:s.video,stage:s.stage,expected:s.imagePrompt||s.videoPrompt?'prompted':'planned',heroes:[p.scenes[0].heroImage,p.scenes[0].heroVideo]}});
  assert.deepEqual(empty.image,{versions:[],approvedId:null});assert.deepEqual(empty.video,{versions:[],approvedId:null});assert.equal(empty.stage,empty.expected);assert.deepEqual(empty.heroes,[null,null]);
});

test('collapsed cards, focus and media controls work at phone and tablet widths',async t=>{
  for(const width of [320,390,820]){const page=await session(t,width);await seedMedia(page);await flick(page);
    const fields=page.getByRole('group',{name:'Flick visible details'}),notes=fields.getByRole('button',{name:'Notes',exact:true});await notes.tap();assert.equal(await notes.getAttribute('aria-pressed'),'true');
    assert.match(await scene(page,'1').locator('[data-field="notes"]').innerText(),/NOTES_ONLY_0/);
    if(width<768){const bounds=await notes.boundingBox();assert.ok(bounds.width>=44&&bounds.height>=44,'detail toggles have touch-sized targets');assert.ok(await fields.evaluate(node=>node.scrollWidth>node.clientWidth),'phones scroll the field row without crowding scene content');}
    await page.screenshot({path:path.join(root,'test-results',`flick-details-${width}.png`)});
    await page.getByRole('button',{name:'Scene list',exact:true}).click();await scene(page,'1').getByRole('button',{name:'Focus scene 1',exact:true}).tap();assert.equal(await page.locator('.astra-production-scene').count(),1);await page.getByRole('combobox',{name:'Thumbnail media'}).selectOption('both');
    const first=page.locator('.astra-production-shot-card').first();await first.getByRole('button',{name:'Set scene hero image',exact:true}).tap();await page.getByRole('button',{name:'Show all scenes',exact:true}).tap();assert.equal(await page.locator('.astra-production-scene').count(),2);const size=await page.evaluate(()=>{const w=document.querySelector('.astra-workspace');return[w.clientWidth,w.scrollWidth]});assert.ok(size[1]<=size[0]+1);}
});
