const { buildCanonicalPageFromWords, buildCanonicalSubmissionTranscript } = require('../src/utils/ocrTranscriptNormalizer');
function fixture(angle = 0, spacing = 3.7, curve = false) {
  const words = [];
  for (let row=0;row<3;row++) for(let col=0;col<7;col++) {
    const x=10+col*9,y=10+row*spacing, h=col===2?3.6:3;
    const radians=angle*Math.PI/180;
    const points=[[x,y],[x+7,y],[x+7,y+h],[x,y+h]].map(([x,y])=>curve
      ? {x:x*(1-y*.001),y:y/(1+x*.0005)}
      : {x:x*Math.cos(radians)-y*Math.sin(radians),y:y*Math.cos(radians)+x*Math.sin(radians)});
    words.push({id:`r${row}c${col}`,text:`r${row}c${col}`,bbox:{x0:Math.min(...points.map(p=>p.x)),x1:Math.max(...points.map(p=>p.x)),y0:Math.min(...points.map(p=>p.y)),y1:Math.max(...points.map(p=>p.y))}});
  }
  return words;
}
describe('bounded fallback line models',()=>{
  test.each([[0,5,false],[0,3.4,false],[3,4,false],[7,4,false],[0,4,true]])('preserves physical reading order at %s degrees, spacing %s', (angle,spacing,curve)=>{
    const words=fixture(angle,spacing,curve),before=JSON.stringify(words);
    expect(buildCanonicalPageFromWords(words).words.map(w=>w.id)).toEqual(words.map(w=>w.id));
    expect(JSON.stringify(words)).toBe(before);
  });
  test('overlapping tall title boxes do not mix the following line',()=>{
    const words=[{id:'title1',text:'In',bbox:{x0:11.33,y0:9.04,x1:17.78,y1:14.01}},
      {id:'title2',text:'The',bbox:{x0:19.78,y0:9.04,x1:29.11,y1:14.01}},
      {id:'next1',text:'Chopin',bbox:{x0:12,y0:12.5,x1:25,y1:16.7}},
      {id:'next2',text:'social',bbox:{x0:30,y0:12.5,x1:40,y1:16.7}}];
    expect(buildCanonicalPageFromWords(words).words.map(w=>w.id)).toEqual(words.map(w=>w.id));
  });
  test('authoritative text remains authoritative even with extreme geometry',()=>{
    const words=fixture(7);const text=words.map(w=>w.text).join(' ');
    expect(buildCanonicalSubmissionTranscript({ocrPages:[{fileId:'f',pageNumber:1,rawText:text,words}]}).text).toBe(text);
  });
  test('punctuation stays with its same-line words without becoming a bridge',()=>{
    const words=fixture();words.splice(7,0,{id:'comma',text:',',bbox:{x0:72,y0:12,x1:73,y1:13}});
    const built=buildCanonicalPageFromWords(words);expect(built.words.findIndex(w=>w.id==='comma')).toBe(7);
  });
});
