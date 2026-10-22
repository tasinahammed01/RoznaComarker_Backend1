const fs = require('fs');
const os = require('os');
const path = require('path');
const v = require('../scripts/local-shadow/source-fidelity-v2.cjs');
function crop(text) {
  return { cropId: 'CROP_001', status: 'READABLE', characters: [...text].map((char, index) => ({
    index, char, case: /^[a-z]$/.test(char) ? 'LOWER' : /^[A-Z]$/.test(char) ? 'UPPER' : 'NONE', confidence: 0.99
  })), verbatim: text, punctuation: [...text].filter(c => /[\p{P}\p{S}]/u.test(c)).join(''), crossedOutVisible: false, uncertainCharacterIndexes: [], visualReason: 'Visible strokes.' };
}
const valid = c => v.validate(JSON.stringify({ crops: [c] }), ['CROP_001']).crops[0];
test.each(['sence', 'sense', 'people', 'People', 'cultural', 'Cultural', 'Vivid', 'vivid', 'Social', 'social', 'relize', 'relizing', 'got rid off', 'a , "B"; C?'])('exact source remains %s', text => {
  expect(v.decision(valid(crop(text))).text).toBe(text);
});
test.each([['sence','sense'],['people','People'],['cultural','Cultural'],['Vivid','vivid'],['Social','social'],['relize','realize'],['relizing','realizing'],['off','of'],['?', '!']])('exact comparison distinguishes %s and %s', (a,b) => {
  expect(v.align(v.tokens(a), v.tokens(b)).distance).toBe(1);
});
test('punctuation is retained with exact offsets', () => {
  const source = 'a,  "People"?';
  for (const t of v.tokens(source)) expect(source.slice(t.start,t.end)).toBe(t.text);
  expect(v.tokens(source).map(t => t.text)).toEqual(['a', ',', '"', 'People', '"', '?']);
});
test('multiple optimal occurrence matches are explicitly ambiguous', () => {
  const a = v.align(v.tokens('free free'), v.tokens('free'));
  expect(a.alternatives.map(options => new Set(options))).toEqual([new Set([null,0]),new Set([null,0])]);
  expect(a.operations.every(o => o.ambiguous)).toBe(true);
});
test('no first-occurrence binding is substituted for a uniquely located repeated word', () => {
  const a = v.align(v.tokens('one free two free end'), v.tokens('one free two Free end'));
  expect(a.operations[3]).toMatchObject({ googleIndex: 3, solIndex: 3, exact: false, ambiguous: false });
});
test('invalid reconstruction is rejected without repair', () => {
  const c = crop('sence'); c.verbatim = 'sense'; expect(() => valid(c)).toThrow('CROP_RECONSTRUCTION_INVALID');
});
test('uncertain characters cannot become authoritative guessed text', () => {
  const c = crop('sence'); c.characters[3].char = null; c.uncertainCharacterIndexes = [3];
  expect(() => valid(c)).toThrow();
  c.status = 'UNCERTAIN'; c.verbatim = null;
  expect(v.decision(valid(c))).toMatchObject({ state: 'OCR_UNCERTAIN', text: null });
});
test('weak confidence and deleted material withhold active text', () => {
  const c = crop('felt'); c.crossedOutVisible = true;
  expect(v.decision(valid(c)).text).toBeNull();
  c.crossedOutVisible = false; c.characters[0].confidence = 0.94;
  expect(v.decision(valid(c)).state).toBe('OCR_UNCERTAIN');
});
test('unsupported correction fields and inconsistent punctuation/case are rejected', () => {
  expect(() => valid({ ...crop('sence'), correctedText:'sense' })).toThrow();
  const c = crop('People?'); c.characters[0].case = 'LOWER'; expect(() => valid(c)).toThrow();
  c.characters[0].case = 'UPPER'; c.punctuation = '!'; expect(() => valid(c)).toThrow();
});
test('durable budget enforces exactly one Google and at most two Sol dispatches across restarts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'source-fidelity-test-'));
  try {
    const b = new v.Budget(dir);
    for (const k of ['google-attempt','google-http','google-auth','sol-1-attempt','sol-1-http']) {
      b.reserve(k); expect(() => new v.Budget(dir).reserve(k)).toThrow('PROVIDER_BUDGET_CONSUMED');
    }
    expect(() => b.reserve('sol-2-attempt')).toThrow('PRIOR_STAGE_NOT_COMPLETE');
    fs.writeFileSync(path.join(dir,'batch-1-result.json'), JSON.stringify({status:'FAILED'}));
    expect(() => b.reserve('sol-2-attempt')).toThrow('PRIOR_STAGE_NOT_COMPLETE');
    fs.writeFileSync(path.join(dir,'batch-1-result.json'), JSON.stringify({status:'COMPLETE'}));
    for (const k of ['sol-2-attempt','sol-2-http']) { b.reserve(k); expect(() => b.reserve(k)).toThrow(); }
    for (const k of ['sol-3-http','google-orientation-http','full-page','correction']) expect(() => b.reserve(k)).toThrow('PROVIDER_BUDGET_FORBIDDEN');
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
test('native geometry and original symbol case survive unchanged', () => {
  const annotation = {pages:[{width:100,height:100,blocks:[{paragraphs:[{words:[{
    symbols:[{text:'V',confidence:.99},{text:'i',confidence:.6}],confidence:.9,boundingBox:{vertices:[{x:1,y:1},{x:20,y:1},{x:20,y:20},{x:1,y:20}]}
  }]}]}]}]};
  const [w] = v.googleWords(annotation,{width:100,height:100});
  expect(w.text).toBe('Vi'); expect(w.confidence).toBe(.6); expect(w.geometryValid).toBe(true);
  expect(() => v.googleWords(annotation,{width:200,height:100})).toThrow('GOOGLE_COORDINATE_SPACE_UNPROVEN');
});
test('private entry point has no correction/scoring/publication invocation or retry loop', () => {
  const script = fs.readFileSync(path.resolve(__dirname,'../scripts/runSourceFidelityV2.cjs'),'utf8');
  expect(script).not.toMatch(/require\([^)]*(?:correction|scoring|rubric|pdf|publication|real-one\.cjs)/i);
  expect(script).toContain('retry: null');
  expect(script).toContain('budget.reserve(`sol-${batchNumber}-http`)');
  expect(script).toContain("budget.reserve('google-http')");
  expect(script).not.toContain('gpt-4.1-mini');
  expect(script).not.toContain('while (');
  expect(v.DIR).not.toBe(v.OLD);
  expect(v.DIR).not.toContain('real-one');
});
test('prompt contains full mandatory forensic rules, not OCR candidate strings', () => {
  const prompt = fs.readFileSync(path.resolve(__dirname,'../scripts/local-shadow/source-fidelity-prompt.txt'),'utf8');
  for (const s of ['FORENSIC VISUAL CHARACTER COPIER','Do not generate verbatim first and reverse-engineer the characters.','do NOT choose based on Google text.','UNCERTAINTY RULE','got rid off']) expect(prompt).toContain(s);
  expect(prompt).not.toContain('Louise');
});
test('private review does not fill unverified or deleted spans from either provider', () => {
  const {build}=require('../scripts/reviewSourceFidelityV2.cjs');
  const poly=[{x:1,y:1},{x:9,y:1},{x:9,y:9},{x:1,y:9}];
  const alignment={orderedWords:['sence','felt','People'].map((text,i)=>({id:String(i),text,polygon:poly,visualLine:1}))};
  const plan={targets:[{cropId:'CROP_001',wordIds:['0'],geometryValid:true},{cropId:'CROP_002',wordIds:['1'],geometryValid:true}],unlocatedSolTokens:[{text:'invented',state:'OCR_UNCERTAIN'}]};
  const deleted={...crop('felt'),cropId:'CROP_002',crossedOutVisible:true};
  const result=build(plan,alignment,[valid(crop('sence')),deleted]);
  expect(result.spans[0].sourceText).toBe('sence');
  expect(result.spans.slice(1).every(s=>s.sourceText===null)).toBe(true);
  expect(result.activeTranscript).toBeNull();
  expect(result.reviewTranscript).not.toContain('felt');
  expect(result.reviewTranscript).not.toContain('invented');
  expect(result.publishable).toBe(false);
  const vetoed=build(plan,alignment,[valid(crop('sence'))],[{cropId:'CROP_001',decision:'WITHHOLD',replacement:null}]);
  expect(vetoed.spans[0].sourceText).toBeNull();
  expect(vetoed.spans[0].state).toBe('OCR_UNCERTAIN');
  expect(vetoed.spans[0].cropVerifier.verbatim).toBe('sence');
});
test('native geometry ordering retains word identity and flags overlapping detections', () => {
  const {orderedWords}=require('../scripts/prepareSourceFidelityV2.cjs');
  const polygon=(x,y)=>[{x,y},{x:x+30,y},{x:x+30,y:y+30},{x,y:y+30}];
  const words=[{id:'B',text:'People',polygon:polygon(60,10)},{id:'A',text:'people',polygon:polygon(10,10)},{id:'D',text:'duplicate',polygon:polygon(62,10)}];
  expect(orderedWords(words).map(w=>w.id)).toEqual(['A','B','D']);
  expect(orderedWords(words).find(w=>w.id==='B').overlap).toBe(true);
  expect(words.map(w=>w.text)).toEqual(['People','people','duplicate']);
});
test('binary crop persistence preserves bytes exactly', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'source-crop-pixels-'));
  try {const bytes=Buffer.from([0,255,32,90,13,10]);v.save(dir,'crop.png',bytes);expect(fs.readFileSync(path.join(dir,'crop.png'))).toEqual(bytes);}
  finally {fs.rmSync(dir,{recursive:true,force:true});}
});
