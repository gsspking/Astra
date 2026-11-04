const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');let browser,server,base;
before(async()=>{
  const html=(await fs.readFile(path.join(root,'index.html'),'utf8')).replace('</script>',`\nwindow.__astra={G,Kl,Ul,nu,tu,Uc,asMediaPortable};</script>`);
  server=http.createServer((req,res)=>{res.setHeader('content-type','text/html');res.end(html)});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  base=`http://127.0.0.1:${server.address().port}/index.html`;
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  await fs.mkdir(path.join(root,'test-results'),{recursive:true});
});
after(async()=>{await browser?.close();await new Promise(resolve=>server.close(resolve))});
async function pageFor(t,width,height=900){
  const context=await browser.newContext({viewport:{width,height},isMobile:width<768,hasTouch:width<1200});t.after(()=>context.close());const page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));t.after(()=>assert.deepEqual(errors,[],'no uncaught browser errors'));
  await page.goto(base);await page.waitForFunction(()=>window.__astra?.G.getState().hydrated&&window.__astra.Kl.getState().hydrated);return page;
}
async function noOuterOverflow(page){
  const size=await page.evaluate(()=>{const main=document.querySelector('.astra-workspace');return{route:location.hash,viewport:innerWidth,body:document.body.scrollWidth,workspace:main.clientWidth,content:main.scrollWidth}});
  assert.ok(size.body<=size.viewport+1,JSON.stringify(size));assert.ok(size.content<=size.workspace+1,JSON.stringify(size));
}

test('every workspace fits phone, tablet and desktop widths without outer horizontal scrolling',async t=>{
  for(const width of [320,390,600,768,820,1024,1440]){
    const page=await pageFor(t,width);
    for(const route of ['/','/projects','/setup','/skills','/connections','/script','/breakup','/project','/assembly','/control','/io','/pdf','/settings','/prd']){
      await page.goto(base+'#'+route);await page.waitForFunction(()=>document.querySelector('.astra-workspace').dataset.workspace===(location.hash.slice(2)||'home'));
      await noOuterOverflow(page);
    }
  }
});

test('phone navigation traps drawer focus, closes on Escape and exposes script views',async t=>{
  const page=await pageFor(t,390,844),quick=page.getByRole('navigation',{name:'Quick navigation'}),menu=page.getByRole('button',{name:'Open navigation',exact:true});
  assert.equal(await quick.isVisible(),true);assert.equal(await page.getByRole('complementary',{name:'Primary navigation'}).isVisible(),false);
  const hit=await menu.boundingBox();assert.ok(hit.width>=44&&hit.height>=44);
  await menu.click();const drawer=page.getByRole('dialog',{name:'Main navigation'});await drawer.waitFor();
  await drawer.getByRole('button',{name:'Close navigation'}).focus();await page.keyboard.press('Shift+Tab');
  assert.equal(await drawer.evaluate(node=>node.contains(document.activeElement)),true,'focus stays in the modal drawer');
  await page.keyboard.press('Escape');await drawer.waitFor({state:'detached'});assert.equal(await menu.evaluate(node=>node===document.activeElement),true);
  await menu.click();await drawer.getByRole('link',{name:'Connections',exact:true}).click();await page.waitForURL(base+'#/connections');await drawer.waitFor({state:'detached'});
  await quick.getByRole('link',{name:'Script',exact:true}).click();
  const views=page.getByRole('navigation',{name:'Script views'});await views.getByRole('button',{name:'Scenes & versions',exact:true}).click();
  assert.equal(await page.getByRole('complementary',{name:'Script scenes and versions'}).isVisible(),true);
  await page.getByRole('button',{name:'← Back to script',exact:true}).click();assert.equal(await page.getByRole('article',{name:'Formatted screenplay'}).isVisible(),true);
  await views.getByRole('button',{name:'Edit source',exact:true}).click();await page.getByRole('textbox',{name:'Screenplay source'}).fill('INT. PHONE EDIT - DAY #1A#\n\nA small room.');
  await views.getByRole('button',{name:'Screenplay',exact:true}).click();assert.match(await page.getByRole('article',{name:'Formatted screenplay'}).innerText(),/PHONE EDIT/);
  await noOuterOverflow(page);
});

test('long mobile titles and loglines do not overlap banner controls',async t=>{
  const page=await pageFor(t,320,740);await uploadPositionImage(page);
  await page.evaluate(()=>window.__astra.G.getState().set(p=>({...p,meta:{...p.meta,title:'The Very Long Journey Through a City That Never Stops Waiting',logline:'A filmmaker returns home to reconnect with the people and places that shaped her story. '.repeat(4)}})));
  const layout=await page.getByRole('region',{name:'Home banner'}).evaluate(node=>({actions:node.querySelector('.astra-banner-actions').getBoundingClientRect().bottom,caption:node.querySelector('.astra-banner-caption').getBoundingClientRect().top}));
  assert.ok(layout.actions<=layout.caption,'caption flows below wrapped controls');await noOuterOverflow(page);
});

test('tablet rail and desktop sidebar adapt on resize without changing project data',async t=>{
  const page=await pageFor(t,820,1000);const original=await page.evaluate(()=>window.__astra.G.getState().project.meta.title);
  assert.equal(await page.locator('.astra-shell').getAttribute('data-device'),'tablet');assert.equal(await page.locator('.astra-navigation').boundingBox().then(b=>b.width),72);
  await page.getByRole('complementary',{name:'Primary navigation'}).getByRole('link',{name:'Breakup',exact:true}).click();
  const left=await page.locator('.astra-breakup-browser').boundingBox(),right=await page.getByRole('region',{name:'Asset details panel'}).boundingBox();assert.ok(left.width>250&&right.width>=300&&left.x+left.width<=right.x+1);
  await page.setViewportSize({width:1440,height:1000});await page.waitForFunction(()=>document.querySelector('.astra-shell').dataset.device==='desktop');
  assert.equal(await page.locator('.astra-navigation').boundingBox().then(b=>b.width),216);assert.equal(await page.locator('.astra-compact-header').isVisible(),false);
  await page.setViewportSize({width:390,height:844});await page.waitForFunction(()=>document.querySelector('.astra-shell').dataset.device==='phone');
  assert.equal(await page.getByRole('navigation',{name:'Quick navigation'}).isVisible(),true);assert.equal(await page.evaluate(()=>window.__astra.G.getState().project.meta.title),original);await noOuterOverflow(page);
});

test('phone asset editing uses a focused detail screen and retains edits',async t=>{
  const page=await pageFor(t,390,844);await page.getByRole('navigation',{name:'Quick navigation'}).getByRole('link',{name:'Breakup',exact:true}).click();
  const inspector=page.getByRole('region',{name:'Asset details panel'});assert.equal(await inspector.isVisible(),false);
  await page.locator('.astra-breakup-asset').first().tap();await inspector.waitFor();
  const back=page.getByRole('button',{name:'← Back to assets',exact:true});assert.equal(await back.evaluate(node=>node===document.activeElement),true);
  await inspector.getByLabel('Name',{exact:true}).fill('RAVI MOBILE');await page.evaluate(()=>window.__astra.Ul());await back.tap();
  assert.equal(await inspector.isVisible(),false);assert.match(await page.locator('.astra-breakup-asset').first().innerText(),/RAVI MOBILE/);
  await page.reload();await page.waitForFunction(()=>window.__astra?.G.getState().hydrated);assert.match(await page.locator('.astra-breakup-asset').first().innerText(),/RAVI MOBILE/);await noOuterOverflow(page);
});

test('phone shot cards, wide table and tablet storyboards remain usable',async t=>{
  const page=await pageFor(t,390,844);await page.getByRole('navigation',{name:'Quick navigation'}).getByRole('link',{name:'Production',exact:true}).click();
  assert.equal(await page.locator('.astra-shot-grid').first().isVisible(),true);assert.equal(await page.locator('.astra-shot-grid').first().evaluate(node=>getComputedStyle(node).gridTemplateColumns.split(' ').length),1);
  await page.getByRole('button',{name:'crux',exact:true}).click();const table=page.getByRole('region',{name:'Shot table — scroll horizontally for more columns'}).first();await table.waitFor();
  assert.ok(await table.evaluate(node=>node.scrollWidth>node.clientWidth));await table.focus();await page.keyboard.press('ArrowRight');await page.waitForFunction(()=>document.querySelector('.astra-production-table-region').scrollLeft>0);await noOuterOverflow(page);
  await page.getByRole('button',{name:'flick',exact:true}).click();
  await page.locator('.astra-shot-grid').first().getByRole('button',{name:/^S001-SH/}).first().click();const dialog=page.getByRole('dialog');await dialog.waitFor();
  const box=await dialog.boundingBox();assert.ok(box.width<=390&&box.height<=844);await page.keyboard.press('Escape');
  await page.setViewportSize({width:820,height:1000});await page.waitForFunction(()=>document.querySelector('.astra-shell').dataset.device==='tablet');
  assert.equal(await page.locator('.astra-shot-grid').first().evaluate(node=>getComputedStyle(node).gridTemplateColumns.split(' ').length),2);
});

test('mobile PDF fits the page, permits actual-size panning and keeps print dimensions',async t=>{
  const page=await pageFor(t,390,844);await page.goto(base+'#/pdf');
  const options=page.locator('.astra-pdf-options');assert.equal(await options.getAttribute('open'),null);
  const preview=page.getByRole('region',{name:'Storyboard preview'}),paper=preview.locator('.ff-page').first();await paper.waitFor();
  const bounds=await paper.boundingBox(),container=await preview.boundingBox();assert.ok(bounds.x>=container.x-1&&bounds.x+bounds.width<=container.x+container.width+1,'whole page is visible in fit mode');
  await preview.getByRole('button',{name:'Actual size',exact:true}).click();assert.ok(await page.locator('.astra-pdf-pages').evaluate(node=>node.scrollWidth>node.clientWidth));await noOuterOverflow(page);
  await preview.getByRole('button',{name:'Fit page',exact:true}).click();await options.locator('summary').click();assert.equal(await options.getByText('Page size',{exact:true}).isVisible(),true);await options.locator('summary').click();
  await page.emulateMedia({media:'print'});const printed=await page.locator('#ff-print-portal .ff-page').first().evaluate(node=>({width:getComputedStyle(node).width,height:getComputedStyle(node).height}));assert.ok(parseFloat(printed.width)>1000&&parseFloat(printed.height)>700,'print output is not scaled to phone width');
});

async function uploadPositionImage(page,keyboard=false){
  const data=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=1600;canvas.height=900;const ctx=canvas.getContext('2d');const gradient=ctx.createLinearGradient(0,0,1600,900);gradient.addColorStop(0,'#062b55');gradient.addColorStop(1,'#ef9e24');ctx.fillStyle=gradient;ctx.fillRect(0,0,1600,900);return canvas.toDataURL('image/png')});
  const file={name:'reposition-banner.png',mimeType:'image/png',buffer:Buffer.from(data.split(',')[1],'base64')},banner=page.getByRole('region',{name:'Home banner',exact:true});
  if(keyboard){const chooser=page.waitForEvent('filechooser');await banner.getByRole('button',{name:'Upload banner',exact:true}).press('Enter');await(await chooser).setFiles(file)}else await banner.locator('input[type=file]').setInputFiles(file);
  await banner.getByRole('button',{name:'Change banner',exact:true}).waitFor();await banner.getByRole('img').evaluate(img=>img.decode());return banner;
}

for(const width of [390,1440])test(`banner touch/keyboard repositioning persists and cancels safely at ${width}px`,async t=>{
  const page=await pageFor(t,width,width<768?844:1000),banner=await uploadPositionImage(page,width===1440);
  const id=await page.evaluate(()=>window.__astra.Kl.getState().activeId);await banner.getByRole('button',{name:'Reposition banner',exact:true}).click();
  const editor=banner.getByRole('group',{name:'Banner position editor'});assert.equal(await editor.evaluate(node=>node===document.activeElement),true);
  const rect=await editor.boundingBox(),x=rect.x+rect.width/2,y=rect.y+rect.height/2;
  if(width<768){const client=await page.context().newCDPSession(page);await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});await client.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x-35,y}]});await client.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await client.detach();}
  else{await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x,y-40,{steps:5});await page.mouse.up();}
  const moved=await banner.getByRole('img').evaluate(img=>getComputedStyle(img).objectPosition);assert.notEqual(moved,'50% 50%');assert.deepEqual(await page.evaluate(()=>window.__astra.G.getState().project.meta.bannerPosition),{x:50,y:50},'drag preview is not committed until Save');
  const vertical=banner.getByRole('slider',{name:'Vertical position'}),horizontal=banner.getByRole('slider',{name:'Horizontal position'});
  await vertical.focus();await vertical.press('End');await vertical.press('ArrowLeft');await horizontal.focus();await horizontal.press('Home');await horizontal.press('ArrowRight');
  const saved={x:Number(await horizontal.inputValue()),y:Number(await vertical.inputValue())};await banner.getByRole('button',{name:'Save position',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>window.__astra.G.getState().project.meta.bannerPosition),saved);await page.evaluate(()=>window.__astra.Ul());await page.reload();await page.waitForFunction(()=>window.__astra?.G.getState().hydrated);
  assert.equal(await banner.getByRole('img').evaluate(img=>getComputedStyle(img).objectPosition),`${saved.x}% ${saved.y}%`);
  await banner.getByRole('button',{name:'Reposition banner',exact:true}).click();await banner.getByRole('button',{name:'Center image',exact:true}).click();await banner.getByRole('button',{name:'Cancel reposition',exact:true}).click();assert.deepEqual(await page.evaluate(()=>window.__astra.G.getState().project.meta.bannerPosition),saved);
  await page.evaluate(()=>window.__astra.nu({title:'Another project'}));assert.deepEqual(await page.evaluate(()=>window.__astra.G.getState().project.meta.bannerPosition),{x:50,y:50});await page.evaluate(id=>window.__astra.tu(id),id);assert.deepEqual(await page.evaluate(()=>window.__astra.G.getState().project.meta.bannerPosition),saved);
  const portable=await page.evaluate(()=>window.__astra.asMediaPortable(window.__astra.G.getState().project));assert.deepEqual(portable.meta.bannerPosition,saved);await noOuterOverflow(page);
});
