'use strict';
// Offline artifact / visual QA. Never imports provider clients or dispatches generations.
const fs=require('fs'),path=require('path'),{pathToFileURL}=require('url');
const v2=require('./benchmark-v2.cjs');
async function validateArtifacts() {
  const config=v2.loadConfiguration(),baseline=v2.read(v2.DIRECTORY,'protected-baseline.json');
  const protectedCount=v2.assertSnapshot(baseline);
  const states=v2.SLOTS.map(slot=>v2.read(path.join(v2.DIRECTORY,slot),'result.json'));
  const requests=v2.SLOTS.map(slot=>{
    const dir=path.join(v2.DIRECTORY,slot);
    if(!fs.existsSync(path.join(dir,'request-metadata.json')))return null;
    const metadata=v2.read(dir,'request-metadata.json'),outbound=v2.read(dir,'outbound-request-sanitized.json');
    if(JSON.stringify(Object.keys(outbound))!==JSON.stringify(v2.KEYS)||'temperature'in outbound||'max_tokens'in outbound||outbound.max_completion_tokens!==12000||
      metadata.promptSha256!==v2.EXPECTED_PROMPT_SHA||metadata.sourceSha256!==v2.EXPECTED_SHA||metadata.schemaSha256!==v2.sha(JSON.stringify(v2.schema)))throw Error('V2_ARTIFACT_PARITY_FAILED');
    if(fs.existsSync(path.join(dir,'parsed-response.json'))) {
      const raw=v2.validate(fs.readFileSync(path.join(dir,'raw-response.txt'),'utf8'));
      if(raw.activeTranscript!==fs.readFileSync(path.join(dir,'activeTranscript.txt'),'utf8')||
        JSON.stringify(raw)!==JSON.stringify(v2.read(dir,'parsed-response.json')))throw Error('V2_RESPONSE_WAS_MODIFIED');
    }
    return metadata;
  });
  if(requests.every(Boolean)&&requests[0].semanticBodySha256!==requests[1].semanticBodySha256)throw Error('V2_MODEL_EXPERIMENTS_DIFFER');
  if(!fs.readFileSync(path.join(v2.DIRECTORY,'shared-prompt.txt')).equals(fs.readFileSync(path.join(v2.root,'.local-shadow/private/astra-vs-fable-page01/shared-prompt.txt'))))throw Error('V2_PROMPT_WAS_MODIFIED');
  const scan=dir=>{for(const e of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,e.name);if(e.isDirectory())scan(file);else if(fs.readFileSync(file).includes(Buffer.from(config.key)))throw Error('V2_SECRET_PERSISTED');}};
  scan(v2.DIRECTORY);
  const browser=await require('puppeteer').launch({headless:true,pipe:true,args:['--no-sandbox','--disable-background-networking']});
  const html={};let external=0;
  try {
    const page=await browser.newPage();await page.setRequestInterception(true);
    page.on('request',r=>{if(r.url().startsWith('file:')||r.url().startsWith('data:'))r.continue();else{external++;r.abort();}});
    for(const [name,width,height]of [['desktop',1440,1000],['mobile',390,844]]) {
      await page.setViewport({width,height});await page.goto(pathToFileURL(path.join(v2.DIRECTORY,'comparison/comparison.html')).href,{waitUntil:'load'});
      html[name]=await page.evaluate(()=>({models:document.querySelectorAll('.model').length,images:[...document.images].map(i=>({loaded:i.complete&&i.naturalWidth>0,width:i.naturalWidth,height:i.naturalHeight})),
        overflow:document.documentElement.scrollWidth>innerWidth,sourceSensitiveHighlights:document.querySelectorAll('pre span:not(.EXACT)').length}));
      if(html[name].models!==2||html[name].overflow||html[name].images.some(i=>!i.loaded||i.width!==1200||i.height!==1600))throw Error('V2_REVIEW_HTML_FAILED');
      await page.screenshot({path:path.join(v2.DIRECTORY,'comparison/review-'+name+'.png')});
      if(name==='desktop')await(await page.$('.columns')).screenshot({path:path.join(v2.DIRECTORY,'comparison/transcripts-desktop.png')});
    }
  } finally {await browser.close();}
  if(external)throw Error('V2_REVIEW_EXTERNAL_REQUEST');
  // Windows PowerShell redirects native logs as UTF-16LE. Decode log transport only;
  // this never transforms provider response or transcript bytes.
  const logText=name=>{const bytes=fs.readFileSync(path.resolve(v2.root,'../output',name));return bytes[0]===255&&bytes[1]===254?bytes.subarray(2).toString('utf16le'):bytes.toString('utf8');};
  const priorLog=logText('astra-fable-v2-prior-regression-tests.log');
  const newLog=logText('astra-fable-v2-offline-tests.log');
  const parsed=log=>{const tests=log.match(/Tests:\s+(\d+) passed, (\d+) total/),suites=log.match(/Test Suites:\s+(\d+) passed, (\d+) total/);if(!tests||!suites||tests[1]!==tests[2]||suites[1]!==suites[2])throw Error('V2_TEST_LOG_NOT_PASSING');return{tests:Number(tests[1]),suites:Number(suites[1])};};
  const a=parsed(priorLog),b=parsed(newLog);
  const validation={testsPassed:a.tests+b.tests,testSuites:a.suites+b.suites,priorRegressionTests:a.tests,v2Tests:b.tests,
    priorRegressionsTiming:'Before the new V2 private directory was created; V1 integrity assertions intentionally cover its original closed file set.',
    htmlValidated:true,html,externalRequests:external,protectedFileCount:protectedCount,credentialsAbsent:true,v1Unchanged:true,sourceUnchanged:true,promptPreservedFromV1:true,
    providerCalls:states.map(s=>({model:s.requestedModel,calls:s.providerCalls,status:s.status})),humanGoldStatus:'PENDING',accuracyWinner:'UNDETERMINED_PENDING_HUMAN_REVIEW'};
  fs.writeFileSync(path.join(v2.DIRECTORY,'validation.json'),JSON.stringify(validation,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify(validation,null,2));
  require('./comparison-v2.cjs').report();
}
if(require.main===module)validateArtifacts().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={validateArtifacts};
