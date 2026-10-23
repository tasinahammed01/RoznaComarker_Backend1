'use strict';
const {buildCanonicalSubmissionTranscript}=require('../../src/utils/ocrTranscriptNormalizer');
module.exports=function fixture(fileId){
 const words=Array.from({length:27},(_,i)=>({id:`word_${fileId}_1_${i+1}`,text:`sample${i}`,separatorBefore:i%3===0?'\n':' ',bbox:i===26?null:{x:12+(i%3)*28,y:8+Math.floor(i/3)*9,w:17,h:2.4}}));
 const page={fileId,pageNumber:1,width:900,height:1200,coordinateSpace:'display-image',text:words.map(w=>w.text).join(' '),words};
 const canonical=buildCanonicalSubmissionTranscript({files:[fileId],ocrPages:[page]});
 const codes=['VF','SP','SP','AGR','P','SP','SP','SP','COL','T','SP','SP','SP','TA','FRAG','SPC','WC','CAP','SP','SP','SP','SP','WF','P'];
 const targets=[[0],[1],[2],[3],[4],[5],[6],[7],[3],[8],[9],[10],[11],[12,13],[14,15],[16],[3],[17],[18],[19],[20],[21],[22],[26]];
 const categories={VF:'GRAMMAR',AGR:'GRAMMAR',T:'GRAMMAR',FRAG:'GRAMMAR',COL:'VOCABULARY',WC:'VOCABULARY',WF:'VOCABULARY',TA:'CONTENT'};
 const corrections=codes.map((symbol,i)=>{const spans=targets[i].map(n=>canonical.wordSpans.find(s=>s.wordId===words[n].id)),startChar=spans[0].start,endChar=spans.at(-1).end;return {id:`fixture-c${String(i+1).padStart(2,'0')}`,fileId,page:1,symbol,category:categories[symbol]||'MECHANICS',quotedText:canonical.text.slice(startChar,endChar),startChar,endChar,wordIds:spans.map(s=>s.wordId),bboxList:[{x:0,y:0,w:98,h:98}],suggestedText:`replacement${i+1}`,message:'Persisted synthetic correction.'};});
 return {page,canonical,corrections};
};
