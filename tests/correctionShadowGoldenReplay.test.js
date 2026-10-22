'use strict';
const fs=require('fs'),path=require('path');
const pipeline=require('../src/services/correctionShadow/pipeline');
const review=require('../src/services/correctionShadow/verifier');
const store=require('../src/services/correctionShadow/privateReview');
const {digest}=require('../src/services/hybridSource/reconcile');
const root=path.join(__dirname,'fixtures/hybrid-source/private/001-louise-mallard');
const localTest=fs.existsSync(path.join(root,'unique-source-mini-v1-20261020/raw-completion.json'))?test:test.skip;
localTest('Golden 001 saved shadow replay is private with six operative matches and no new findings',async()=>{
 const load=f=>JSON.parse(fs.readFileSync(path.join(root,f))),h=load('human-gold.json'),g=load('human-corrections.json'),native=load('google-native.json');
 const snapshot=t=>({identity:g.identity,transcript:t,transcriptHash:digest(t)});
 const r=await pipeline.runPage({identity:g.identity,sources:{legacy:snapshot(native.fullText),human:snapshot(h.transcript)},analysisSource:'human',savedCompletion:load('unique-source-mini-v1-20261020/raw-completion.json').content,
 evidence:{bindings:load('reconciliation-phase2/human-control.json').bindings,attestations:load('reconciliation-phase2/offline-gold-attestations.json'),nativeWords:native.rawGoogle[0].words.map((w,i)=>({...w,id:`word_${g.identity.fileId}_1_${i+1}`}))}}, {generator:{id:'golden-generator',model:'openai/gpt-4.1-mini'},reviewers:[]});
 const m=require('../src/services/correctionOperativeMetrics.service').evaluate([{id:'golden001',transcript:h.transcript,gold:g,analysis:r.analysis}]);
 expect(m.micro).toMatchObject({exactTP:6,exactFP:1,exactFN:3});expect(r.artifact.rows).toHaveLength(7);expect(r.artifact.rows.every(x=>!x.authority.scoringAuthority.eligibleOffline&&!x.authority.markerAuthority.eligibleOffline)).toBe(true);expect(r.artifact).toMatchObject({scoreMutation:false,markerPublication:false,publishable:false});expect(g.corrections.find(c=>c.id==='I').mappingStatus).toBe('MAPPING_WITHHELD');
 const reqs=r.analysis.records.map(x=>review.request(x,r.analysis,r.artifact.generator));reqs.forEach(req=>expect(()=>review.validateRequest(req)).not.toThrow());
});
localTest('private HTML uses escaped evidence and local image, no remote/script controls',async()=>{const artifact=JSON.parse(fs.readFileSync(path.join(root,'correction-shadow-phase5/shadow-review.json')));artifact.rows[0].providerEvidenceQuote='<script>bad()</script>';const html=store.render(artifact,path.join(root,'source.png.jpeg'),path.join(root,'correction-shadow-phase5/review-test.html'));expect(html).toContain('&lt;script&gt;');expect(html).not.toContain('<script>');expect(html).toContain("default-src 'none'");expect(html).not.toMatch(/https?:\/\//);expect(store.reviewActions(artifact).actions.every(a=>a.confirmed===false&&a.decision===null)).toBe(true);});
