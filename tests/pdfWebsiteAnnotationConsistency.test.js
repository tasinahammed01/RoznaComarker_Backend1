const fs=require('fs'),path=require('path');
const fixture=require('./fixtures/pdfWebsiteAnnotationFixture.cjs');
const {websiteAnnotationPresentation}=require('../src/pdf/websiteAnnotationPresentation');
const {createSubmittedImageLayout}=require('../src/pdf/submittedImageAnnotationLayout');
const {renderSubmissionFeedbackReportHtml}=require('../src/pdf/submissionFeedbackReportTemplate');
const geometry=require('../../RoznaComarker/src/app/components/correction-overlay/annotation-geometry.ts');
const layout=require('../../RoznaComarker/src/app/components/correction-overlay/annotation-layout.ts');
const image=require('../../RoznaComarker/src/app/components/correction-overlay/annotation-image-geometry.ts');
const generated=require('../src/pdf/websiteAnnotationRules.generated');
const {defaultLegend}=require('../src/services/writingCorrections.service');
function website(page){const annotations=page.corrections.map(c=>({...c,_id:c.reportId}));const p=image.imagePresentationGeometry(annotations,page.annotationWords,page.annotationSourceGeometry||null,page.fileId,page.pageNumber,page.imageWidth,page.imageHeight);const visuals=geometry.buildAnnotationVisuals(p.annotations,p.words,page.pageNumber,page.imageWidth,page.imageHeight);return {visuals,groups:layout.layoutAnnotationGroups(visuals,900,900*page.imageHeight/page.imageWidth,110,undefined,p.words)};}
describe('website/PDF canonical annotation presentation parity',()=>{
 test('the production view model retains all 19 canonical records, words, notes and legend colors',()=>{
  const p=fixture(); let text='';
  const wordSpans=p.annotationWords.map((word,index)=>{
   text+=(index ? word.separatorBefore : ''); const start=text.length; text+=word.text;
   return {wordId:word.id,fileId:p.fileId,page:1,start,end:text.length,word,bbox:word.bbox};
  });
  const page={...p,width:900,height:1200,text,startChar:0,endChar:text.length,words:p.annotationWords};
  const corrections=p.corrections.map(c=>{const spans=c.wordIds.map(id=>wordSpans.find(s=>s.wordId===id));const startChar=spans[0].start,endChar=spans.at(-1).end;return {...c,startChar,endChar,quotedText:text.slice(startChar,endChar),color:'#000000'};});
  const input={legend:defaultLegend(),canonicalTranscript:{text,pages:[page],wordSpans},submission:{files:['fixture'],canonicalText:text,transcriptPages:[page],writingCorrections:corrections}};
  const before=JSON.stringify(input);
  const vm=require('../src/pdf/sample/submissionFeedbackReportViewModel').buildSubmissionFeedbackReportViewModel(input);
  expect(vm.statistics).toEqual({content:1,grammar:7,organization:1,vocabulary:2,mechanics:8,total:19});
  expect(vm.submittedPages[0].annotationWords).toEqual(p.annotationWords);
  expect(vm.submittedPages[0].corrections.map(c=>c.id).sort()).toEqual(corrections.map(c=>c.id).sort());
  expect(vm.submittedPages[0].corrections.every(c=>c.color!=='#000000')).toBe(true);
  expect((renderSubmissionFeedbackReportHtml(vm).match(/<tr data-correction-id=/g)||[])).toHaveLength(19);
  expect(JSON.stringify(input)).toBe(before);
 });
 test.each([1,3,6,8])('EXIF-%s projection uses exactly the frontend segments without mutating evidence',orientation=>{
  const p=fixture(),swap=[6,8].includes(orientation);p.imageWidth=swap?1200:900;p.imageHeight=swap?900:1200;
  p.annotationSourceGeometry={version:1,fileId:'fixture',pageNumber:1,width:900,height:1200,orientation,coordinateSpace:'encoded-image',ambiguous:false};
  const before=JSON.stringify(p),web=website(p),pdf=websiteAnnotationPresentation(p);
  expect(pdf.groups.map(g=>({ids:g.correctionIds,label:g.displayLabel}))).toEqual(web.groups.map(g=>({ids:g.annotations.map(a=>a._id),label:g.code})));
  expect(pdf.strokes).toEqual([...layout.sharedSegments(web.visuals,false).map(s=>({...s,semantic:false})),...layout.sharedSegments(web.visuals,true).map(s=>({...s,semantic:true}))]);
  expect(JSON.stringify(p)).toBe(before);
 });
 test('an incompatible embedded image aspect ratio grants no target placement',()=>{
  const p=fixture();p.annotationSourceGeometry={version:1,fileId:'fixture',pageNumber:1,width:900,height:1200,orientation:1,coordinateSpace:'display-image'};p.imageWidth=1200;
  expect(websiteAnnotationPresentation(p).groups).toHaveLength(0);expect(websiteAnnotationPresentation(p).unmapped).toHaveLength(19);
 });
 test('generated production rules exactly match unchanged website sources',()=>{expect(fs.readFileSync(path.join(__dirname,'../src/pdf/websiteAnnotationRules.generated.js'),'utf8')).toBe(require('../scripts/buildWebsiteAnnotationRules.cjs').build());});
 test('exact 19-correction shape matches actual frontend groups, labels, identities, segments, colors and page',()=>{
  const p=fixture(),before=JSON.stringify(p),web=website(p),pdf=websiteAnnotationPresentation(p);
  expect(pdf.groups.map(g=>({ids:g.correctionIds,symbols:g.symbols,label:g.displayLabel,color:g.color,category:g.category,page:g.page,targets:g.targetIds,segments:g.segments}))).toEqual(web.groups.map(g=>({ids:g.annotations.map(a=>a._id),symbols:[...new Set(g.annotations.map(a=>a.symbol))],label:g.code,color:g.annotations[0].color,category:g.annotations[0].category,page:1,targets:g.annotations.map(a=>({correctionId:a._id,wordIds:[...a.renderTarget.wordIds].sort(),anchors:a.renderTarget.anchors})),segments:web.visuals.filter(v=>g.annotations.some(a=>a._id===v.annotation._id)).flatMap(v=>v.segments.map(s=>({...s,semantic:v.semantic})))})));
  expect(pdf.groups.map(g=>g.displayLabel)).toEqual(expect.arrayContaining(['TA','AGR','RO·AGR','VF','CONC','AGR·WC']));
  expect(pdf.groups.some(g=>g.displayLabel==='AGR +7')).toBe(false);
  expect(pdf.strokes).toEqual([...layout.sharedSegments(web.visuals,false).map(s=>({...s,semantic:false})),...layout.sharedSegments(web.visuals,true).map(s=>({...s,semantic:true}))]);
  expect(JSON.stringify(p)).toBe(before);
 });
 test('independent same-symbol targets remain separate even with equal broad legacy boxes',()=>{const p=fixture();p.corrections=p.corrections.filter(c=>['c02','c03','c10'].includes(c.id));p.corrections.forEach(c=>c.bboxList=[{x:1,y:1,w:95,h:95}]);expect(websiteAnnotationPresentation(p).groups.map(g=>g.correctionIds)).toEqual([['c02'],['c03'],['c10']]);});
 test('multiline and partial geometry preserve IDs; null-only words remain notes-only',()=>{const p=fixture();p.corrections.find(c=>c.id==='c06').renderTarget.wordIds.push('w23');const result=websiteAnnotationPresentation(p);expect(result.groups.find(g=>g.correctionIds.includes('c06')).segments).toHaveLength(2);expect(result.unmapped.map(c=>c.id)).toEqual(['c19']);});
 test('canonical count equals unique represented plus unmapped IDs and all 19 notes survive',()=>{const p=fixture(),result=websiteAnnotationPresentation(p),ids=result.groups.flatMap(g=>g.correctionIds);expect(new Set(ids).size).toBe(ids.length);expect([...ids,...result.unmapped.map(c=>c.id)].sort()).toEqual(p.corrections.map(c=>c.id).sort());const html=renderSubmissionFeedbackReportHtml({submission:{},result:{},statistics:{},categoryScores:[],submittedPages:[p],detailedFeedback:{},activeLegendItems:[],completeLegend:[]});expect((html.match(/<tr data-correction-id=/g)||[])).toHaveLength(19);expect(html).not.toContain('Shared target:');expect(html).toContain('data-correction-ids="c04,c05"');});
 test('static scaling changes placement only, never membership or geometry semantics',()=>{const p=fixture(),large=createSubmittedImageLayout(p,{maxWidthMm:180,maxHeightMm:235}),small=createSubmittedImageLayout(p,{maxWidthMm:82,maxHeightMm:92});expect(small.semanticGroups).toEqual(large.semanticGroups);expect(large.markers.flatMap(m=>m.correction.markerMembers.map(c=>c.id)).sort()).toEqual(p.corrections.slice(0,18).map(c=>c.id));expect(large.overflowMarkers).toHaveLength(0);});
 test('legend is the category color authority and exact statistics are unchanged',()=>{const p=fixture(),colors=Object.fromEntries(defaultLegend().groups.map(g=>[g.key,g.color]));for(const g of websiteAnnotationPresentation(p).groups)expect(g.color).toBe(colors[g.category]);expect(Object.fromEntries(Object.keys(colors).map(k=>[k,p.corrections.filter(c=>c.category===k).length]))).toEqual({CONTENT:1,GRAMMAR:7,ORGANIZATION:1,VOCABULARY:2,MECHANICS:8});});
 test('historical boxes, boundary anchors and ambiguous provenance follow website rules',()=>{const p=fixture();p.corrections=[{id:'old',reportId:'old',symbol:'SP',category:'MECHANICS',bboxList:[{x:12,y:12,w:8,h:2}]}];expect(websiteAnnotationPresentation(p).groups).toHaveLength(1);p.annotationSourceGeometry={version:1,fileId:'fixture',pageNumber:1,width:900,height:1200,orientation:3,coordinateSpace:'encoded-image',ambiguous:true};expect(websiteAnnotationPresentation(p).groups).toHaveLength(0);expect(websiteAnnotationPresentation(p).unmapped).toHaveLength(1);});
 test('compiled geometry equals frontend for partial, boundary and EXIF transforms',()=>{const p=fixture();p.corrections[1].renderTarget.anchors=[{wordId:'w2',side:'after'}];const web=website(p);expect(generated.buildAnnotationVisuals(p.corrections.map(c=>({...c,_id:c.id})),p.annotationWords,1,900,1200)).toEqual(web.visuals);for(const orientation of [1,3,6,8])expect(generated.orientedBox({x:10,y:20,w:5,h:2},orientation)).toEqual(image.orientedBox({x:10,y:20,w:5,h:2},orientation));});
});
