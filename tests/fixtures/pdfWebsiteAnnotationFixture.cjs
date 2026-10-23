'use strict';
const { defaultLegend } = require('../../src/services/writingCorrections.service');
module.exports = function fixture() {
  const colors = Object.fromEntries(defaultLegend().groups.map(g => [g.key,g.color]));
  const shape = [['TA','CONTENT'],['AGR','GRAMMAR'],['AGR','GRAMMAR'],['RO','GRAMMAR'],['AGR','GRAMMAR'],['VF','GRAMMAR'],['CONC','ORGANIZATION'],['AGR','GRAMMAR'],['WC','VOCABULARY'],['AGR','GRAMMAR'],['WF','VOCABULARY'],['SPC','MECHANICS'],['SPC','MECHANICS'],['SPC','MECHANICS'],['CAP','MECHANICS'],['SPC','MECHANICS'],['SPC','MECHANICS'],['P','MECHANICS'],['SP','MECHANICS']];
  const words = Array.from({length:24},(_,i)=>({id:`w${i}`,text:`word${i}`,separatorBefore:i%3===0?'\n':' ',bbox:{x:15+(i%3)*25,y:10+Math.floor(i/3)*10,w:14,h:2.5}}));
  words[23].bbox=null;
  const targets=[[0,1],[2],[3],[4],[4],[5,6],[7,8],[9],[9],[10],[11],[12],[13],[14],[15],[16],[17],[18],[23]];
  const corrections=shape.map(([symbol,category],i)=>{
    const ids=targets[i].map(n=>`w${n}`),boxes=targets[i].map(n=>words[n].bbox).filter(Boolean);
    return {id:`c${String(i+1).padStart(2,'0')}`,reportId:`c${String(i+1).padStart(2,'0')}`,displayNumber:i+1,fileId:'fixture',page:1,symbol,category,color:colors[category],quotedText:targets[i].map(n=>words[n].text).join(' '),suggestedText:'Reviewed replacement',message:'Persisted canonical note',wordIds:ids,bboxList:boxes,
      renderTarget:{version:1,source:'wordIds',wordIds:ids,anchors:[],boxes,textRanges:[],textAnchors:[]}};
  });
  return {imageDataUrl:'data:image/png;base64,AA==',fileId:'fixture',pageNumber:1,displayPageNumber:1,imageWidth:900,imageHeight:1200,annotationWords:words,annotationObstacles:words.map(w=>w.bbox).filter(Boolean),corrections,transcript:{highlightedSegments:[{text:words.map(w=>w.text).join(' '),correctionNumbers:[],symbols:[]}]}};
};
