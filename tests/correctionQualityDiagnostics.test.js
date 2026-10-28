'use strict';
const qa=require('../src/services/correctionQualityDiagnostics.service');
const semantic=require('../src/services/semanticWritingCorrections.service');
const canonical=require('../src/services/correctionCanonical.service');
const {defaultLegend}=require('../src/services/writingCorrections.service');
const {finding}=require('./helpers/astraAssessmentFixtures.cjs');
const fixture=require('./helpers/claudeQualityFixtures.cjs');
const legend=semantic.compactSemanticLegend(defaultLegend()),catalog=semantic.categorySymbolCatalog(legend);
const validate=(transcript,records)=>semantic.validateCorrections(records,{transcript,legend,transcriptComplete:true});
const measure=(transcript,rawCorrections,acceptedCorrections=[],extra={})=>qa.measureGrounding({transcript,rawCorrections,acceptedCorrections,catalog,...extra});
test('unique literal fallback explains strict raw versus accepted counts without text normalization',()=>{
 const transcript='mispell',raw=[finding('MECHANICS','SP',transcript,{occurrence:9,suggestedText:'misspell'})];
 const accepted=validate(transcript,raw).corrections,r=measure(transcript,raw,accepted);
 expect(r).toMatchObject({rawStrictOccurrenceMatchCount:0,rawProductionLocatedCount:1,rawUniqueQuoteFallbackCount:1,acceptedExactSpanMatchCount:1});
 expect(canonical.locateQuote(transcript,'Mispell',0)).toBeNull();
});
test('repeated literal requires a valid occurrence, while absent literal is distinct',()=>{
 const raw=[finding('MECHANICS','SP','mispell',{occurrence:2}),finding('CONTENT','REL','absent quote')];
 const r=measure('mispell mispell',raw);
 expect(r.rawOccurrenceNotFoundCount).toBe(1);expect(r.rawLiteralQuoteAbsentCount).toBe(1);expect(r.rawProductionLocatedCount).toBe(0);
});
test.each([['paraphrased content'],['exact\nphrase'],['Exact phrase']])('QUOTE_NOT_FOUND does not distinguish the absent literal subtype',quote=>{
 const raw=[finding('MECHANICS','SP','mispell',{suggestedText:'misspell'}),finding('CONTENT','REL',quote)];
 const r=validate('mispell exact phrase',raw);
 expect(r.diagnostics.rejectionReasonsBySymbol.REL).toEqual({QUOTE_NOT_FOUND:1});
});
test('occurrence mismatch for repeated text is OCCURRENCE_NOT_FOUND, not QUOTE_NOT_FOUND',()=>{
 const raw=[finding('MECHANICS','SP','mispell',{suggestedText:'misspell'}),finding('CONTENT','REL','word',{occurrence:5})];
 expect(validate('mispell word word',raw).diagnostics.rejectionReasonsBySymbol.REL).toEqual({OCCURRENCE_NOT_FOUND:1});
});
test('unlocated equal-length quotes cannot create duplicate or overlap pairs',()=>{
 const raw=[finding('CONTENT','REL','absent'),finding('CONTENT','DEV','unseen')];
 expect(measure('A source.',raw)).toMatchObject({rawProductionCoincidentSpanPairCount:0,rawProductionGeometricOverlapPairCount:0});
});
test('coincident and overlapping independent findings are not automatically bogus duplicates',()=>{
 const transcript='word phrase',a={...finding('GRAMMAR','AGR',transcript),startChar:0,endChar:11};
 const b={...finding('GRAMMAR','ART',transcript,{suggestedText:'a revised phrase'}),startChar:0,endChar:11};
 const r=measure(transcript,[],[a,b]);
 expect(r.acceptedCoincidentSpanPairCount).toBe(1);expect(r.acceptedGeometricOverlapPairCount).toBe(1);expect(r.acceptedCanonicalDuplicateRemovalCount).toBe(0);
 expect(measure(transcript,[],[a,a]).acceptedCanonicalDuplicateRemovalCount).toBe(1);
});
test('repeated phrases and distinct file/page identities cannot alias duplicate locations',()=>{
 const transcript='word word',a={...finding('CONTENT','REL','word'),startChar:0,endChar:4,fileId:'pdf',page:1};
 const b={...a,startChar:5,endChar:9,page:2};
 expect(measure(transcript,[],[a,b]).acceptedCanonicalDuplicateRemovalCount).toBe(0);
 expect(measure('word',[],[a,{...a,page:2}]).acceptedCoincidentSpanPairCount).toBe(0);
});
test('wrong parent category is a canonical remap, not an invented symbol',()=>{
 const raw=[finding('VOCABULARY','SP','mispell',{suggestedText:'misspell'})];
 const accepted=validate('mispell',raw).corrections,r=measure('mispell',raw,accepted);
 expect(accepted[0].category).toBe('MECHANICS');
 expect(r).toMatchObject({rawCategorySymbolMismatchCount:1,rawUnknownSymbolCount:0,rawUnknownCategoryCount:0});
});
test('controls and expected targets use unique frozen regions; broad overlap is not exact targeting',()=>{
 const f=fixture.defects[0],control=fixture.negativeControls.filter(s=>fixture.mixed.transcript.includes(s))[0];
 const raw=[finding('GRAMMAR','AGR',control,{occurrence:9,suggestedText:'A synthetic replacement.'})];
 const accepted=validate(fixture.mixed.transcript,raw).corrections;
 const r=measure(fixture.mixed.transcript,raw,accepted,{defects:[f],negativeControls:[control]});
 expect(r).toMatchObject({rawStrictNegativeControlIntersectionCount:0,rawProductionNegativeControlIntersectionCount:1,acceptedNegativeControlIntersectionCount:1});
 expect(r.expectedSymbols[0].stage).toBe('SYMBOL_ACCEPTED_WRONG_DEFECT');
 const broad={...finding('GRAMMAR','AGR',fixture.mixed.transcript),startChar:0,endChar:fixture.mixed.transcript.length};
 const overlap=measure(fixture.mixed.transcript,[],[broad],{defects:[f]}).expectedSymbols[0];
 expect(overlap.expectedDefectOverlapCount).toBe(1);expect(overlap.expectedDefectContainedCount).toBe(0);
});
test('frozen accepted findings preserve targeting and finite suggestions; COL omission stays omission',()=>{
 const raw=fixture.defects.filter(f=>f.symbol!=='COL').map(f=>finding(f.category,f.symbol,f.quote,{suggestedText:f.allowedSuggestions[0]}));
 const r=measure(fixture.mixed.transcript,raw,validate(fixture.mixed.transcript,raw).corrections,{defects:fixture.defects,negativeControls:fixture.negativeControls.slice(0,4)});
 expect(r.expectedSymbols.find(f=>f.symbol==='COL')).toMatchObject({stage:'SYMBOL_NOT_RETURNED',presentBeforeValidation:false,acceptedAfterValidation:false});
 for(const f of r.expectedSymbols.filter(f=>f.symbol!=='COL'))expect(f).toMatchObject({expectedDefectContainedCount:1,suggestionMatch:'MATCH'});
 expect(r.acceptedNegativeControlIntersectionCount).toBe(0);
 const encoded=JSON.stringify(r);expect(encoded).not.toContain(fixture.defects[0].quote);expect(encoded).not.toContain('quotedText');
});
