'use strict';
const cp=require('child_process');
const {root,configuration,assertIsolation}=require('../scripts/local-shadow/config.cjs');
test('explicit source mode retains fixed isolation; default remains legacy with no credentials',()=>{
  const env=configuration();expect(env.OCR_SOURCE_MODE).toBe('legacy');expect(env.OPENROUTER_API_KEY).toBeUndefined();
  expect(()=>assertIsolation({...env,OCR_SOURCE_MODE:'astra_verified'})).toThrow();
  expect(()=>assertIsolation({...env,OCR_SOURCE_MODE:'astra_verified',LOCAL_ASTRA_VERIFIED_OPT_IN:'true'})).not.toThrow();
  expect(()=>assertIsolation({...env,OCR_SOURCE_MODE:'astra_verified',LOCAL_ASTRA_VERIFIED_OPT_IN:'true',MONGO_URI:'mongodb://remote/production'})).toThrow();
});
test('opt-in permits scoped provider hosts only, never general Internet or unscoped egress',()=>{
  const code=`const n=require('./scripts/local-shadow/network.cjs');n.install({astraVerified:true});
    if(n.allowed('openrouter.ai')||n.allowed('vision.googleapis.com'))throw Error('unscoped');
    n.scope('shadow','source',()=>{if(!n.allowed('openrouter.ai')||n.allowed('example.com')||n.allowed('openrouter.ai',80)||n.allowed('vision.googleapis.com'))throw Error('router scope');});
    n.scope('google','document',()=>{if(!n.allowed('vision.googleapis.com')||!n.allowed('oauth2.googleapis.com')||n.allowed('storage.googleapis.com'))throw Error('google scope');});
    for(const url of ['https://example.invalid','https://openrouter.ai/api/v1/chat/completions']){try{fetch(url,{method:'POST'});throw Error('allowed');}catch(e){if(e.code!=='LOCAL_SHADOW_EXTERNAL_NETWORK_DENIED')throw e;}}
    n.disable();if(n.allowed('openrouter.ai',443,{provider:'shadow'}))throw Error('not disabled');console.log('PASS');`;
  const r=cp.spawnSync(process.execPath,['-e',code],{cwd:root,encoding:'utf8'});expect(r.status).toBe(0);expect(r.stdout.trim()).toBe('PASS');
});
test('existing human authority semantics and rejected publication mode are unchanged',()=>{
  const {mode}=require('../src/services/hybridSource/contract');
  expect(mode({})).toBe('legacy');expect(mode({OCR_SOURCE_MODE:'hybrid_shadow'})).toBe('hybrid_shadow');
  expect(()=>mode({OCR_SOURCE_MODE:'hybrid'})).toThrow('NOT_VALIDATED');
  expect(()=>mode({OCR_SOURCE_MODE:'astra_verified',NODE_ENV:'production'})).toThrow('LOCAL_ONLY');
  expect(mode({OCR_SOURCE_MODE:'astra_verified',NODE_ENV:'development'})).toBe('astra_verified');
  expect(mode({...require('../scripts/local-shadow/config.cjs').configuration(),OCR_SOURCE_MODE:'astra_verified',LOCAL_ASTRA_VERIFIED_OPT_IN:'true'})).toBe('astra_verified');
  const {authorityFor}=require('../src/services/hybridSource/sourceAuthority');
  expect(authorityFor({geometryUnique:true,mappedWordIds:[],sourceText:'sence'}, {}, []).verified).toBe(false);
});
