'use strict';
// User-supplied audit evidence only. Not a runtime source-authority attestation.
const text=`How do social and cultural expectations
shape Louise Marllard's choices, feelings and
sence of self?

Social and cultural expectations shape
Louise Mallard because in her social and cultural
context, marrid wemen, such as her self, are expected
to be divote their lifes to there houses, husbands,
and family in a way that make Them forget how
to live a little, and to take care of them selves
insted of others, wich is a neccity for humens.
This self-nigleacting way of living will eventually
shift The Judiment of any human begin, as
what happen to MRS, Mallard in the story, when
she recived the news of her husband's alliged
death. She greever, yes, but after a while she
`;
module.exports={id:'golden-002',status:'HUMAN_GOLD',humanReviewed:true,productionAuthority:false,
  inputSha256:'50937ea5e0215a544ef32931b30f76f38208630b555aeeb68ae903e647e5c72b',
  submissionId:'6ad7bfaa7ee2b01125accf51',ocrJobId:'6ad7bfaa7ee2b01125accf50',pageNumber:1,text,
  representation:'Supplied full-page baseline including question; blank line after question retained. One terminal newline represents the supplied text block; no role adjudication or dictionary cleanup.',
  reviewedSpans:['marrid','self-nigleacting','be'].map(quote=>{
    const start=quote==='be'?text.indexOf('to be divote')+3:text.indexOf(quote);
    return {quote,start,end:start+quote.length,classification:'ACTIVE_STUDENT_TEXT',status:'HUMAN_CONFIRMED'};
  }),pendingSpans:[]};
