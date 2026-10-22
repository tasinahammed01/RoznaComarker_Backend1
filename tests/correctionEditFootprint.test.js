'use strict';
const diff=require('../src/services/correctionEditFootprint.service');
test.each([
 ['she speling now','she spelling now','SP','speling','spelling'],
 ['then we left','then We left','CAP','we','We'],
 ['they depend of maps','they depend on maps','PREP','of','on'],
 ['evidence','on evidence','PREP','','on '],
 ['on evidence','evidence','PREP','on ',''],
 ['We waited','We waited.','RO','','.'],
 ['We waited\nrain arrived','We waited.\nRain arrived','RO','\nrain','.\nRain']
])('deterministic %s -> %s', (a,b,code,source,replacement)=>{const r=diff.derive(a,b,10,code);expect(r.valid).toBe(true);expect(r.operativeEditSpan).toMatchObject({source,replacement});const e=r.operativeEditSpan;expect(a.slice(0,e.start-10)+e.replacement+a.slice(e.end-10)).toBe(b);});
test.each([
 ['teh cat has speling','the cat has spelling','SP'],
 ['we waited and they left','they left and we waited','T'],
 ['the small bird flew','several aircraft departed','WC'],
 ['at at school','at school','PREP']
])('complex/reordered/ambiguous %s stays withheld',(a,b,code)=>{const r=diff.derive(a,b,0,code);expect(r.valid).toBe(false);expect(r.reason).toBe('COMPLEX_OR_MULTI_EDIT');expect(r.operativeEditSpan).toBeNull();});
test('no-op remains diagnostic',()=>expect(diff.derive('same','same').reason).toBe('NO_OP_CORRECTION'));
test('SP case-only is not spelling',()=>expect(diff.validateShape(diff.derive('rain','Rain',0,'SP'),'SP','rain').reasons).toContain('CASE_CHANGE_REQUIRES_CAP'));
test('CAP word substitution fails',()=>expect(diff.validateShape(diff.derive('rain','snow',0,'CAP'),'CAP','rain').reasons).toContain('CAP_NOT_CASE_ONLY'));
test('RO case-only fails',()=>expect(diff.validateShape(diff.derive('we','We',0,'RO'),'RO','we').reasons).toContain('RO_MATERIAL_BOUNDARY_CHANGE_REQUIRED'));
test('punctuation insertion leaving lowercase fails complete RO',()=>{const r=diff.derive('we left they stayed','we left. they stayed',0,'RO');expect(diff.validateShape(r,'RO','we left they stayed').reasons).toContain('RO_COMPLETE_CAPITALIZATION_REQUIRED');});
test('PREP shape is not arbitrary word substitution',()=>{const r=diff.derive('blue sky','green sky',0,'PREP');expect(diff.validateShape(r,'PREP','blue sky').reasons).toContain('PREPOSITION_TOKEN_EDIT_REQUIRED');});
test('token transposition spelling remains complete word',()=>{const r=diff.derive('a preception test','a perception test',0,'SP');expect(r.operativeEditSpan).toEqual({start:2,end:12,source:'preception',replacement:'perception'});});
test('bounded input required',()=>expect(diff.derive('x'.repeat(501),'x').reason).toBe('BOUNDED_EXACT_EDIT_REQUIRED'));

test.each([['depend evidence','depend on evidence'],['depend on evidence','depend evidence']])('ambiguous whitespace insertion/deletion %s stays review-only',(a,b)=>{expect(diff.derive(a,b,0,'PREP').reason).toBe('COMPLEX_OR_MULTI_EDIT');});
