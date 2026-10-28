'use strict';
// Newly authored offline fixtures, frozen before any future live authorization.
const defects = [
  {category:'GRAMMAR',symbol:'AGR',text:'The librarian keep a daily record.',quote:'The librarian keep a daily record.',allowedSuggestions:['The librarian keeps a daily record.']},
  {category:'MECHANICS',symbol:'SP',text:'The shelves contain dictionarries.',quote:'dictionarries',allowedSuggestions:['dictionaries']},
  {category:'MECHANICS',symbol:'P',text:'Where is the reading room.',quote:'Where is the reading room.',allowedSuggestions:['Where is the reading room?']},
  {category:'MECHANICS',symbol:'SPC',text:'We readbooks during lunch.',quote:'readbooks',allowedSuggestions:['read books']},
  {category:'VOCABULARY',symbol:'COL',text:'Readers should make attention to unfamiliar words.',quote:'make attention',allowedSuggestions:['pay attention']},
  {category:'CONTENT',symbol:'REL',text:'My favorite sandwich contains cheese.',quote:'My favorite sandwich contains cheese.',allowedSuggestions:['Remove this unrelated sandwich detail.','Replace this unrelated detail with a relevant example about reading.']},
  {category:'ORGANIZATION',symbol:'CONC',text:'One account placed the event in April.',quote:'One account placed the event in April.',allowedSuggestions:['Connect this final example to the claim about the value of a reading room.','Conclude by explaining how this example supports the case for a reading room.']}
];
const negativeControls = ['The librarian keeps a daily record.','Where is the reading room?','We read books during lunch.',
  'Readers should pay attention to unfamiliar words.','Thanks! See you soon.',
  'These opportunities to read and compare ideas make a quiet reading room valuable to students.'];
const conclusionCases = [
  {kind:'missing',ending:'One account placed the event in April.',symbol:'CONC'},
  {kind:'nonconcluding',ending:'In conclusion, the third shelf contains twelve dictionaries.',symbol:'CONC'},
  // Off-topic material is REL; do not double-count the same defect as CONC.
  {kind:'irrelevant',ending:'To conclude, cheese sandwiches are my favorite lunch.',symbol:'REL'},
  {kind:'valid',ending:negativeControls[5],symbol:null}
];
const opening='Schools should provide a quiet reading room so that students can concentrate and compare ideas.';
const mixed={transcript:[opening,...negativeControls.slice(0,4),...defects.map(f=>f.text)].join('\n\n'),
  transcriptHash:'offline-quality-manifest-v1',transcriptComplete:true,
  assignment:{title:'A quiet reading room',instructions:'Explain why schools should provide a quiet reading room and support your position with a concrete example.'}};
module.exports={defects,negativeControls,conclusionCases,opening,mixed};
