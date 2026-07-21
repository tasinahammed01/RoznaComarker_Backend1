'use strict';

const groups = [
  ['CONTENT','Content (Ideas & Relevance)','#FFD6A5',[['REL','Relevance'],['DEV','Idea Development'],['TA','Task Achievement'],['CL','Clarity of Ideas'],['SD','Supporting Details']]],
  ['ORGANIZATION','Organization (Structure & Flow)','#CDE7F0',[['COH','Coherence'],['CO','Cohesion'],['PU','Paragraph Unity'],['TS','Topic Sentence'],['CONC','Conclusion']]],
  ['GRAMMAR','Grammar (Sentence & Structure)','#B7E4C7',[['T','Tense'],['VF','Verb Form'],['AGR','Subject–Verb Agreement'],['FRAG','Sentence Fragment'],['RO','Run-on Sentence'],['WO','Word Order'],['ART','Article Use'],['PREP','Preposition']]],
  ['VOCABULARY','Vocabulary (Word Use & Form)','#E4C1F9',[['WC','Word Choice'],['WF','Word Form'],['REP','Repetition'],['FORM','Formal / Inappropriate Word'],['COL','Collocation']]],
  ['MECHANICS','Mechanics (Spelling & Punctuation)','#FFF3BF',[['SP','Spelling'],['P','Punctuation'],['CAP','Capitalization'],['SPC','Spacing'],['FMT','Formatting']]],
];
function getOfficialCorrectionLegend(){return{version:'1.0',description:'Academic correction legend for AI-assisted writing feedback',groups:groups.map(([key,label,color,symbols])=>({key,label,color,symbols:symbols.map(([symbol,itemLabel])=>({symbol,label:itemLabel,description:''}))}))};}
module.exports={getOfficialCorrectionLegend};
