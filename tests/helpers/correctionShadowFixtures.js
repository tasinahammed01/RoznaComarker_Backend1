'use strict';
const v15=require('../../src/services/correctionUniqueSource.service');
const layer=require('../../src/services/correctionOperativeAuthority.service');
const {REQUIRED}=require('../../src/services/correctionLegendResolver.service');
const {digest,evidenceKey}=require('../../src/services/hybridSource/reconcile');
const identity={submissionId:'s',fileId:'f',runId:'r',pageNumber:1,sourceSha256:'a'.repeat(64),inputSha256:'b'.repeat(64),width:800,height:300,orientation:1};
const generator={id:'generator',model:'model/generator'};
const reviewers=[{id:'human',kind:'HUMAN_REVIEWER',independentOf:['generator']},{id:'verifier',kind:'INDEPENDENT_AI_VERIFIER',model:'model/independent',independentOf:['generator']}];
function fixture(text='she speling now',suggestion='she spelling now',code='SP'){
 const input={transcript:text,transcriptHash:digest(text),identity,assignment:{}};
 const provider={sourceLineIds:v15.sourceDocument(text).lines.filter(l=>l.text).map(l=>l.id),exactQuote:text,suggestion,code,confidence:1,rationale:'Synthetic example.',criterionId:null};
 const reviews=Object.fromEntries(Object.entries(REQUIRED).map(([k,c])=>[k,{reviewed:true,reviewedSymbols:c,noFindingReason:'Synthetic.'}]));
 const content=JSON.stringify({reviews,corrections:[provider]}),analysis=layer.analyzeSaved(input,content);
 const bindings=[],attestations=[],nativeWords=[];
 [...text.matchAll(/\S+/g)].forEach((m,i)=>{const id='word_'+i,polygon=[{x:10+i*30,y:10},{x:30+i*30,y:10},{x:30+i*30,y:30},{x:10+i*30,y:30}];bindings.push({identity,sourceTranscriptSha256:input.transcriptHash,transcriptStart:m.index,transcriptEnd:m.index+m[0].length,sourceText:m[0],classification:'STUDENT_ACTIVE_TEXT',state:'VERIFIED_SOURCE',geometryUnique:true,mappedWordIds:[id],mappedPolygons:[polygon]});nativeWords.push({id,polygon});attestations.push({kind:'HUMAN_REVIEWED',reviewer:'synthetic reference',reviewId:'test'+i,identity,evidenceKey:evidenceKey(identity),wordIds:[id],classification:'STUDENT_ACTIVE_TEXT',text:m[0]});});
 return {input,analysis,provider,page:{identity,sources:{legacy:{identity,transcript:text,transcriptHash:input.transcriptHash}},savedCompletion:content,evidence:{bindings,attestations,nativeWords}},deps:{generator,reviewers}};
}
module.exports={fixture,identity,generator,reviewers};
